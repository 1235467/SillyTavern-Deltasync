import fs from 'node:fs';
import path from 'node:path';

import { hashLine, hashLines } from './lib/hash.mjs';
import { resolveChatPath } from './lib/path-resolver.mjs';
import { validateOps, applyOps } from './lib/ops.mjs';
import { throttledBackup } from './lib/backup.mjs';

export const info = {
    id: 'delta-sync',
    name: 'Delta Sync',
    description: 'Differential chat synchronization for SillyTavern',
};

/**
 * Read a JSONL chat file and return its raw lines.
 * @param {string} filePath
 * @returns {string[]|null} Array of raw line strings, or null if file doesn't exist
 */
function readChatLines(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.length === 0) return [];
    return content.split('\n');
}

/**
 * Atomically write a chat file. Writes to a sibling tmp file, fsyncs it, then
 * renames over the target — on POSIX rename(2) is atomic on the same filesystem,
 * so a crash mid-write can never leave a truncated chat file. The tmp file is
 * unlinked on any error path.
 *
 * @param {string} filePath
 * @param {string} data  Full file body
 */
function writeChatFileAtomic(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    let fd;
    try {
        fd = fs.openSync(tmpPath, 'w');
        fs.writeSync(fd, data, 0, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
        try { fs.unlinkSync(tmpPath); } catch { /* tmp may not exist */ }
        throw err;
    }
}

function writeChatLines(filePath, lines) {
    writeChatFileAtomic(filePath, lines.join('\n'));
}

/**
 * Extract integrity UUID from the header line (first line) of a chat.
 * @param {string} headerLine  Raw first line of the JSONL file
 * @returns {string|undefined}
 */
function getIntegrity(headerLine) {
    try {
        const parsed = JSON.parse(headerLine);
        return parsed?.chat_metadata?.integrity;
    } catch {
        return undefined;
    }
}

/**
 * @param {import('express').Router} router
 */
export async function init(router) {
    // GET /ping — liveness probe used by the client extension to detect that
    // the server plugin is loaded. A bare 404 (route missing) means "not loaded".
    router.get('/ping', (_req, res) => {
        return res.json({ ok: true, plugin: 'delta-sync' });
    });

    // POST /state — return per-line hashes
    router.post('/state', (req, res) => {
        try {
            const { chatFile, isGroupChat } = req.body;
            const { filePath, error } = resolveChatPath(chatFile, !!isGroupChat, req.user.directories);
            if (error) {
                return res.status(400).json({ ok: false, error });
            }

            const lines = readChatLines(filePath);
            if (lines === null) {
                return res.status(404).json({ ok: false, error: 'Chat file not found' });
            }

            const hashes = lines.map(line => hashLine(line));
            const integrity = getIntegrity(lines[0]);
            const fileHash = hashLines(lines);

            return res.json({
                ok: true,
                lines: lines.length,
                hashes,
                fileHash,
                integrity: integrity || null,
            });
        } catch (err) {
            console.error('[delta-sync] /state error:', err);
            return res.status(500).json({ ok: false, error: 'Internal server error' });
        }
    });

    // POST /sync — apply diff operations
    router.post('/sync', (req, res) => {
        try {
            const { chatFile, isGroupChat, baseHash, ops, expectedHash } = req.body;
            const { filePath, error } = resolveChatPath(chatFile, !!isGroupChat, req.user.directories);
            if (error) {
                return res.status(400).json({ ok: false, error });
            }

            // baseHash + expectedHash are MANDATORY. Without them, a stale
            // client could apply a diff to a file that has been modified
            // out-of-band, producing silent corruption. Reject loudly.
            if (typeof baseHash !== 'string' || baseHash.length === 0) {
                return res.status(400).json({ ok: false, error: 'baseHash is required' });
            }
            if (typeof expectedHash !== 'string' || expectedHash.length === 0) {
                return res.status(400).json({ ok: false, error: 'expectedHash is required' });
            }

            const lines = readChatLines(filePath);
            if (lines === null) {
                return res.status(404).json({ ok: false, error: 'Chat file not found' });
            }

            // Validate ops shape before doing anything expensive
            const validation = validateOps(ops, lines.length);
            if (validation.error) {
                return res.status(400).json({ ok: false, error: validation.error });
            }

            // Pre-apply guard: the on-disk file MUST match the base the client
            // computed its diff against. If not, the client's cache is stale —
            // refuse and let it refetch /state.
            const diskHash = hashLines(lines);
            if (diskHash !== baseHash) {
                return res.status(409).json({
                    ok: false,
                    error: 'baseHash mismatch — file changed since client read state',
                    expected: baseHash,
                    actual: diskHash,
                });
            }

            // Apply ops to a copy of lines
            const result = applyOps([...lines], ops);

            // Post-apply guard: result must match what the client expects.
            // If baseHash matched but this fails, ops are malformed or buggy.
            const actualHash = hashLines(result);
            if (expectedHash !== actualHash) {
                return res.status(409).json({
                    ok: false,
                    error: 'Hash mismatch after applying ops — file not modified',
                    expectedHash,
                    actualHash,
                });
            }

            // Write result
            writeChatLines(filePath, result);

            // Backup (throttled)
            const handle = req.user?.profile?.handle || 'default';
            const chatName = path.basename(chatFile, '.jsonl');
            const backupDir = req.user?.directories?.backups;
            if (backupDir) {
                throttledBackup(handle, backupDir, chatName, result.join('\n'));
            }

            return res.json({
                ok: true,
                lines: result.length,
                hash: actualHash,
            });
        } catch (err) {
            console.error('[delta-sync] /sync error:', err);
            return res.status(500).json({ ok: false, error: 'Internal server error' });
        }
    });

    // POST /full-save — fallback full file write
    router.post('/full-save', (req, res) => {
        try {
            const { chatFile, isGroupChat, content, chat, force, previousHash } = req.body;
            const { filePath, error } = resolveChatPath(chatFile, !!isGroupChat, req.user.directories);
            if (error) {
                return res.status(400).json({ ok: false, error });
            }

            let data;
            if (typeof content === 'string') {
                // Pre-serialized JSONL string
                data = content;
            } else if (Array.isArray(chat)) {
                // Array of objects — serialize to JSONL
                data = chat.map(item => JSON.stringify(item)).join('\n');
            } else {
                return res.status(400).json({ ok: false, error: 'Either "content" (string) or "chat" (array) is required' });
            }

            // Concurrency guard (unless force=true): the on-disk file must still
            // match what the client last saw. If the file existed but the client
            // didn't send previousHash, we have no way to verify — reject.
            if (!force) {
                const existingLines = readChatLines(filePath);
                if (existingLines !== null) {
                    if (typeof previousHash !== 'string' || previousHash.length === 0) {
                        return res.status(400).json({
                            ok: false,
                            error: 'previousHash is required for non-force full-save when file exists',
                        });
                    }
                    const diskHash = hashLines(existingLines);
                    if (diskHash !== previousHash) {
                        return res.status(409).json({
                            ok: false,
                            error: 'previousHash mismatch — file changed since client read state',
                            expected: previousHash,
                            actual: diskHash,
                        });
                    }
                }
            }

            writeChatFileAtomic(filePath, data);

            const lines = data.split('\n');
            const hash = hashLines(lines);

            // Backup (throttled)
            const handle = req.user?.profile?.handle || 'default';
            const chatName = path.basename(chatFile, '.jsonl');
            const backupDir = req.user?.directories?.backups;
            if (backupDir) {
                throttledBackup(handle, backupDir, chatName, data);
            }

            return res.json({
                ok: true,
                lines: lines.length,
                hash,
            });
        } catch (err) {
            console.error('[delta-sync] /full-save error:', err);
            return res.status(500).json({ ok: false, error: 'Internal server error' });
        }
    });

    console.log('[delta-sync] Plugin initialized — routes: /ping, /state, /sync, /full-save');
}
