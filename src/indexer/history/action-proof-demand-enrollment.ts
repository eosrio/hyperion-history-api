import {createHash} from 'node:crypto';
import {isPromise} from 'node:util/types';
import {ActionProofDemandShadow, captureProofDemandHeaders, type ActionProofDemandInput} from './action-proof-demand.js';
import {consumeWorkerAttemptObservation, workerAttemptBounds, type WorkerAttemptSupervisor,
    type WorkerAttemptObservation, type WorkerAttemptObservationDescription, type PhysicalAttemptWorker} from '../protocol/worker-attempt-supervisor.js';

const maximumMessageBytes = workerAttemptBounds.maximumMessageBytes;
const workerReceiptMetadataBytes = 256;
const parentReceiptMetadataBytes = maximumMessageBytes * 4; // Original registration, binding, claim and parse-envelope headroom.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex64 = /^[0-9a-f]{64}$/;
const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
const bytes = (value: Uint8Array): number => {
    if (!(value instanceof Uint8Array) || ['byteLength','byteOffset','buffer','length','constructor'].some(key => Object.hasOwn(value, key)))
        throw new Error('Original captured byte layout unavailable');
    return byteLength.call(value);
};
type Claim = Pick<ActionProofDemandInput, 'source' | 'admissionId' | 'traceOrdinal'>;
type Limits = {maximumReceipts: number; maximumBytes: number};
const limits = (input: Limits): Readonly<Limits> => {
    const maximumReceipts = input.maximumReceipts, maximumBytes = input.maximumBytes;
    if (!Number.isSafeInteger(maximumReceipts) || maximumReceipts < 1 || maximumReceipts > 4096
        || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 128 * 1024 * 1024) throw new Error('Invalid receipt observer bounds');
    return Object.freeze({maximumReceipts, maximumBytes});
};
function claim(value: any): Claim {
    const source = value.source;
    if (!source || !hex64.test(source.chainId) || !hex64.test(source.blockId)
        || !Number.isSafeInteger(source.blockNum) || source.blockNum < 1 || source.blockNum > 0xffffffff
        || source.previousBlockId !== null && !hex64.test(source.previousBlockId)
        || source.selectionId !== null && !/^h45srcsel1:[0-9a-f]{64}$/.test(source.selectionId)
        || !/^h45actionadmission1:[0-9a-f]{64}$/.test(value.admissionId)
        || !Number.isSafeInteger(value.traceOrdinal) || value.traceOrdinal < 0 || value.traceOrdinal > 0xffffffff)
        throw new Error('Invalid observed child source claim');
    return {admissionId: value.admissionId, traceOrdinal: value.traceOrdinal,
        source: {chainId: source.chainId, blockNum: source.blockNum, blockId: source.blockId,
            previousBlockId: source.previousBlockId, selectionId: source.selectionId}};
}

/** Explicit internal injection. Copies only bounded encoded data; it never waits for diagnostic delivery. */
export class WorkerProofDemandObserver {
    private readonly limits: Readonly<Limits>;
    private readonly receipts = new Set<string>();
    private readonly boundReceipts = new Set<string>();
    private reservedCopies = 0;
    private inFlightEnvelopes = 0;
    private omitted = 0;
    private unknownHeaders = 0;
    private failures = 0;
    private knownPayloadBytes = 0;
    private knownHeaderBytes = 0;
    private omittedKnownPayloadBytes = 0;
    private unknownOmittedHeaderCopies = 0;
    constructor(private readonly emit: (packet: string, done: (error?: Error | null) => void) => unknown,
                input: Limits = {maximumReceipts: 64, maximumBytes: 1024 * 1024}) {this.limits = limits(input);}
    private send(make: () => unknown): void {
        // Conservative bounded space for header encoding, hex fields, JSON and an overlapping IPC copy.
        // This is encoded-copy headroom, not a heap/RSS or native IPC framing measurement.
        const reservation = maximumMessageBytes * 4;
        if (reservation > this.limits.maximumBytes - this.reservedCopies - this.receipts.size * workerReceiptMetadataBytes) {this.omitted = increment(this.omitted); return;}
        this.reservedCopies += reservation;
        let packet: string;
        try {
            packet = JSON.stringify(make());
            if (Buffer.byteLength(packet) > maximumMessageBytes) throw new Error('Diagnostic envelope exceeds lifecycle message cap');
        } catch {this.failures = increment(this.failures); this.reservedCopies -= reservation; return;}
        const envelopeBytes = Buffer.byteLength(packet); this.inFlightEnvelopes += envelopeBytes;
        let ended = false;
        const done = (error?: Error | null) => {
            if (ended) return; ended = true;
            if (error) {this.failures = increment(this.failures); return;} // Unknown transport remains charged; no timeout release.
            this.reservedCopies -= reservation; this.inFlightEnvelopes -= envelopeBytes;
        };
        try {
            const returned = this.emit(packet, done);
            if (isPromise(returned)) Promise.prototype.then.call(returned, () => {}, () => done(new Error('Async diagnostic failure')));
        } catch {done(new Error('Diagnostic dispatch unavailable'));}
    }
    capture(receiptId: string, payload: Uint8Array, headers: unknown): void {
        try {
            const length = bytes(payload);
            if (!uuid.test(receiptId) || length < 1 || this.receipts.has(receiptId)) throw new Error('Invalid or repeated receipt');
            if (this.receipts.size >= this.limits.maximumReceipts || length * 2 + 512 > maximumMessageBytes
                || workerReceiptMetadataBytes > this.limits.maximumBytes - this.reservedCopies - this.receipts.size * workerReceiptMetadataBytes) {
                this.omitted = increment(this.omitted); this.omittedKnownPayloadBytes = Math.min(Number.MAX_SAFE_INTEGER, this.omittedKnownPayloadBytes + length);
                this.unknownOmittedHeaderCopies = increment(this.unknownOmittedHeaderCopies); return;
            }
            this.receipts.add(receiptId); this.knownPayloadBytes = Math.min(Number.MAX_SAFE_INTEGER, this.knownPayloadBytes + length);
            let measuredHeaders = false;
            this.send(() => {
                let encoded: Buffer | null = null;
                try {if (headers !== undefined) encoded = captureProofDemandHeaders(headers, Math.floor((maximumMessageBytes - 512 - length * 2) / 2));}
                catch {} // Missing or unsupported headers are explicitly unknown, never {}.
                measuredHeaders = true;
                if (encoded === null) this.unknownHeaders = increment(this.unknownHeaders);
                else this.knownHeaderBytes = Math.min(Number.MAX_SAFE_INTEGER, this.knownHeaderBytes + encoded.length);
                return {schemaVersion: 1, type: 'capture', receiptId, payloadHex: Buffer.from(payload).toString('hex'),
                    headersHex: encoded?.toString('hex') ?? null};
            });
            if (!measuredHeaders) this.unknownHeaders = increment(this.unknownHeaders);
        } catch {this.failures = increment(this.failures);}
    }
    bound(receiptId: string, source: Claim): void {
        try {
            if (!this.receipts.has(receiptId)) {this.omitted = increment(this.omitted); return;}
            if (this.boundReceipts.has(receiptId)) throw new Error('Repeated observed child binding');
            const observed = claim(source);
            this.boundReceipts.add(receiptId);
            this.send(() => ({schemaVersion: 1, type: 'binding', receiptId, ...observed}));
        } catch {this.failures = increment(this.failures);}
    }
    snapshot() {return Object.freeze({observationOnly: true, receipts: this.receipts.size, reservedEncodedCopyBytes: this.reservedCopies,
        inFlightEnvelopeBytes: this.inFlightEnvelopes, knownCapturedPayloadBytes: this.knownPayloadBytes,
        reservedMetadataBytes: this.receipts.size * workerReceiptMetadataBytes,
        knownCapturedHeaderBytes: this.knownHeaderBytes,
        omittedKnownPayloadBytes: this.omittedKnownPayloadBytes, unknownHeaders: this.unknownHeaders,
        unknownOmittedHeaderCopies: this.unknownOmittedHeaderCopies,
        omitted: this.omitted, failures: this.failures, limits: {...this.limits}});}
}

interface Receipt {
    peer: PhysicalAttemptWorker; receiptId: string; registration?: WorkerAttemptObservationDescription;
    binding?: WorkerAttemptObservationDescription; childClaim?: Claim;
    payload?: Buffer; headers?: Buffer | null; ended: boolean; enrolled: boolean; unavailable: boolean;
}
/** Finite parent observation window. Authenticated owner metadata is not canonical source authority. */
export class ActionProofDemandEnrollment {
    private readonly limits: Readonly<Limits>;
    private readonly receipts = new Map<string, Receipt>();
    private retainedBytes = 0;
    private failures = 0;
    private omitted = 0;
    private late = 0;
    constructor(private readonly supervisor: WorkerAttemptSupervisor, private readonly accounting: ActionProofDemandShadow,
                input: Limits = {maximumReceipts: 64, maximumBytes: 1024 * 1024}) {this.limits = limits(input);}
    private receipt(peer: PhysicalAttemptWorker, receiptId: string): Receipt {
        if (!uuid.test(receiptId)) throw new Error('Invalid receipt identity');
        let entry = this.receipts.get(receiptId);
        if (entry) {if (entry.peer !== peer) throw new Error('Receipt belongs to another physical process'); return entry;}
        if (this.receipts.size >= this.limits.maximumReceipts
            || parentReceiptMetadataBytes > this.limits.maximumBytes - this.retainedBytes - this.receipts.size * parentReceiptMetadataBytes) {
            this.omitted = increment(this.omitted); throw new Error('Receipt window full');
        }
        entry = {peer, receiptId, ended: false, enrolled: false, unavailable: false}; this.receipts.set(receiptId, entry); return entry;
    }
    observe(token: WorkerAttemptObservation): void {
        try {
            const value = consumeWorkerAttemptObservation(this.supervisor, token);
            if (value.role !== 'ds_pool_worker' || value.descriptor.kind !== 'ds-delivery') return;
            const entry = this.receipt(value.worker, value.descriptor.receiptId);
            if (value.phase === 'ended') {entry.ended = true; return;}
            if (entry.ended) {entry.unavailable = true; this.late = increment(this.late); return;}
            if (value.phase === 'registered') {
                if (entry.registration) throw new Error('Repeated original registration observation');
                entry.registration = value;
            } else entry.binding = value;
            this.join(entry);
        } catch {this.failures = increment(this.failures);}
    }
    receive(peer: PhysicalAttemptWorker, packet: string): void {
        try {
            if (typeof packet !== 'string' || packet.length > maximumMessageBytes || Buffer.byteLength(packet) > maximumMessageBytes)
                throw new Error('Diagnostic packet exceeds lifecycle message cap');
            const packetBytes = Buffer.byteLength(packet);
            if (packetBytes > this.limits.maximumBytes - this.retainedBytes - this.receipts.size * parentReceiptMetadataBytes) {this.omitted = increment(this.omitted); return;}
            const value = JSON.parse(packet);
            if (value.schemaVersion !== 1 || !['capture','binding'].includes(value.type)) throw new Error('Unknown diagnostic packet');
            const entry = this.receipt(peer, value.receiptId);
            if (entry.ended) {entry.unavailable = true; this.late = increment(this.late);}
            if (value.type === 'capture') {
                if (entry.payload || typeof value.payloadHex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value.payloadHex)
                    || value.headersHex !== null && (typeof value.headersHex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value.headersHex)))
                    throw new Error('Invalid or repeated captured bytes');
                const size = value.payloadHex.length / 2 + (value.headersHex?.length ?? 0) / 2;
                if (size + packetBytes > this.limits.maximumBytes - this.retainedBytes - this.receipts.size * parentReceiptMetadataBytes) {
                    entry.unavailable = true; this.omitted = increment(this.omitted); return;
                }
                // Envelope and aggregate bounds precede decoding/allocation; V8 header data is never deserialized here.
                entry.payload = Buffer.from(value.payloadHex, 'hex'); entry.headers = value.headersHex === null ? null : Buffer.from(value.headersHex, 'hex');
                this.retainedBytes += size;
            } else {
                if (entry.childClaim) throw new Error('Repeated child binding claim');
                entry.childClaim = claim(value);
            }
            this.join(entry);
        } catch {this.failures = increment(this.failures);}
    }
    private join(entry: Receipt): void {
        if (entry.enrolled || entry.ended || entry.unavailable || !entry.registration || !entry.binding || !entry.childClaim || !entry.payload) return;
        const original = entry.registration, binding = entry.binding.binding, observed = entry.childClaim;
        if (!original.isActive() || !entry.binding.isActive()
            || original.owner.epoch !== entry.binding.owner.epoch || original.owner.incarnation !== entry.binding.owner.incarnation
            || original.owner.attemptId !== entry.binding.owner.attemptId || hash(entry.payload) !== original.descriptor.payloadSha256
            || entry.headers && hash(entry.headers) !== original.descriptor.headersSha256
            || binding.admissionId !== observed.admissionId || binding.traceOrdinal !== observed.traceOrdinal
            || binding.blockNum !== observed.source.blockNum || binding.blockId !== observed.source.blockId
            || (binding.selectionId ?? null) !== observed.source.selectionId) {entry.unavailable = true; throw new Error('Captured receipt/binding mismatch');}
        entry.enrolled = this.accounting.retainEncoded({...observed, owner: original.owner, payload: entry.payload,
            headerBytes: entry.headers ?? null, stage: 'ds-input'}) !== undefined;
        if (!entry.enrolled) entry.unavailable = true;
    }
    snapshot() {
        const accounting = this.accounting.snapshot();
        const unbound = [...this.receipts.values()].filter(entry => !entry.enrolled);
        const unknownCapturedPayloads = [...this.receipts.values()].filter(entry => !entry.payload).length;
        const unboundKnownBytes = unbound.reduce((sum, entry) => sum + (entry.payload?.length ?? 0) + (entry.headers?.length ?? 0), 0);
        return Object.freeze({observationOnly: true, canonicalAuthority: false, retainedCaptureBytes: this.retainedBytes,
            reservedMetadataBytes: this.receipts.size * parentReceiptMetadataBytes,
            scope: 'DS-input observations only; other pipeline stages and native/heap copies remain unmeasured',
            coverage: this.failures || this.omitted || this.late || unbound.length || accounting.accounting === 'incomplete' ? 'incomplete' : 'observed-window',
            receiptCustodyCount: this.receipts.size, unboundCustodyCount: unbound.length, unknownCapturedPayloads,
            unboundKnownBytes, semanticCustodyKnownBytesLowerBound: unboundKnownBytes + accounting.knownPendingBytes,
            failures: this.failures, omitted: this.omitted, late: this.late, limits: {...this.limits},
            receipts: [...this.receipts.values()].map(entry => ({receiptId: entry.receiptId,
                phase: entry.enrolled ? 'child-binding-observed' : entry.registration ? 'registered-custody' : 'receipt-process-custody',
                owner: entry.registration ? {...entry.registration.owner} : null,
                sourceClaim: entry.childClaim ? {source: {...entry.childClaim.source}, admissionId: entry.childClaim.admissionId, traceOrdinal: entry.childClaim.traceOrdinal} : null,
                payloadBytes: entry.payload?.length ?? null, headerBytes: entry.headers === null ? null : entry.headers?.length ?? null,
                ended: entry.ended, enrolled: entry.enrolled, unavailable: entry.unavailable})), accounting});
    }
}
