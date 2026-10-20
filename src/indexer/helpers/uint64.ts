const maximumUint64 = '18446744073709551615';

export class Uint64ValueError extends RangeError {
    readonly code = 'HYPERION_UINT64_INVALID';

    constructor(message = 'Expected a canonical decimal uint64 string') {
        super(message);
        this.name = 'Uint64ValueError';
    }
}

/** No signs, padding, exponent notation or numeric reconstruction. Source-specific nonzero rules remain with callers. */
export function canonicalUint64(value: unknown): string {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
        (value.length === 20 && value > maximumUint64)) {
        throw new Uint64ValueError();
    }
    return value;
}

/** Explicit compatibility for retained values whose original numeric value is still exactly representable. */
export function compatibleUint64(value: unknown): string {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Uint64ValueError('Unsafe or invalid numeric uint64 value; exact source text is required');
        }
        return String(value);
    }
    return canonicalUint64(value);
}

export function compareUint64(left: string, right: string): -1 | 0 | 1 {
    const a = canonicalUint64(left), b = canonicalUint64(right);
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a === b ? 0 : a < b ? -1 : 1;
}

/** Counts derived from sequences keep exact decimal text even when the difference fits a JS number. */
export function subtractUint64(later: string, earlier: string): string {
    const result = BigInt(canonicalUint64(later)) - BigInt(canonicalUint64(earlier));
    if (result < 0n) throw new Uint64ValueError('Sequence count cannot move backwards');
    return result.toString();
}
