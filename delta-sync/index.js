import { getContext } from '../../../extensions.js';

const PLUGIN_BASE = '/api/plugins/delta-sync';
/**
 * SHA-256 truncated to 16 hex chars. Matches server-side hash.mjs.
 * @param {string} str
 * @returns {Promise<string>}
 */
async function hashLine(str) {
    const data = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest('SHA-256', data);
    const hex = Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 16);
}

/**
 * Hash an array of lines joined with newline.
 * @param {string[]} lines
 * @returns {Promise<string>}
 */
async function hashLines(lines) {
    return hashLine(lines.join('\n'));
}

/**
 * Per-file state cache: last known hashes and lines.
 * @type {Map<string, { hashes: string[], integrity: string|null }>}
 */
const stateCache = new Map();

/**
 * Check if the delta-sync server plugin is available.
 * @returns {Promise<boolean>}
 */
async function isPluginAvailable() {
    try {
        const resp = await originalFetch(`${PLUGIN_BASE}/ping`, {
            method: 'GET',
            headers: { ...getAuthHeaders() },
        });
        if (!resp.ok) return false;
        const data = await resp.json().catch(() => null);
        return data?.ok === true && data?.plugin === 'delta-sync';
    } catch {
        return false;
    }
}

/**
 * Get auth headers from ST context.
 * @returns {Record<string, string>}
 */
function getAuthHeaders() {
    try {
        return getContext().getRequestHeaders();
    } catch {
        return { 'Content-Type': 'application/json' };
    }
}

/**
 * Fetch the server's current state for a chat file.
 * @param {string} chatFile
 * @param {boolean} isGroupChat
 * @returns {Promise<{ok: boolean, hashes?: string[], integrity?: string|null, lines?: number}|null>}
 */
async function fetchState(chatFile, isGroupChat) {
    try {
        const resp = await originalFetch(`${PLUGIN_BASE}/state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ chatFile, isGroupChat }),
        });
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

/**
 * LCS between two hash arrays. Returns the ops list (insert + delete only)
 * with indices in the original (delete) / final (insert) coordinate systems.
 * Assumes inputs are pre-trimmed of common prefix/suffix; the `offset` is added
 * back to every emitted index.
 *
 * Memory: Uint16Array of (m+1)*(n+1). Callers must enforce the size cap.
 * @param {string[]} oldMid
 * @param {string[]} newMidHashes
 * @param {string[]} newMidLines
 * @param {number} offset  Number of common-prefix lines stripped from the front
 * @returns {Array<{type: string, index: number, content?: string}>}
 */
function lcsDiff(oldMid, newMidHashes, newMidLines, offset) {
    const m = oldMid.length;
    const n = newMidHashes.length;
    if (m === 0 && n === 0) return [];
    if (m === 0) {
        // Pure insertion
        const ops = [];
        for (let j = 0; j < n; j++) {
            ops.push({ type: 'insert', index: offset + j, content: newMidLines[j] });
        }
        return ops;
    }
    if (n === 0) {
        // Pure deletion
        const ops = [];
        for (let i = 0; i < m; i++) {
            ops.push({ type: 'delete', index: offset + i });
        }
        return ops;
    }

    const w = n + 1;
    const dp = new Uint16Array((m + 1) * w);
    for (let i = 1; i <= m; i++) {
        const rowBase = i * w;
        const prevBase = (i - 1) * w;
        const oh = oldMid[i - 1];
        for (let j = 1; j <= n; j++) {
            if (oh === newMidHashes[j - 1]) {
                dp[rowBase + j] = dp[prevBase + (j - 1)] + 1;
            } else {
                const up = dp[prevBase + j];
                const left = dp[rowBase + (j - 1)];
                dp[rowBase + j] = up >= left ? up : left;
            }
        }
    }

    const ops = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldMid[i - 1] === newMidHashes[j - 1]) {
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i * w + (j - 1)] >= dp[(i - 1) * w + j])) {
            ops.push({ type: 'insert', index: offset + j - 1, content: newMidLines[j - 1] });
            j--;
        } else {
            ops.push({ type: 'delete', index: offset + i - 1 });
            i--;
        }
    }
    return ops;
}

const MAX_DIFF_LINES = 3000;

/**
 * Compute diff operations between old hashes and new lines.
 * Strips common prefix/suffix first so typical edits (append, single-block
 * change) reduce to a tiny LCS. Returns null if the residual middle exceeds
 * MAX_DIFF_LINES on either side — caller should fall back to a full save.
 *
 * @param {string[]} oldHashes Server's per-line hashes
 * @param {string[]} newLines Client's new lines
 * @returns {Promise<{ops: Array<{type: string, index: number, content?: string}>, expectedHash: string}|null>}
 */
async function computeDiff(oldHashes, newLines) {
    const newHashes = await Promise.all(newLines.map(l => hashLine(l)));
    const expectedHash = await hashLines(newLines);

    const m0 = oldHashes.length;
    const n0 = newHashes.length;

    // Trim common prefix
    let prefix = 0;
    const prefixMax = Math.min(m0, n0);
    while (prefix < prefixMax && oldHashes[prefix] === newHashes[prefix]) {
        prefix++;
    }

    // Trim common suffix (without overlapping the prefix on either side)
    let suffix = 0;
    const suffixMax = Math.min(m0 - prefix, n0 - prefix);
    while (
        suffix < suffixMax &&
        oldHashes[m0 - 1 - suffix] === newHashes[n0 - 1 - suffix]
    ) {
        suffix++;
    }

    const midOldLen = m0 - prefix - suffix;
    const midNewLen = n0 - prefix - suffix;

    if (midOldLen === 0 && midNewLen === 0) {
        return { ops: [], expectedHash };
    }

    if (midOldLen > MAX_DIFF_LINES || midNewLen > MAX_DIFF_LINES) {
        return null;
    }

    const oldMid = oldHashes.slice(prefix, m0 - suffix);
    const newMidHashes = newHashes.slice(prefix, n0 - suffix);
    const newMidLines = newLines.slice(prefix, n0 - suffix);

    const ops = lcsDiff(oldMid, newMidHashes, newMidLines, prefix);
    return { ops, expectedHash };
}

/**
 * Attempt a delta sync for a chat save.
 * @param {string} chatFile  Relative chat file path
 * @param {boolean} isGroupChat
 * @param {string[]} newLines  The new JSONL lines being saved
 * @param {boolean} force  Force overwrite (skip integrity)
 * @returns {Promise<Response|null>}  A fake ok Response if delta succeeded, or null to fall back.
 */
async function tryDeltaSync(chatFile, isGroupChat, newLines, force) {
    try {
        // Force overwrite skips the integrity check entirely. /sync has no force
        // semantics (it always compares integrity), so route force saves to /full-save.
        if (force) {
            return await tryFullSave(chatFile, isGroupChat, newLines, true);
        }

        // Get cached or fresh server state
        const cacheKey = `${isGroupChat ? 'g:' : 'c:'}${chatFile}`;
        let state = stateCache.get(cacheKey);

        if (!state) {
            const fetched = await fetchState(chatFile, isGroupChat);
            if (!fetched || !fetched.ok) return null;
            state = { hashes: fetched.hashes, integrity: fetched.integrity };
            stateCache.set(cacheKey, state);
        }

        // Compute diff. null means "too large to diff cheaply" — full-save instead.
        const diff = await computeDiff(state.hashes, newLines);
        if (diff === null) {
            console.debug('[delta-sync] Diff window too large, using full-save');
            return await tryFullSave(chatFile, isGroupChat, newLines, false);
        }

        if (diff.ops.length === 0) {
            // No changes — return success without hitting the server
            console.debug('[delta-sync] No changes detected, skipping save');
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // If diff is larger than 70% of the file, full-save is probably cheaper
        const totalLines = newLines.length;
        if (diff.ops.length > totalLines * 0.7) {
            console.debug(`[delta-sync] Diff too large (${diff.ops.length}/${totalLines}), using full-save`);
            return await tryFullSave(chatFile, isGroupChat, newLines, false);
        }

        // Send sync request
        const syncResp = await originalFetch(`${PLUGIN_BASE}/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({
                chatFile,
                isGroupChat,
                integrity: state.integrity,
                ops: diff.ops,
                expectedHash: diff.expectedHash,
            }),
        });

        if (syncResp.ok) {
            // Update cache with new state
            const newHashes = await Promise.all(newLines.map(l => hashLine(l)));
            const newIntegrity = getIntegrityFromLine(newLines[0]);
            stateCache.set(cacheKey, { hashes: newHashes, integrity: newIntegrity });

            console.debug(`[delta-sync] Synced ${diff.ops.length} ops for ${chatFile}`);
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 409 = integrity or hash mismatch — invalidate cache and fall back
        if (syncResp.status === 409) {
            console.warn('[delta-sync] Conflict on sync, invalidating cache');
            stateCache.delete(cacheKey);
            return null;
        }

        console.warn('[delta-sync] Sync failed with status', syncResp.status);
        return null;
    } catch (err) {
        console.error('[delta-sync] Error during delta sync:', err);
        return null;
    }
}

/**
 * Full save via plugin endpoint (bypasses gzip compression overhead of the normal path).
 * @param {string} chatFile
 * @param {boolean} isGroupChat
 * @param {string[]} newLines
 * @param {boolean} force
 * @returns {Promise<Response|null>}
 */
async function tryFullSave(chatFile, isGroupChat, newLines, force) {
    try {
        const resp = await originalFetch(`${PLUGIN_BASE}/full-save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({
                chatFile,
                isGroupChat,
                content: newLines.join('\n'),
                force: !!force,
            }),
        });

        if (resp.ok) {
            const cacheKey = `${isGroupChat ? 'g:' : 'c:'}${chatFile}`;
            const newHashes = await Promise.all(newLines.map(l => hashLine(l)));
            const newIntegrity = getIntegrityFromLine(newLines[0]);
            stateCache.set(cacheKey, { hashes: newHashes, integrity: newIntegrity });
            console.debug(`[delta-sync] Full-save for ${chatFile}`);
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Extract integrity UUID from a header line JSON string.
 * @param {string} line
 * @returns {string|null}
 */
function getIntegrityFromLine(line) {
    try {
        const parsed = JSON.parse(line);
        return parsed?.chat_metadata?.integrity || null;
    } catch {
        return null;
    }
}

// ---- Fetch interception ----

/** @type {typeof window.fetch} */
const originalFetch = window.fetch.bind(window);

let pluginAvailable = null;

/**
 * Decompress a gzipped body to a string.
 * @param {Uint8Array|ArrayBuffer} compressed
 * @returns {Promise<string>}
 */
async function decompressGzip(compressed) {
    const ds = new DecompressionStream('gzip');
    const input = compressed instanceof ArrayBuffer ? new Uint8Array(compressed) : compressed;
    const writer = ds.writable.getWriter();
    writer.write(input);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    return new TextDecoder().decode(merged);
}

/**
 * Check if request headers indicate gzip Content-Encoding.
 * @param {HeadersInit} headers
 * @returns {boolean}
 */
function isGzipEncoded(headers) {
    if (headers instanceof Headers) {
        return headers.get('Content-Encoding') === 'gzip';
    }
    if (typeof headers === 'object' && headers !== null) {
        for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() === 'content-encoding' && value === 'gzip') return true;
        }
    }
    return false;
}

/**
 * Parse a save request body to extract chat lines and metadata.
 * Handles both plain JSON and gzip-compressed bodies.
 * @param {Request|string} input  Fetch input (URL or Request)
 * @param {RequestInit} [init]  Fetch init options
 * @returns {Promise<{ url: string, chatFile: string, isGroupChat: boolean, lines: string[], force: boolean } | null>}
 */
async function parseSaveRequest(input, init) {
    const url = typeof input === 'string'
        ? input
        : (input instanceof URL ? input.href : input?.url);
    if (!url) return null;

    // Only intercept chat save endpoints
    const isCharSave = url.endsWith('/api/chats/save');
    const isGroupSave = url.endsWith('/api/chats/group/save');
    if (!isCharSave && !isGroupSave) return null;

    try {
        let bodyStr;
        let isGzip;

        if (input instanceof Request) {
            // ST currently never calls fetch with a Request, but guard anyway:
            // a Request's body is a ReadableStream — clone before reading so the
            // original can still be used in fallback.
            const clone = input.clone();
            isGzip = clone.headers.get('Content-Encoding') === 'gzip';
            if (isGzip) {
                bodyStr = await decompressGzip(await clone.arrayBuffer());
            } else {
                bodyStr = await clone.text();
            }
        } else {
            const opts = init || {};
            const rawBody = opts.body;
            isGzip = isGzipEncoded(opts.headers);
            if (typeof rawBody === 'string') {
                bodyStr = rawBody;
            } else if ((rawBody instanceof Uint8Array || rawBody instanceof ArrayBuffer) && isGzip) {
                bodyStr = await decompressGzip(rawBody);
            } else {
                return null;
            }
        }

        const body = JSON.parse(bodyStr);
        const chatArray = body.chat;
        if (!Array.isArray(chatArray)) return null;

        const lines = chatArray.map(item => JSON.stringify(item));

        let chatFile;
        if (isCharSave) {
            const avatarDir = String(body.avatar_url || '').replace('.png', '');
            const fileName = String(body.file_name || '');
            chatFile = `${avatarDir}/${fileName}.jsonl`;
        } else {
            chatFile = `${body.id}.jsonl`;
        }

        return {
            url,
            chatFile,
            isGroupChat: isGroupSave,
            lines,
            force: !!body.force,
        };
    } catch {
        return null;
    }
}

/**
 * Wrapped fetch that intercepts chat saves.
 * @param  {Parameters<typeof window.fetch>} args
 * @returns {Promise<Response>}
 */
async function interceptedFetch(...args) {
    const [input, init] = args;

    // Only intercept if plugin is available
    if (pluginAvailable !== true) {
        return originalFetch(input, init);
    }

    const parsed = await parseSaveRequest(input, init);
    if (!parsed) {
        return originalFetch(input, init);
    }

    // Try delta sync
    const deltaResult = await tryDeltaSync(parsed.chatFile, parsed.isGroupChat, parsed.lines, parsed.force);
    if (deltaResult) {
        return deltaResult;
    }

    // Fall back to original save
    console.debug('[delta-sync] Falling back to original save');
    return originalFetch(input, init);
}

// ---- Extension lifecycle ----

export async function init() {
    // Check if server plugin is loaded
    pluginAvailable = await isPluginAvailable();

    if (!pluginAvailable) {
        console.warn('[delta-sync] Server plugin not available. Extension inactive.');
        return;
    }

    // Install fetch wrapper
    window.fetch = interceptedFetch;

    // Invalidate cache on chat change
    const ctx = getContext();
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
        stateCache.clear();
    });

    console.log('[delta-sync] Extension initialized — fetch interception active');
}
