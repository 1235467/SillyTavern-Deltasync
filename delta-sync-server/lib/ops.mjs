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
 * Order: deletes (high→low index), then modifies, then inserts (high→low index).
 *
 * @param {string[]} lines  Current file lines (mutated in place)
 * @param {Array<{type: string, index: number, content?: string}>} ops
 * @returns {string[]} The mutated lines array
 */
export function applyOps(lines, ops) {
    const deletes = ops.filter(o => o.type === 'delete').sort((a, b) => b.index - a.index);
    const modifies = ops.filter(o => o.type === 'modify');
    const inserts = ops.filter(o => o.type === 'insert').sort((a, b) => b.index - a.index);

    // Phase 1: deletes (high→low so indices stay valid)
    for (const op of deletes) {
        lines.splice(op.index, 1);
    }

    // Phase 2: modifies (order doesn't matter, indices are independent)
    for (const op of modifies) {
        lines[op.index] = op.content;
    }

    // Phase 3: inserts (high→low so indices stay valid)
    for (const op of inserts) {
        lines.splice(op.index, 0, op.content);
    }

    return lines;
}
