import { createHash } from 'node:crypto';

/**
 * Compute SHA-256 of a string, truncated to 16 hex characters (64 bits).
 * @param {string} str Raw string to hash
 * @returns {string} 16-char hex digest
 */
export function hashLine(str) {
    return createHash('sha256').update(str, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Compute a hash over an array of lines (joined with newline).
 * @param {string[]} lines
 * @returns {string} 16-char hex digest of the full content
 */
export function hashLines(lines) {
    return hashLine(lines.join('\n'));
}
