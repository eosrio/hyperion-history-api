import {encodeNativeServerPacket, nativeDecimal, nativeScope, nativeWindow, NativeStreamFrameSizeError,
    NativeStreamProtocolError, type NativeRecord, type NativeScope, type NativeWindow} from './native-json.js';

type Usage = {records: number; bytes: number};
interface Reservation {cost: Usage; active: boolean;}
interface CreditScope {
    scope: NativeScope;
    window: NativeWindow;
    used: Usage;
    sent: bigint;
    acknowledged: bigint;
    outstanding: Map<string, Usage>;
    serializing: boolean;
    pending?: Reservation;
}
export type NativeSendResult = 'sent' | 'blocked' | 'frame_exceeds_window' | 'transport_rejected' | 'scope_retired';
export interface NativeCreditOptions {
    onCredit?: () => void;
    maximumStreams?: number;
    maximumLifetimeSubscriptions?: number;
}

const scopeKey = (scope: NativeScope): string => `${scope.stream_id}/${scope.generation}/${scope.subscription_id}`;

/** Count and full encoded-byte authority for one physical connection incarnation. */
export class NativeStreamCredits {
    private readonly scopes = new Map<string, CreditScope>();
    private readonly streams = new Map<string, string>();
    private readonly usedGenerations = new Set<string>();
    private readonly usedSubscriptions = new Set<string>();
    private readonly used: Usage = {records: 0, bytes: 0};
    private readonly onCredit?: () => void;
    private readonly maximumStreams: number;
    private readonly maximumLifetimeSubscriptions: number;
    private notifyScheduled = false;
    readonly connectionId: string;
    readonly window: Readonly<NativeWindow>;

    constructor(connectionId: string, window: NativeWindow, options: NativeCreditOptions = {}) {
        this.connectionId = nativeDecimal(connectionId);
        this.window = Object.freeze(nativeWindow(window));
        this.onCredit = options.onCredit;
        this.maximumStreams = options.maximumStreams ?? 16;
        this.maximumLifetimeSubscriptions = options.maximumLifetimeSubscriptions ?? 4096;
        if (!Number.isSafeInteger(this.maximumStreams) || this.maximumStreams < 1 || this.maximumStreams > 1024
            || !Number.isSafeInteger(this.maximumLifetimeSubscriptions) || this.maximumLifetimeSubscriptions < this.maximumStreams
            || this.maximumLifetimeSubscriptions > 65536) throw new NativeStreamProtocolError('Invalid subscription limits');
    }

    open(value: NativeScope, window: NativeWindow): void {
        const scope = nativeScope(value), generation = `${scope.stream_id}/${scope.generation}`;
        if (scope.connection_id !== this.connectionId || this.streams.has(scope.stream_id)
            || this.usedGenerations.has(generation) || this.usedSubscriptions.has(scope.subscription_id))
            throw new NativeStreamProtocolError('Subscription scope is foreign, active or reused');
        if (this.scopes.size >= this.maximumStreams || this.usedGenerations.size >= this.maximumLifetimeSubscriptions)
            throw new NativeStreamProtocolError('Subscription limit exceeded');
        const selected = nativeWindow(window), key = scopeKey(scope);
        this.scopes.set(key, {scope, window: selected, used: {records: 0, bytes: 0}, sent: 0n,
            acknowledged: 0n, outstanding: new Map(), serializing: false});
        this.streams.set(scope.stream_id, key);
        this.usedGenerations.add(generation);
        this.usedSubscriptions.add(scope.subscription_id);
    }

    /** A false writer result means that no frame was accepted by the transport. */
    send(value: NativeScope, mode: 'history' | 'live', records: readonly NativeRecord[],
        write: (encoded: string) => boolean): NativeSendResult {
        const scope = nativeScope(value), entry = this.current(scope);
        if (!entry) return 'scope_retired';
        if (entry.pending || entry.serializing) return 'blocked';
        const sequence = (entry.sent + 1n).toString();
        let encoded: string;
        // User payloads may invoke toJSON; fence same-scope sends before serialization.
        entry.serializing = true;
        try {encoded = encodeNativeServerPacket({type: 'data', ...scope, sequence, mode, records});}
        catch (error) {if (error instanceof NativeStreamFrameSizeError) return 'frame_exceeds_window'; throw error;}
        finally {entry.serializing = false;}
        if (this.current(scope) !== entry) return 'scope_retired';
        const cost = {records: (JSON.parse(encoded).records as unknown[]).length, bytes: Buffer.byteLength(encoded)};
        if (cost.records > entry.window.records || cost.bytes > entry.window.bytes
            || cost.records > this.window.records || cost.bytes > this.window.bytes) return 'frame_exceeds_window';
        if (cost.records + entry.used.records > entry.window.records || cost.bytes + entry.used.bytes > entry.window.bytes
            || cost.records + this.used.records > this.window.records || cost.bytes + this.used.bytes > this.window.bytes)
            return 'blocked';
        const pending: Reservation = {cost, active: true};
        entry.pending = pending;
        this.add(entry, cost);
        try {
            const accepted = write(encoded);
            // A synchronous transport close may retire and release this reservation.
            if (!pending.active || this.current(scope) !== entry) return 'scope_retired';
            if (accepted !== true) {this.releasePending(entry, pending); return 'transport_rejected';}
            pending.active = false;
            entry.pending = undefined;
            entry.sent++;
            entry.outstanding.set(sequence, cost);
            return 'sent';
        } catch (error) {
            if (pending.active) this.releasePending(entry, pending);
            throw error;
        }
    }

    /** Only the next retained, committed frame can free its recorded costs once. */
    acknowledge(value: NativeScope & {sequence: string}): boolean {
        const scope = nativeScope(value), sequence = nativeDecimal(value.sequence), entry = this.current(scope);
        if (!entry || BigInt(sequence) !== entry.acknowledged + 1n) return false;
        const cost = entry.outstanding.get(sequence);
        if (!cost) return false;
        entry.outstanding.delete(sequence);
        entry.acknowledged++;
        this.subtract(entry, cost);
        this.notify();
        return true;
    }

    close(value: NativeScope): boolean {
        const scope = nativeScope(value), entry = this.current(scope);
        if (!entry) return false;
        this.scopes.delete(scopeKey(scope));
        this.streams.delete(scope.stream_id);
        if (entry.pending) entry.pending.active = false;
        this.used.records -= entry.used.records;
        this.used.bytes -= entry.used.bytes;
        entry.used = {records: 0, bytes: 0};
        entry.outstanding.clear();
        entry.pending = undefined;
        this.notify();
        return true;
    }

    snapshot(): Readonly<Usage & {streams: number; lifetimeSubscriptions: number}> {
        return Object.freeze({...this.used, streams: this.scopes.size, lifetimeSubscriptions: this.usedGenerations.size});
    }

    private current(scope: NativeScope): CreditScope | undefined {
        return scope.connection_id === this.connectionId ? this.scopes.get(scopeKey(scope)) : undefined;
    }

    private add(entry: CreditScope, cost: Usage): void {
        entry.used.records += cost.records; entry.used.bytes += cost.bytes;
        this.used.records += cost.records; this.used.bytes += cost.bytes;
    }

    private subtract(entry: CreditScope, cost: Usage): void {
        entry.used.records -= cost.records; entry.used.bytes -= cost.bytes;
        this.used.records -= cost.records; this.used.bytes -= cost.bytes;
    }

    private releasePending(entry: CreditScope, pending: Reservation): void {
        pending.active = false;
        entry.pending = undefined;
        this.subtract(entry, pending.cost);
        this.notify();
    }

    private notify(): void {
        if (!this.onCredit || this.notifyScheduled) return;
        this.notifyScheduled = true;
        queueMicrotask(() => {this.notifyScheduled = false; this.onCredit?.();});
    }
}
