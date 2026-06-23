import fs from 'node:fs';
import path from 'node:path';

const THROTTLE_MS = 10_000;
const MAX_BACKUPS = 50;
const BACKUP_PREFIX = 'chat_';

/**
 * Generate a timestamp string matching ST's format: YYYYMMDD-HHmmss
 * @returns {string}
 */
function timestamp() {
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${y}${mo}${d}-${h}${mi}${s}`;
}

/**
 * Remove old backup files beyond limit.
 * @param {string} directory
 * @param {string} prefix
 * @param {number} max
 */
function removeOldBackups(directory, prefix, max = MAX_BACKUPS) {
    let files = fs.readdirSync(directory).filter(f => f.startsWith(prefix));
    if (files.length > max) {
        files = files.map(f => path.join(directory, f));
        files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
        while (files.length > max) {
            const oldest = files.shift();
            if (oldest) fs.unlinkSync(oldest);
        }
    }
}

/**
 * Perform the actual backup write.
 * @param {string} backupDir
 * @param {string} chatName
 * @param {string} data  Serialized JSONL content
 */
function writeBackup(backupDir, chatName, data) {
    if (!fs.existsSync(backupDir)) return;

    // Sanitize name: replace non-alphanumeric with underscores, lowercase
    const safeName = chatName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const fileName = `${BACKUP_PREFIX}${safeName}_${timestamp()}.jsonl`;
    const filePath = path.join(backupDir, fileName);

    fs.writeFileSync(filePath, data, 'utf8');
    removeOldBackups(backupDir, `${BACKUP_PREFIX}${safeName}_`);
}

/** @type {Map<string, number>} Last backup time keyed by handle:chatName */
const lastBackupTime = new Map();

/**
 * Throttled backup: at most once per THROTTLE_MS per (handle, chat) pair.
 * Keying per-chat is important — a per-handle key meant that chatting with
 * two characters within the throttle window dropped one's backups entirely.
 *
 * @param {string} handle  User handle
 * @param {string} backupDir  User's backup directory
 * @param {string} chatName  Chat identifier for the backup filename
 * @param {string} data  Serialized JSONL content
 */
export function throttledBackup(handle, backupDir, chatName, data) {
    const now = Date.now();
    const key = `${handle}:${chatName}`;
    const last = lastBackupTime.get(key) || 0;
    if (now - last < THROTTLE_MS) return;

    lastBackupTime.set(key, now);
    try {
        writeBackup(backupDir, chatName, data);
    } catch (err) {
        console.error(`[delta-sync] Backup failed for ${chatName}:`, err);
    }
}
