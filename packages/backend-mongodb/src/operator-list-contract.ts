import {createHash, type Hash} from 'node:crypto';
import {types} from 'node:util';
import {OperatorListError, type OperatorListEntryV1, type OperatorListLimitsV1} from '@eosrio/hyperion-sdk/operator-lists';

export const FORMAT = 'h45-mongodb-operator-lists-v1';
export const CACHE_MS = 300000;
export const BSON_MAX = 16 * 1024 * 1024;
export function requireList(ok: unknown, message: string): asserts ok {
    if (!ok) throw new OperatorListError(message);
}
export function unavailable(error: unknown): OperatorListError {
    if (error instanceof OperatorListError) return error;
    const failure = new OperatorListError('MongoDB operator-list source is unavailable'); failure.cause = error; return failure;
}
export function secondary(primary: OperatorListError, error: unknown): void {
    if (error === primary) return;
    const previous = Object.getOwnPropertyDescriptor(primary, 'suppressed')?.value as unknown[] | undefined;
    Object.defineProperty(primary, 'suppressed', {value: [...(previous ?? []), error], configurable: true});
}
export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    requireList(value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'Expected inert operator-list record');
    const ds = Object.getOwnPropertyDescriptors(value);
    requireList(Reflect.ownKeys(ds).length === keys.length && keys.every(key => ds[key]?.enumerable && Object.hasOwn(ds[key]!, 'value')),
        'Unexpected operator-list fields or accessors');
    return Object.fromEntries(keys.map(key => [key, ds[key]!.value]));
}
export function array(value: unknown, maximum: number): readonly unknown[] {
    requireList(value !== null && typeof value === 'object' && !types.isProxy(value) && Array.isArray(value)
        && Object.getPrototypeOf(value) === Array.prototype && Object.getOwnPropertySymbols(value).length === 0,
    'Expected inert operator-list array');
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    requireList(Number.isSafeInteger(length) && length >= 0 && length <= maximum, 'Operator-list array bound exceeded');
    const ds = Object.getOwnPropertyDescriptors(value);
    requireList(Object.keys(ds).length === length + 1, 'Sparse or extended operator-list array');
    const captured: unknown[] = [];
    for (let i = 0; i < length; i++) {
        requireList(ds[i]?.enumerable && Object.hasOwn(ds[i]!, 'value'), 'Operator-list array accessor'); captured.push(ds[i]!.value);
    }
    return captured;
}
export function text(value: unknown): string {
    requireList(typeof value === 'string', 'Expected operator-list string');
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const next = value.charCodeAt(++i); requireList(next >= 0xdc00 && next <= 0xdfff, 'Malformed operator-list UTF-16');
        } else requireList(c < 0xdc00 || c > 0xdfff, 'Malformed operator-list UTF-16');
    }
    return value;
}
export function identity(value: unknown): string {
    const result = text(value); requireList(result.length > 0 && Buffer.byteLength(result) <= 256, 'Explicit bounded operator-list identity required'); return result;
}
export function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
    requireList(Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum, 'Invalid operator-list integer'); return value as number;
}
export function limits(value: unknown): OperatorListLimitsV1 {
    const v = record(value, ['names', 'items', 'bytes', 'attempts']);
    return Object.freeze({names: integer(v.names, 1), items: integer(v.items), bytes: integer(v.bytes, 1), attempts: integer(v.attempts, 1)});
}
export function fits(a: OperatorListLimitsV1, b: OperatorListLimitsV1): boolean {
    return a.names <= b.names && a.items <= b.items && a.bytes <= b.bytes && a.attempts <= b.attempts;
}
export const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function digest(value: unknown): string {
    requireList(typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/.test(value), 'Invalid operator-list digest'); return value;
}
export function addText(hash: Hash, value: string): void {
    hash.update(String(Buffer.byteLength(value)) + ':').update(value);
}
export function listHash(name: string): Hash {const hash = createHash('sha256').update(FORMAT + '\0'); addText(hash, name); return hash;}
export interface CapturedList extends OperatorListEntryV1 {readonly bytes: number; readonly digest: string}
/** Detached bounded import; each item occurrence and each list name contributes UTF-8 bytes. */
export function captureLists(value: unknown, maximum: OperatorListLimitsV1): readonly CapturedList[] {
    let items = 0, bytes = 0; const seen = new Set<string>();
    const result = array(value, maximum.names).map(raw => {
        const v = record(raw, ['name', 'items']), name = text(v.name);
        requireList(!seen.has(name), 'Duplicate published list name'); seen.add(name);
        let ownBytes = Buffer.byteLength(name); bytes += ownBytes;
        requireList(bytes <= maximum.bytes, 'Published list byte bound exceeded');
        const hash = listHash(name), values = array(v.items, maximum.items - items).map(rawItem => {
            const item = text(rawItem), size = Buffer.byteLength(item); items++; bytes += size; ownBytes += size;
            requireList(items <= maximum.items && bytes <= maximum.bytes, 'Published list total exceeded'); addText(hash, item); return item;
        });
        return Object.freeze({name, items: Object.freeze(values), bytes: ownBytes, digest: hash.digest('hex')});
    });
    return Object.freeze(result.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
