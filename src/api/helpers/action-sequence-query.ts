import {isActionSequenceField} from '../../indexer/helpers/action-sequences.js';
import {canonicalUint64, compatibleUint64} from '../../indexer/helpers/uint64.js';

/** Validate existing metadata filter syntax before cache access or native query construction. */
export function validateActionSequenceQuery(query: Record<string, unknown>, legacyPost = false): void {
    for (const [field, input] of Object.entries(query)) {
        if (!isActionSequenceField(field)) continue;
        try {
            const text = typeof input === 'number' ? compatibleUint64(input) : input;
            if (typeof text !== 'string') throw new Error('Invalid sequence query value');
            if (legacyPost) canonicalUint64(text);
            else {
                for (const token of text.split(/[ ,]/)) {
                    const negated = token.startsWith('!');
                    const bounds = (negated ? token.slice(1) : token).split('-');
                    if (bounds.length > 2 || (negated && bounds.length > 1)) throw new Error('Invalid sequence query syntax');
                    for (const bound of bounds) canonicalUint64(bound);
                }
            }
            query[field] = text;
        } catch {
            throw Object.assign(new Error(`Invalid canonical uint64 sequence filter: ${field}`), {statusCode: 400});
        }
    }
}
