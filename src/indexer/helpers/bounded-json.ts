export interface BoundedJsonOptions {
    maximumBytes?: number;
    /** Protocol identities forbid floating or unsafe integers; opaque action data may contain either. */
    numberPolicy?: 'safe-integer' | 'finite';
    errorPrefix?: string;
}

// Pure string encoding only: no object, source, declaration or read authority is
// retained. Count both UTF-16 strings conservatively, even on Latin-1 V8 storage.
const encodedStrings = new Map<string, {encoded: string; bytes: number; retained: number}>();
const encodingCacheBytes = 512 * 1024, encodingCacheEntries = 8, encodingEntryBytes = 64 * 1024;
let retainedEncodingBytes = 0;
function retainEncoding(value: string, encoded: string, bytes: number): void {
    if (value.length < 512 || bytes > encodingEntryBytes) return;
    const retained = 2 * (value.length + encoded.length);
    while (encodedStrings.size >= encodingCacheEntries || retainedEncodingBytes + retained > encodingCacheBytes) {
        const oldest = encodedStrings.keys().next().value;
        if (oldest === undefined) return;
        retainedEncodingBytes -= encodedStrings.get(oldest)!.retained;
        encodedStrings.delete(oldest);
    }
    // Decode owned bounded bytes so sliced/rope input strings cannot keep a much
    // larger parent allocation alive through either retained string.
    const key = Buffer.from(value, 'utf8').toString('utf8');
    const copy = Buffer.from(encoded, 'utf8').toString('utf8');
    encodedStrings.set(key, {encoded: copy, bytes, retained}); retainedEncodingBytes += retained;
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
        const retained = value.length >= 512 ? encodedStrings.get(value) : undefined;
        if (retained) {take(retained.bytes); return retained.encoded;}
        if (!value.isWellFormed()) throw new Error(errorPrefix + ' contains malformed UTF-16');
        const before = bytes;
        take(2);
        // Refuse the minimum size before scanning or allocating the encoded string.
        if (bytes + value.length > maximumBytes) take(value.length);
        if (!/["\\\x00-\x1f\x7f-\uffff]/.test(value)) {
            take(value.length);
            // The guard proves no escaping is needed. Preserve the preceding UTF-16
            // and minimum-byte checks, then avoid re-encoding large retained hex.
            return '"' + value + '"';
        }
        for (let index = 0; index < value.length; index++) {
            const code = value.charCodeAt(index);
            if (code < 32) take([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
            else if (code === 34 || code === 92) take(2);
            else if (code < 128) take(1);
            else if (code < 2048) take(2);
            else if (code >= 0xd800 && code <= 0xdbff) {take(4); index++;}
            else take(3);
        }
        const encoded = JSON.stringify(value); retainEncoding(value, encoded, bytes - before); return encoded;
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
        // Reflect the source once, in the same order as before. Walk the resulting plain
        // descriptor record without allocating entry pairs, filtered pairs or map closures.
        const keys = Object.keys(descriptors);
        if (array) {
            if (keys[keys.length - 1] !== 'length' || keys.length - 1 !== descriptors.length.value)
                throw new Error(errorPrefix + ' contains accessors or sparse data');
            keys.pop();
        }
        for (let index = 0; index < keys.length; index++) {
            const key = keys[index], descriptor = descriptors[key];
            if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || (array && key !== String(index)))
                throw new Error(errorPrefix + ' contains accessors or sparse data');
        }
        ancestors.add(value); take(2 + Math.max(0, keys.length - 1));
        try {
            const parts = new Array<string>(keys.length);
            if (array) {
                for (let index = 0; index < keys.length; index++) parts[index] = visit(descriptors[keys[index]].value, depth + 1);
                return '[' + parts.join(',') + ']';
            }
            keys.sort();
            for (let index = 0; index < keys.length; index++) {
                const key = keys[index], encodedKey = string(key); take(1);
                parts[index] = encodedKey + ':' + visit(descriptors[key].value, depth + 1);
            }
            return '{' + parts.join(',') + '}';
        } finally {ancestors.delete(value);}
    };
    return visit(input, 0);
}
