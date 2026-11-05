import {randomUUID} from 'node:crypto';

/** Experimental wire-response reservations only, not downstream, projection, heap or RSS accounting. */
export interface SourceCreditCapacityConfiguration {
    readonly interface_version: 1;
    readonly qualification_only: true;
    readonly maximum_ingress_bytes: number;
}
export interface SourceCreditCapacityOptions {readonly maximumBytes: number; readonly frameBytes: number; readonly window: number}
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function requireCapacity(value: unknown, message: string): asserts value {if (!value) throw new Error('Source-credit capacity: ' + message);}

/** No default budget; unsupported lifecycle modes refuse rather than imply complete aggregate accounting. */
export function resolveSourceCreditCapacity(conf: {settings: {source_credit_capacity?: SourceCreditCapacityConfiguration;
    max_ws_payload_mb?: number; protocol?: {provider: string}}; indexer: {live_reader?: boolean; live_only_mode?: boolean}; prefetch: {read: number}}): SourceCreditCapacityOptions | undefined {
    const value = conf.settings.source_credit_capacity;
    if (value === undefined) return;
    requireCapacity(value && Object.keys(value).sort().join(',') === 'interface_version,maximum_ingress_bytes,qualification_only'
        && value.interface_version === 1 && value.qualification_only === true, 'explicit qualification configuration required');
    requireCapacity(conf.indexer.live_reader === true && conf.indexer.live_only_mode === true
        && conf.settings.protocol?.provider === 'extension', 'first slice requires an extension live-only reader');
    const frameBytes = (conf.settings.max_ws_payload_mb ?? 0) * 1024 * 1024, window = conf.prefetch.read;
    requireCapacity(integer(frameBytes, 1) && integer(window, 1) && window <= 0xffffffff
        && integer(frameBytes * window, 1), 'finite existing WebSocket frame cap and prefetch required');
    requireCapacity(integer(value.maximum_ingress_bytes, 1) && value.maximum_ingress_bytes >= frameBytes * window,
        'explicit byte budget must cover the existing source window');
    return Object.freeze({maximumBytes: value.maximum_ingress_bytes, frameBytes, window});
}

export interface SourceCreditCapacityUpdate {
    readonly sessionId: string;
    readonly sequence: number;
    readonly settledTotal: number;
    readonly wantedTotal: number;
}
export interface SourceCreditCapacityGrant extends SourceCreditCapacityUpdate {readonly epoch: string; readonly grantedTotal: number}
export interface SourceCreditCapacityRequest {event: 'source_credit_capacity_request'; mId: string; data: SourceCreditCapacityUpdate}
export interface SourceCreditCapacityReply {event: 'source_credit_capacity_reply'; mId: string;
    data: {ok: true; result: SourceCreditCapacityGrant} | {ok: false; error: string}}
export function isSourceCreditCapacityRequest(message: any): message is SourceCreditCapacityRequest {
    const value = message?.data;
    return message?.event === 'source_credit_capacity_request' && uuid(message.mId) && value
        && Object.keys(value).sort().join(',') === 'sequence,sessionId,settledTotal,wantedTotal'
        && uuid(value.sessionId) && integer(value.sequence, 1) && integer(value.settledTotal) && integer(value.wantedTotal);
}

interface Reservation {last: SourceCreditCapacityGrant}
/** One master owns all current and retiring physical readers. Disconnect/timeouts never release reservations. */
export class SourceCreditCapacityCoordinator<PhysicalReader extends object> {
    private readonly readers = new Map<PhysicalReader, Reservation>();
    private readonly retired = new WeakSet<PhysicalReader>();
    private readonly epoch = randomUUID();
    private pendingCredits = 0;
    constructor(private readonly options: SourceCreditCapacityOptions) {
        requireCapacity(integer(options.frameBytes, 1) && integer(options.window, 1) && options.window <= 0xffffffff && integer(options.maximumBytes, 1)
            && integer(options.frameBytes * options.window, 1) && options.frameBytes * options.window <= options.maximumBytes,
            'invalid coordinator bounds');
        this.options = Object.freeze({...options});
    }
    matches(options: SourceCreditCapacityOptions): boolean {return options.maximumBytes === this.options.maximumBytes
        && options.frameBytes === this.options.frameBytes && options.window === this.options.window;}
    update(reader: PhysicalReader, input: SourceCreditCapacityUpdate): SourceCreditCapacityGrant {
        requireCapacity(!this.retired.has(reader), 'exited reader cannot acquire credits');
        requireCapacity(uuid(input.sessionId) && integer(input.sequence, 1) && integer(input.settledTotal) && integer(input.wantedTotal), 'invalid update');
        const held = this.readers.get(reader), prior = held?.last;
        if (prior && input.sequence === prior.sequence) {
            requireCapacity(input.sessionId === prior.sessionId && input.settledTotal === prior.settledTotal
                && input.wantedTotal === prior.wantedTotal, 'duplicate sequence changed');
            return {...prior};
        }
        requireCapacity(input.sequence === (prior?.sequence ?? 0) + 1 && (!prior || input.sessionId === prior.sessionId),
            'stale sequence or replaced session');
        const granted = prior?.grantedTotal ?? 0, settled = prior?.settledTotal ?? 0;
        requireCapacity(input.settledTotal >= settled && input.settledTotal <= granted
            && input.wantedTotal >= (prior?.wantedTotal ?? 0) && input.wantedTotal >= granted
            && input.wantedTotal - input.settledTotal <= this.options.window, 'invalid cumulative source window');
        requireCapacity(held || this.readers.size < 64, 'physical reader reservation limit');
        const afterSettlement = this.pendingCredits - (input.settledTotal - settled);
        const free = Math.floor(this.options.maximumBytes / this.options.frameBytes) - afterSettlement;
        const added = Math.min(input.wantedTotal - granted, free);
        requireCapacity(integer(added) && integer(afterSettlement) && integer(granted + added), 'reservation arithmetic overflow');
        const last = Object.freeze({...input, epoch: this.epoch, grantedTotal: granted + added});
        this.pendingCredits = afterSettlement + added;
        this.readers.set(reader, {last});
        return {...last};
    }
    /** Must be called from the actual physical Worker's exit event, never disconnect or a child claim. */
    exited(reader: PhysicalReader): void {
        const held = this.readers.get(reader);
        if (held) this.pendingCredits -= held.last.grantedTotal - held.last.settledTotal;
        this.readers.delete(reader); this.retired.add(reader);
    }
    snapshot() {return Object.freeze({scope: 'source-credit-encoded-reservations-only', maximumBytes: this.options.maximumBytes,
        frameBytes: this.options.frameBytes, pendingCredits: this.pendingCredits, reservedBytes: this.pendingCredits * this.options.frameBytes,
        physicalReaders: this.readers.size, downstreamAccounting: 'not-implemented', projectionAccounting: 'not-implemented'});}
}

/** One bounded RPC waiter. A failed or cancelled call keeps any master reservation uncertain/charged. */
export class SourceCreditCapacityRpc {
    private sequence = 0;
    private epoch?: string;
    private pending?: {id: string; input: SourceCreditCapacityUpdate; timer: NodeJS.Timeout;
        resolve: (grant: SourceCreditCapacityGrant) => void; reject: (error: Error) => void};
    private closed = false;
    readonly sessionId = randomUUID();
    constructor(private readonly send: (message: SourceCreditCapacityRequest, callback: (error: Error | null) => void) => unknown = (message, callback) => {
        if (!process.send) throw new Error('Source-credit capacity requires master IPC');
        return process.send(message, callback);
    }, private readonly timeoutMs = 5000) {}
    update(settledTotal: number, wantedTotal: number): Promise<SourceCreditCapacityGrant> {
        if (this.closed || this.pending) return Promise.reject(new Error('Source-credit capacity RPC closed or pending'));
        return new Promise((resolve, reject) => {
            const id = randomUUID(), input = {sessionId: this.sessionId, sequence: ++this.sequence, settledTotal, wantedTotal};
            const timer = setTimeout(() => this.fail(id, new Error('Source-credit capacity IPC timed out')), this.timeoutMs);
            this.pending = {id, input, timer, resolve, reject};
            try {this.send({event: 'source_credit_capacity_request', mId: id, data: input}, error => {if (error) this.fail(id, error);});}
            catch (error) {this.fail(id, error instanceof Error ? error : new Error(String(error)));}
        });
    }
    onMessage(message: any): boolean {
        if (message?.event !== 'source_credit_capacity_reply') return false;
        const pending = this.pending;
        if (!pending || message.mId !== pending.id) return true;
        if (message.data?.ok === false && typeof message.data.error === 'string') {
            this.fail(pending.id, new Error(message.data.error.slice(0, 512))); return true;
        }
        const result = message.data?.result, input = pending.input;
        if (message.data?.ok !== true || !result || Object.keys(result).sort().join(',') !== 'epoch,grantedTotal,sequence,sessionId,settledTotal,wantedTotal'
            || !uuid(result.epoch) || this.epoch !== undefined && this.epoch !== result.epoch
            || result.sessionId !== input.sessionId || result.sequence !== input.sequence || result.settledTotal !== input.settledTotal
            || result.wantedTotal !== input.wantedTotal || !integer(result.grantedTotal) || result.grantedTotal < input.settledTotal
            || result.grantedTotal > input.wantedTotal) {
            this.fail(pending.id, new Error('Malformed or replaced source-credit capacity grant')); return true;
        }
        this.epoch = result.epoch; clearTimeout(pending.timer); this.pending = undefined; pending.resolve({...result}); return true;
    }
    cancel(): void {
        this.closed = true;
        if (this.pending) this.fail(this.pending.id, new Error('Source-credit capacity session cancelled'));
    }
    private fail(id: string, error: Error): void {
        const pending = this.pending; if (!pending || pending.id !== id) return;
        clearTimeout(pending.timer); this.pending = undefined; this.closed = true; pending.reject(error);
    }
}
