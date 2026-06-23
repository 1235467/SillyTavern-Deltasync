const MAX_OPS = 10_000;
const VALID_TYPES = new Set(['modify', 'delete', 'insert']);

/**
 * Validate an array of diff operations.
 * @param {Array} ops
 * @param {number} lineCount  Current number of lines in the file
 * @returns {{ error: string|null }}
 */
export function validateOps(ops, lineCount) {
    if (!Array.isArray(ops)) {
        return { error: 'ops must be an array' };
    }
    if (ops.length === 0) {
        return { error: 'ops array is empty' };
    }
    if (ops.length > MAX_OPS) {
        return { error: `Too many ops (${ops.length}), maximum is ${MAX_OPS}` };
    }

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (!op || typeof op !== 'object') {
            return { error: `ops[${i}]: not an object` };
        }
        if (!VALID_TYPES.has(op.type)) {
            return { error: `ops[${i}]: invalid type "${op.type}"` };
        }
        if (typeof op.index !== 'number' || !Number.isInteger(op.index) || op.index < 0) {
            return { error: `ops[${i}]: index must be a non-negative integer` };
        }
        if (op.type === 'delete') {
            if (op.index >= lineCount) {
                return { error: `ops[${i}]: delete index ${op.index} out of range (${lineCount} lines)` };
            }
        }
        if (op.type === 'modify') {
            if (op.index >= lineCount) {
                return { error: `ops[${i}]: modify index ${op.index} out of range (${lineCount} lines)` };
            }
            if (typeof op.content !== 'string') {
                return { error: `ops[${i}]: modify op requires content string` };
            }
        }
        if (op.type === 'insert') {
            // Insert index can be 0..lineCount (after all deletes are processed,
            // but we do a loose check here; exact bounds depend on phase order)
            if (typeof op.content !== 'string') {
                return { error: `ops[${i}]: insert op requires content string` };
            }
        }
    }

    return { error: null };
}

/**
 * Apply diff operations to an array of lines.
 *
 * Index conventions:
 *   - delete.index: position in the ORIGINAL (pre-apply) array
 *   - modify.index: position in the ORIGINAL array (must survive the delete pass)
 *   - insert.index: position in the FINAL (post-apply) array
 *
 * Phase order:
 *   1. deletes high→low (so earlier deletes don't shift later ones)
 *   2. modifies — caller must not modify lines that are also deleted
 *   3. inserts low→high (so each splice places content at its final-array position
 *      in an array that already has every lower-index final line in place)
 *
 * @param {string[]} lines  Current file lines (mutated in place)
 * @param {Array<{type: string, index: number, content?: string}>} ops
 * @returns {string[]} The mutated lines array
 */
export function applyOps(lines, ops) {
    const deletes = ops.filter(o => o.type === 'delete').sort((a, b) => b.index - a.index);
    const modifies = ops.filter(o => o.type === 'modify');
    const inserts = ops.filter(o => o.type === 'insert').sort((a, b) => a.index - b.index);

    for (const op of deletes) {
        lines.splice(op.index, 1);
    }

    for (const op of modifies) {
        lines[op.index] = op.content;
    }

    for (const op of inserts) {
        lines.splice(op.index, 0, op.content);
    }

    return lines;
}
