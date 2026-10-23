import {canonicalUint64} from '../../indexer/helpers/uint64.js';

export const nativeStreamSubprotocol = 'hyperion-stream.v1.json';
export const nativeStreamMaximumFrameBytes = 1024 * 1024;

export class NativeStreamProtocolError extends Error {
    readonly code: string = 'PROTOCOL_ERROR';
    constructor(message: string) {super(message);}
}

export class NativeStreamFrameSizeError extends NativeStreamProtocolError {
    override readonly code = 'FRAME_TOO_LARGE';
    constructor() {super('Frame is too large');}
}

type JsonObject = Record<string, unknown>;
export interface NativeScope {
    connection_id: string;
    stream_id: string;
    generation: string;
    subscription_id: string;
}
export interface NativeWindow {records: number; bytes: number;}
export interface NativeRecord {
    block_num: number;
    block_id: string;
    cursor?: string | null;
    payload: Record<string, unknown>;
}
export type NativeClientPacket =
    | {type: 'ready'; connection_id: string; window: NativeWindow}
    | {type: 'subscribe'; connection_id: string; request_id: string; stream_id: string; generation: string;
        request: JsonObject; resume_from?: number | null; window: NativeWindow}
    | ({type: 'ack'; sequence: string} & NativeScope)
    | {type: 'cancel'; connection_id: string; request_id: string; stream_id: string; generation: string;
        subscription_id: string | null}
    | {type: 'ping' | 'pong'; id: string};

const fail = (message: string): never => {throw new NativeStreamProtocolError(message);};
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : fail('Expected a JSON object');

export function nativeDecimal(value: unknown, positive = true): string {
    if (typeof value !== 'string') fail('Expected a canonical decimal string');
    try {canonicalUint64(value);}
    catch {fail('Invalid uint64 decimal string');}
    if (positive && value === '0') fail('Identifier must be nonzero');
    return value as string;
}

function integer(value: unknown, maximum: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
        fail('Invalid positive integer');
    return value as number;
}

export const nativeBlock = (value: unknown): number => integer(value, 0xffffffff);
const hash = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
    ? value : fail('Invalid chain or block ID');

function text(value: unknown, maximumBytes: number): string {
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > maximumBytes)
        fail('Invalid text field');
    return value as string;
}

export function nativeWindow(value: unknown): NativeWindow {
    const window = object(value);
    return {records: integer(window.records, 65536), bytes: integer(window.bytes, 64 * 1024 * 1024)};
}

export function nativeScope(value: unknown): NativeScope {
    const packet = object(value);
    return {connection_id: nativeDecimal(packet.connection_id), stream_id: nativeDecimal(packet.stream_id),
        generation: nativeDecimal(packet.generation), subscription_id: nativeDecimal(packet.subscription_id)};
}

/** Parse one bounded document; JSON.parse alone would accept repeated identity keys. */
export function parseNativeJson(textValue: string, maximumBytes = nativeStreamMaximumFrameBytes): JsonObject {
    integer(maximumBytes, 64 * 1024 * 1024);
    if (typeof textValue !== 'string') fail('Expected JSON text');
    if (Buffer.byteLength(textValue) > maximumBytes) throw new NativeStreamFrameSizeError();
    let index = 0;
    const whitespace = () => {while (index < textValue.length && /[\x20\t\r\n]/.test(textValue[index])) index++;};
    const string = (): string => {
        const start = index++;
        while (index < textValue.length) {
            if (textValue[index] === '\\') {index += 2; continue;}
            if (textValue[index++] === '"') {
                const decoded = JSON.parse(textValue.slice(start, index)) as string;
                for (let i = 0; i < decoded.length; i++) {
                    const code = decoded.charCodeAt(i);
                    if (code >= 0xd800 && code <= 0xdbff) {
                        const next = decoded.charCodeAt(++i);
                        if (!(next >= 0xdc00 && next <= 0xdfff)) fail('Invalid Unicode surrogate');
                    } else if (code >= 0xdc00 && code <= 0xdfff) fail('Invalid Unicode surrogate');
                }
                return decoded;
            }
        }
        return fail('Unterminated JSON string');
    };
    const value = (depth: number): void => {
        if (depth > 64) fail('JSON nesting limit exceeded');
        whitespace();
        const token = textValue[index];
        if (token === '"') {string(); return;}
        if (token === '{') {
            index++; whitespace();
            const names = new Set<string>();
            if (textValue[index] === '}') {index++; return;}
            while (index < textValue.length) {
                whitespace();
                if (textValue[index] !== '"') fail('Invalid object key');
                const name = string();
                if (names.has(name)) fail('Duplicate JSON key');
                names.add(name); whitespace();
                if (textValue[index++] !== ':') fail('Missing object colon');
                value(depth + 1); whitespace();
                if (textValue[index] === '}') {index++; return;}
                if (textValue[index++] !== ',') fail('Invalid object delimiter');
            }
            fail('Unterminated JSON object');
        }
        if (token === '[') {
            index++; whitespace();
            if (textValue[index] === ']') {index++; return;}
            while (index < textValue.length) {
                value(depth + 1); whitespace();
                if (textValue[index] === ']') {index++; return;}
                if (textValue[index++] !== ',') fail('Invalid array delimiter');
            }
            fail('Unterminated JSON array');
        }
        const start = index;
        while (index < textValue.length && !/[\x20\t\r\n,\]}]/.test(textValue[index])) index++;
        if (start === index) fail('Missing JSON value');
        if (/[-0-9]/.test(textValue[start]) && !Number.isFinite(Number(textValue.slice(start, index))))
            fail('JSON number is not finite');
    };
    try {
        value(0); whitespace();
        if (index !== textValue.length) fail('Trailing JSON document');
        return object(JSON.parse(textValue));
    } catch (error) {
        if (error instanceof NativeStreamProtocolError) throw error;
        return fail('Invalid JSON frame');
    }
}

export function parseNativeClientPacket(textValue: string, maximumBytes = nativeStreamMaximumFrameBytes): NativeClientPacket {
    const packet = parseNativeJson(textValue, maximumBytes);
    switch (packet.type) {
        case 'ready': return {type: packet.type, connection_id: nativeDecimal(packet.connection_id), window: nativeWindow(packet.window)};
        case 'subscribe': {
            const request = object(packet.request);
            if (request.kind !== 'action' && request.kind !== 'delta') fail('Unknown stream kind');
            return {type: packet.type, connection_id: nativeDecimal(packet.connection_id),
                request_id: nativeDecimal(packet.request_id), stream_id: nativeDecimal(packet.stream_id),
                generation: nativeDecimal(packet.generation), request,
                resume_from: packet.resume_from === null || packet.resume_from === undefined ? null : nativeBlock(packet.resume_from),
                window: nativeWindow(packet.window)};
        }
        case 'ack': return {type: packet.type, ...nativeScope(packet), sequence: nativeDecimal(packet.sequence)};
        case 'cancel': return {type: packet.type, connection_id: nativeDecimal(packet.connection_id),
            request_id: nativeDecimal(packet.request_id), stream_id: nativeDecimal(packet.stream_id),
            generation: nativeDecimal(packet.generation),
            subscription_id: packet.subscription_id === null ? null : nativeDecimal(packet.subscription_id)};
        case 'ping': case 'pong': return {type: packet.type, id: nativeDecimal(packet.id, false)};
        default: return fail('Unknown client packet type');
    }
}

function exactSequenceFields(record: JsonObject, fields: readonly string[]): void {
    for (const key of fields) if (Object.hasOwn(record, key)) nativeDecimal(record[key], false);
}

function exactAuthorizationSequences(record: JsonObject): void {
    if (!Object.hasOwn(record, 'auth_sequence')) return;
    if (!Array.isArray(record.auth_sequence)) fail('Invalid action authorization sequences');
    for (const authorization of record.auth_sequence as unknown[])
        exactSequenceFields(object(authorization), ['sequence']);
}

function exactReceipt(value: unknown): void {
    const receipt = object(value);
    exactSequenceFields(receipt, ['global_sequence', 'recv_sequence']);
    exactAuthorizationSequences(receipt);
}

/** Validate known chain metadata only; contract values under data remain opaque JSON. */
function exactMetadata(value: unknown): void {
    const record = object(value);
    exactSequenceFields(record, ['global_sequence', 'recv_sequence', 'sequence']);
    exactAuthorizationSequences(record);
    if (record.receipt !== undefined && record.receipt !== null) {
        if (Array.isArray(record.receipt)) {
            if (record.receipt.length !== 2 || typeof record.receipt[0] !== 'string')
                fail('Invalid SHIP action receipt variant');
            exactReceipt(record.receipt[1]);
        } else exactReceipt(record.receipt);
    }
    if (Object.hasOwn(record, 'receipts')) {
        if (!Array.isArray(record.receipts)) fail('Invalid grouped action receipts');
        for (const receipt of record.receipts as unknown[]) exactReceipt(receipt);
    }
}

/** Used before server encoding and by the pinned cross-language wire corpus. */
export function assertNativeServerPacket(value: unknown): asserts value is JsonObject {
    const packet = object(value);
    switch (packet.type) {
        case 'hello':
            if (packet.version !== 1) fail('Unknown native stream version');
            hash(packet.chain_id); nativeDecimal(packet.connection_id); integer(packet.heartbeat_interval_ms, 0xffffffff);
            return;
        case 'accepted': nativeScope(packet); nativeDecimal(packet.request_id); nativeBlock(packet.start_from); return;
        case 'data': {
            nativeScope(packet); nativeDecimal(packet.sequence);
            if (packet.mode !== 'history' && packet.mode !== 'live') fail('Unknown data mode');
            if (!Array.isArray(packet.records) || !packet.records.length) fail('Empty data frame');
            let previousBlock = 0;
            for (const entry of packet.records as unknown[]) {
                const record = object(entry);
                const block = nativeBlock(record.block_num);
                if (block < previousBlock) fail('Data frame blocks must not decrease');
                previousBlock = block;
                hash(record.block_id);
                if (record.cursor !== undefined && record.cursor !== null) nativeDecimal(record.cursor, false);
                exactMetadata(record.payload);
            }
            return;
        }
        case 'history_end': case 'end': case 'cancelled': nativeScope(packet); return;
        case 'error': {
            nativeDecimal(packet.connection_id);
            const scoped = packet.stream_id !== null && packet.stream_id !== undefined;
            if (scoped !== (packet.generation !== null && packet.generation !== undefined)) fail('Unpaired error scope');
            if (scoped) {nativeDecimal(packet.stream_id); nativeDecimal(packet.generation);}
            if (packet.request_id !== undefined && packet.request_id !== null) nativeDecimal(packet.request_id);
            text(packet.code, 128); text(packet.message, 4096);
            if (typeof packet.retryable !== 'boolean') fail('Invalid error retryability');
            return;
        }
        case 'lib': nativeDecimal(packet.connection_id); hash(packet.chain_id); nativeBlock(packet.block_num); hash(packet.block_id); return;
        case 'fork':
            nativeDecimal(packet.connection_id); hash(packet.chain_id); hash(packet.new_block_id);
            if (nativeBlock(packet.ending_block) < nativeBlock(packet.starting_block)) fail('Invalid fork interval');
            return;
        case 'ping': case 'pong': nativeDecimal(packet.id, false); return;
        default: fail('Unknown server packet type');
    }
}

export function encodeNativeServerPacket(value: unknown, maximumBytes = nativeStreamMaximumFrameBytes): string {
    let encoded: string;
    try {encoded = JSON.stringify(value, (_key, member) => {
        if (typeof member === 'number' && !Number.isFinite(member)) fail('JSON number is not finite');
        return member;
    });}
    catch (error) {if (error instanceof NativeStreamProtocolError) throw error; return fail('Payload is not JSON serializable');}
    // Validate the actual serialized bytes, including metadata and arbitrary Unicode.
    assertNativeServerPacket(parseNativeJson(encoded, maximumBytes));
    return encoded;
}
