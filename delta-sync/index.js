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
 * Per-file state cache. `hashes` is the per-line hash array used by the diff
 * algorithm; `fileHash` is the hash of the whole file (joined with '\n') and
 * is sent as `baseHash` to the server so it can pre-validate that its on-disk
 * state still matches what we computed the diff against.
 * @type {Map<string, { hashes: string[], fileHash: string }>}
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
 * @returns {Promise<{ok: boolean, hashes?: string[], fileHash?: string, integrity?: string|null, lines?: number}|null>}
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
 * Memory: Uint32Array of (m+1)*(n+1). Uint16 would silently wrap at 65535;
 * Uint32 costs 4x but is bounded by MAX_DIFF_LINES (~36MB at the cap) and
 * eliminates the overflow class of bugs entirely. Callers must enforce the cap.
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
    const dp = new Uint32Array((m + 1) * w);
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
 * Attempt a delta sync for a chat save. Performs one auto-retry on 409
 * (stale cache) by refetching /state before falling back to /full-save.
 *
 * @param {string} chatFile  Relative chat file path
 * @param {boolean} isGroupChat
 * @param {string[]} newLines  The new JSONL lines being saved
 * @param {boolean} force  Force overwrite (bypass concurrency checks)
 * @returns {Promise<Response|null>}  A fake ok Response on success, null to fall back to the original ST save.
 */
async function tryDeltaSync(chatFile, isGroupChat, newLines, force) {
    try {
        // Force = unconditional overwrite. /sync always validates baseHash, so
        // force has no meaning there — route force saves to /full-save.
        if (force) {
            return await tryFullSave(chatFile, isGroupChat, newLines, true);
        }

        const cacheKey = `${isGroupChat ? 'g:' : 'c:'}${chatFile}`;

        // First attempt with whatever's in cache (may trigger a /state fetch).
        let result = await attemptSyncOnce(cacheKey, chatFile, isGroupChat, newLines);
        if (result.kind === 'ok') return result.response;
        if (result.kind === 'fallback') {
            return await tryFullSave(chatFile, isGroupChat, newLines, false);
        }

        // result.kind === 'conflict' — refetch state and retry once.
        console.warn('[delta-sync] Conflict on sync, refetching state and retrying');
        stateCache.delete(cacheKey);
        result = await attemptSyncOnce(cacheKey, chatFile, isGroupChat, newLines);
        if (result.kind === 'ok') return result.response;
        if (result.kind === 'fallback') {
            return await tryFullSave(chatFile, isGroupChat, newLines, false);
        }

        // Still conflicting after fresh state — give up on delta and do a guarded
        // full-save. Use the just-fetched fileHash as previousHash so we still
        // refuse to clobber concurrent changes.
        console.warn('[delta-sync] Conflict persists after retry, falling back to full-save');
        return await tryFullSave(chatFile, isGroupChat, newLines, false);
    } catch (err) {
        console.error('[delta-sync] Error during delta sync:', err);
        return null;
    }
}

/**
 * One pass at delta-syncing. Returns a discriminated result so the caller can
 * decide whether to retry, full-save, or accept success.
 *
 * @param {string} cacheKey
 * @param {string} chatFile
 * @param {boolean} isGroupChat
 * @param {string[]} newLines
 * @returns {Promise<{kind:'ok', response: Response} | {kind:'conflict'} | {kind:'fallback'}>}
 */
async function attemptSyncOnce(cacheKey, chatFile, isGroupChat, newLines) {
    let state = stateCache.get(cacheKey);
    if (!state) {
        const fetched = await fetchState(chatFile, isGroupChat);
        if (!fetched || !fetched.ok) return { kind: 'fallback' };
        state = { hashes: fetched.hashes, fileHash: fetched.fileHash };
        stateCache.set(cacheKey, state);
    }

    const diff = await computeDiff(state.hashes, newLines);
    if (diff === null) {
        console.debug('[delta-sync] Diff window too large, using full-save');
        return { kind: 'fallback' };
    }

    if (diff.ops.length === 0) {
        console.debug('[delta-sync] No changes detected, skipping save');
        return {
            kind: 'ok',
            response: new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        };
    }

    const totalLines = newLines.length;
    if (diff.ops.length > totalLines * 0.7) {
        console.debug(`[delta-sync] Diff too large (${diff.ops.length}/${totalLines}), using full-save`);
        return { kind: 'fallback' };
    }

    const syncResp = await originalFetch(`${PLUGIN_BASE}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
            chatFile,
            isGroupChat,
            baseHash: state.fileHash,
            ops: diff.ops,
            expectedHash: diff.expectedHash,
        }),
    });

    if (syncResp.ok) {
        const newHashes = await Promise.all(newLines.map(l => hashLine(l)));
        stateCache.set(cacheKey, { hashes: newHashes, fileHash: diff.expectedHash });
        console.debug(`[delta-sync] Synced ${diff.ops.length} ops for ${chatFile}`);
        return {
            kind: 'ok',
            response: new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        };
    }

    if (syncResp.status === 409) {
        return { kind: 'conflict' };
    }

    console.warn('[delta-sync] Sync failed with status', syncResp.status);
    return { kind: 'fallback' };
}

/**
 * Full save via plugin endpoint. When force=false, sends previousHash so the
 * server refuses to clobber concurrent changes; on 409 the cache is dropped
 * and the call returns null (caller falls back to ST's original /save).
 *
 * @param {string} chatFile
 * @param {boolean} isGroupChat
 * @param {string[]} newLines
 * @param {boolean} force
 * @returns {Promise<Response|null>}
 */
async function tryFullSave(chatFile, isGroupChat, newLines, force) {
    try {
        const cacheKey = `${isGroupChat ? 'g:' : 'c:'}${chatFile}`;

        // When not forcing, the server demands previousHash if the file exists.
        // Populate the cache from /state if we don't have it yet, so we never
        // accidentally clobber concurrent writes.
        let cached = stateCache.get(cacheKey);
        if (!force && !cached) {
            const fetched = await fetchState(chatFile, isGroupChat);
            if (fetched?.ok) {
                cached = { hashes: fetched.hashes, fileHash: fetched.fileHash };
                stateCache.set(cacheKey, cached);
            }
            // If /state returned 404, the file genuinely doesn't exist —
            // server will skip previousHash check and accept the write.
        }

        const body = {
            chatFile,
            isGroupChat,
            content: newLines.join('\n'),
            force: !!force,
        };
        if (!force && cached?.fileHash) {
            body.previousHash = cached.fileHash;
        }

        const resp = await originalFetch(`${PLUGIN_BASE}/full-save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify(body),
        });

        if (resp.ok) {
            const newHashes = await Promise.all(newLines.map(l => hashLine(l)));
            const newFileHash = await hashLines(newLines);
            stateCache.set(cacheKey, { hashes: newHashes, fileHash: newFileHash });
            console.debug(`[delta-sync] Full-save for ${chatFile}`);
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (resp.status === 409) {
            // Stale cache: drop it so the next save refetches /state. Returning
            // null lets the caller fall back to ST's native save, which is the
            // safe thing — we explicitly don't want to silently overwrite.
            console.warn('[delta-sync] Full-save conflict, dropping cache');
            stateCache.delete(cacheKey);
        } else {
            console.warn('[delta-sync] Full-save failed with status', resp.status);
        }
        return null;
    } catch (err) {
        console.error('[delta-sync] Error during full-save:', err);
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
 * Per-chat serial queue. Each entry is the tail of a promise chain; new saves
 * `.then()` off it so two saves to the same chat never run concurrently.
 * Without this, ST's streaming generation fires saves faster than the round-
 * trip — the second one diffs against an unchanged cache, sends overlapping
 * ops, and the server 409s on baseHash. The retry path recovers correctness
 * but every overlap costs an extra round-trip and a /state refetch.
 *
 * The chain awaits each task via `.catch(() => {})` so one failure doesn't
 * poison the queue: subsequent saves still run.
 *
 * @type {Map<string, Promise<any>>}
 */
const saveQueues = new Map();

/**
 * Append a save task to the per-key serial queue and return its promise.
 * @template T
 * @param {string} cacheKey
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function enqueueSave(cacheKey, task) {
    const prev = saveQueues.get(cacheKey) || Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    saveQueues.set(cacheKey, next);
    next.finally(() => {
        // Only clean up if no newer task has been appended since.
        if (saveQueues.get(cacheKey) === next) {
            saveQueues.delete(cacheKey);
        }
    });
    return next;
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

    const cacheKey = `${parsed.isGroupChat ? 'g:' : 'c:'}${parsed.chatFile}`;
    return enqueueSave(cacheKey, async () => {
        const deltaResult = await tryDeltaSync(parsed.chatFile, parsed.isGroupChat, parsed.lines, parsed.force);
        if (deltaResult) {
            return deltaResult;
        }
        console.debug('[delta-sync] Falling back to original save');
        return originalFetch(input, init);
    });
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
