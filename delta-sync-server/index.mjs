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
 * Write lines back to a JSONL file atomically.
 * @param {string} filePath
 * @param {string[]} lines
 */
function writeChatLines(filePath, lines) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
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

            return res.json({
                ok: true,
                lines: lines.length,
                hashes,
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
            const { chatFile, isGroupChat, integrity, ops, expectedHash } = req.body;
            const { filePath, error } = resolveChatPath(chatFile, !!isGroupChat, req.user.directories);
            if (error) {
                return res.status(400).json({ ok: false, error });
            }

            const lines = readChatLines(filePath);
            if (lines === null) {
                return res.status(404).json({ ok: false, error: 'Chat file not found' });
            }

            // Integrity check: compare provided integrity against file's header
            const fileIntegrity = getIntegrity(lines[0]);
            if (fileIntegrity && integrity !== fileIntegrity) {
                return res.status(409).json({
                    ok: false,
                    error: 'Integrity mismatch — file has been modified',
                    expected: integrity,
                    actual: fileIntegrity,
                });
            }

            // Validate ops
            const validation = validateOps(ops, lines.length);
            if (validation.error) {
                return res.status(400).json({ ok: false, error: validation.error });
            }

            // Apply ops to a copy of lines
            const result = applyOps([...lines], ops);

            // Verify expected hash
            const actualHash = hashLines(result);
            if (expectedHash && expectedHash !== actualHash) {
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
            const { chatFile, isGroupChat, content, chat, force } = req.body;
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

            // Integrity check (unless force=true)
            if (!force) {
                const existingLines = readChatLines(filePath);
                if (existingLines !== null && existingLines.length > 0) {
                    const existingIntegrity = getIntegrity(existingLines[0]);
                    if (existingIntegrity) {
                        // Extract integrity from the incoming data's first line
                        const firstLine = data.split('\n')[0];
                        const incomingIntegrity = getIntegrity(firstLine);
                        if (incomingIntegrity && existingIntegrity !== incomingIntegrity) {
                            return res.status(409).json({
                                ok: false,
                                error: 'Integrity mismatch — file has been modified externally',
                                expected: incomingIntegrity,
                                actual: existingIntegrity,
                            });
                        }
                    }
                }
            }

            // Write file
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(filePath, data, 'utf8');

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

    console.log('[delta-sync] Plugin initialized — routes: /state, /sync, /full-save');
}
