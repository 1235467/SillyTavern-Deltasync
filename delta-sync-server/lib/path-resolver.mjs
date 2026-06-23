import path from 'node:path';

// Mirrors sanitize-filename behaviour: strip control chars, reserved chars, Windows reserved names
const ILLEGAL_RE = /[/?<>\\:*|"]/g;
const CONTROL_RE = /[\x00-\x1f\x80-\x9f]/g;
const RESERVED_RE = /^\.+$/;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const TRAILING_RE = /[. ]+$/;

/**
 * Sanitize a single filename component (no path separators allowed).
 * @param {string} name
 * @returns {string}
 */
function sanitizeComponent(name) {
    const sanitized = name
        .replace(ILLEGAL_RE, '')
        .replace(CONTROL_RE, '')
        .replace(RESERVED_RE, '')
        .replace(WINDOWS_RESERVED_RE, '')
        .replace(TRAILING_RE, '');
    return sanitized.slice(0, 255);
}

/**
 * Resolve a chatFile path like "character_name/chatname.jsonl" to an absolute
 * filesystem path, with traversal protection.
 *
 * @param {string} chatFile  Relative chat path from the request
 * @param {boolean} isGroupChat  Whether this is a group chat
 * @param {{ chats: string, groupChats: string }} directories  User directories from req.user
 * @returns {{ filePath: string, error: string|null }}
 */
export function resolveChatPath(chatFile, isGroupChat, directories) {
    if (!chatFile || typeof chatFile !== 'string') {
        return { filePath: '', error: 'chatFile is required' };
    }

    const baseDir = isGroupChat ? directories.groupChats : directories.chats;

    // Split into components, sanitize each one
    const parts = chatFile.split(/[/\\]/).filter(Boolean);
    if (parts.length === 0) {
        return { filePath: '', error: 'chatFile path is empty after sanitization' };
    }

    const sanitizedParts = parts.map(sanitizeComponent).filter(Boolean);
    if (sanitizedParts.length === 0 || sanitizedParts.length !== parts.length) {
        return { filePath: '', error: 'chatFile contains invalid path components' };
    }

    const resolved = path.resolve(baseDir, ...sanitizedParts);

    // Ensure the resolved path is under the base directory
    const normalizedBase = path.normalize(baseDir);
    const normalizedResolved = path.normalize(resolved);
    const relative = path.relative(normalizedBase, normalizedResolved);

    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        return { filePath: '', error: 'Path traversal detected' };
    }

    return { filePath: resolved, error: null };
}
