export interface BoundedJsonOptions {
    maximumBytes?: number;
    /** Protocol identities forbid floating or unsafe integers; opaque action data may contain either. */
    numberPolicy?: 'safe-integer' | 'finite';
    errorPrefix?: string;
}

/** Canonical portable JSON with bounded bytes, nodes and depth; never invokes accessors or toJSON. */
export function boundedCanonicalJson(input: unknown, options: BoundedJsonOptions = {}): string {
    const {maximumBytes = 128 * 1024 * 1024, numberPolicy = 'safe-integer', errorPrefix = 'JSON value'} = options;
    let bytes = 0, nodes = 0;
    const ancestors = new Set<object>();
    const take = (size: number) => {
        if ((bytes += size) > maximumBytes) throw new Error(errorPrefix + ' exceeds bounded JSON byte budget');
    };
    const string = (value: string) => {
        if (!value.isWellFormed()) throw new Error(errorPrefix + ' contains malformed UTF-16');
        take(2);
        for (let index = 0; index < value.length; index++) {
            const code = value.charCodeAt(index);
            if (code < 32) take([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
            else if (code === 34 || code === 92) take(2);
            else if (code < 128) take(1);
            else if (code < 2048) take(2);
            else if (code >= 0xd800 && code <= 0xdbff) {take(4); index++;}
            else take(3);
        }
        return JSON.stringify(value);
    };
    const visit = (value: unknown, depth: number): string => {
        if (++nodes > 1_000_000 || depth > 64) throw new Error(errorPrefix + ' exceeds bounded JSON node/depth budget');
        if (value === null || typeof value === 'boolean' || (typeof value === 'number' &&
            (numberPolicy === 'finite' ? Number.isFinite(value) : Number.isSafeInteger(value)))) {
            const result = JSON.stringify(value); take(result.length); return result;
        }
        if (typeof value === 'string') return string(value);
        if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error(errorPrefix + ' is not portable JSON');
        const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
        if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype && prototype !== null)
            || Object.getOwnPropertySymbols(value).length) throw new Error(errorPrefix + ' contains a native value');
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const entries = Object.entries(descriptors).filter(([key]) => !array || key !== 'length');
        if (entries.some(([, descriptor]) => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
            || (array && (entries.length !== descriptors.length.value
                || entries.some(([key], index) => key !== String(index))))) {
            throw new Error(errorPrefix + ' contains accessors or sparse data');
        }
        ancestors.add(value); take(2 + Math.max(0, entries.length - 1));
        try {
            if (array) return '[' + entries.map(([, descriptor]) => visit(descriptor.value, depth + 1)).join(',') + ']';
            return '{' + entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
                .map(([key, descriptor]) => {const encodedKey = string(key); take(1); return encodedKey + ':' + visit(descriptor.value, depth + 1);}).join(',') + '}';
        } finally {ancestors.delete(value);}
    };
    return visit(input, 0);
}
