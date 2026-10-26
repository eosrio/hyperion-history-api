import type {ActionAttemptAssociation} from './action-source-admission.js';
import {createHash} from 'node:crypto';
import {serialize} from 'node:v8';
import {ActionAttemptAdjudicator} from './action-attempt-adjudicator.js';
import {workerAttemptJson} from '../protocol/worker-attempt-supervisor.js';

declare const verifiedTransitionBrand: unique symbol;
/** Host-local observation only; JSON cannot recreate its issuer or scope. */
export interface VerifiedActionDsTransition {readonly [verifiedTransitionBrand]: true}

export interface VerifiedActionDsTransitionDescription {
    readonly owner: {readonly epoch: string; readonly incarnation: string; readonly attemptId: string};
    readonly source: {readonly chainId: string; readonly blockNum: number; readonly blockId: string;
        readonly previousBlockId: string | null; readonly selectionId: string | null};
    readonly admissionId: string;
    readonly sourceId: string;
    readonly planId: string | null;
    readonly traceOrdinal: number;
    readonly payloadSha256: string;
    readonly payloadBytes: number;
    readonly headersSha256: string;
    readonly configurationSha256: string;
    readonly target: {readonly name: string; readonly uuid: string};
    readonly results: ActionAttemptAssociation['results'];
    readonly stage: 'ds-input';
    readonly brokerSettlement: 'unknown';
    readonly observationOnly: true;
}

export type ActionProofDemandStage = 'ds-input' | 'retained-copy' | 'downstream' | 'recovery';
declare const shadowDemandBrand: unique symbol;
export interface ShadowActionProofDemand {readonly [shadowDemandBrand]: true}
export interface ActionProofDemandInput {
    readonly owner: VerifiedActionDsTransitionDescription['owner'];
    readonly source: VerifiedActionDsTransitionDescription['source'];
    readonly admissionId: string;
    readonly traceOrdinal: number;
    readonly payload: Uint8Array;
    /** Bounded captured typed headers, encoded exactly as the original worker's header digest. Missing is unknown. */
    readonly headers?: unknown;
    readonly stage: ActionProofDemandStage;
    readonly copyId?: string;
}
interface DemandRecord {
    owner: ActionProofDemandInput['owner']; source: ActionProofDemandInput['source'];
    admissionId: string; traceOrdinal: number; stage: ActionProofDemandStage; copyId: string;
    payloadBytes: number; payloadSha256: string; headersBytes: number | null; headersSha256: string | null;
    state: 'pending' | 'uncertain' | 'resolved'; classifications: Array<ActionAttemptAssociation['results'][number]['classification']>;
}
const stages: readonly ActionProofDemandStage[] = ['ds-input', 'retained-copy', 'downstream', 'recovery'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const count = (value: number) => value === Number.MAX_SAFE_INTEGER ? value : value + 1;
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const typedByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
function capturedByteLength(value: Uint8Array): number {
    // Overridden layouts are unsupported observations; do not execute their getters or serialize them.
    if (['byteLength', 'byteOffset', 'buffer', 'length', 'constructor'].some(name => Object.hasOwn(value, name)))
        throw new Error('Overridden captured byte layout');
    return typedByteLength.call(value);
}
const key = (value: Pick<DemandRecord, 'owner' | 'source' | 'admissionId' | 'traceOrdinal' | 'stage' | 'copyId'>) =>
    workerAttemptJson([value.owner, value.source, value.admissionId, value.traceOrdinal, value.stage, value.copyId]);

function capturedHeaders(headers: unknown): Buffer {
    let bytes = 0, nodes = 0; const seen = new Set<object>();
    const add = (amount: number) => {bytes += amount; if (bytes > 64 * 1024) throw new Error('Shadow header byte bound exceeded');};
    const visit = (value: unknown, depth: number): void => {
        if (++nodes > 4096 || depth > 32) throw new Error('Shadow header structure bound exceeded');
        add(32);
        if (typeof value === 'string') {if (value.length > 64 * 1024) throw new Error('Shadow header string excessive'); add(Buffer.byteLength(value)); return;}
        // Finite shadow encoding range, not a widening of AMQP's accepted scalar types.
        if (typeof value === 'bigint') {
            if (value < -0x8000000000000000n || value > 0xffffffffffffffffn) throw new Error('Shadow bigint exceeds 64-bit range');
            return;
        }
        if (value == null || ['number', 'boolean', 'undefined'].includes(typeof value)) return;
        if (value instanceof Uint8Array) {add(capturedByteLength(value)); return;}
        if (value instanceof Date) return;
        if (typeof value !== 'object' || seen.has(value)) throw new Error('Shadow headers are not bounded typed data');
        const prototype = Object.getPrototypeOf(value);
        if (Array.isArray(value) ? value.length > 4096 : prototype !== Object.prototype && prototype !== null)
            throw new Error('Unsupported shadow header shape');
        seen.add(value);
        for (const name in value) if (Object.hasOwn(value, name)) {
            add(name.length * 3); const property = Object.getOwnPropertyDescriptor(value, name);
            if (!property || !Object.hasOwn(property, 'value')) throw new Error('Shadow header accessor unavailable');
            visit(property.value, depth + 1);
        }
        seen.delete(value);
    };
    visit(headers, 0);
    const encoded = serialize(headers);
    if (encoded.length > 64 * 1024) throw new Error('Shadow encoded headers excessive');
    return encoded;
}

/** Finite engineering observation window. No enrollment, veto, proof, ACK or reader-credit authority.
 * Completed identities retain a bounded dedup slot; overflow is explicit, never eviction of uncertainty.
 * Charges describe only supplied encoded payload/header copies, never heap/RSS or all pipeline stages.
 */
export class ActionProofDemandShadow {
    private readonly records = new Map<string, DemandRecord>();
    private incomplete = false;
    private rejectedRetains = 0;
    private omittedDemands = 0;
    private omittedKnownBytesLowerBound = 0;
    private omittedBytesSaturated = false;
    private unknownOmittedPayloads = 0;
    private unknownOmittedHeaderCopies = 0;
    private rejectedTransitions = 0;
    private unavailableTransitions = 0;
    private lastFailure: string | null = null;
    constructor(private readonly adjudicator: ActionAttemptAdjudicator,
                private readonly limits: {maximumDemands: number; maximumBytes: number}) {
        if (!(adjudicator instanceof ActionAttemptAdjudicator)
            || !Number.isSafeInteger(limits.maximumDemands) || limits.maximumDemands < 1 || limits.maximumDemands > 4096
            || !Number.isSafeInteger(limits.maximumBytes) || limits.maximumBytes < 1 || limits.maximumBytes > 128 * 1024 * 1024)
            throw new Error('Invalid bounded shadow accounting configuration');
        this.limits = Object.freeze({...limits});
    }
    private fail(reason: string): void {this.incomplete = true; this.lastFailure = reason;}
    private omit(input: ActionProofDemandInput, reason: string, headerBytes: number | null = null): void {
        this.omittedDemands = count(this.omittedDemands); this.fail(reason);
        const add = (bytes: number) => {
            if (bytes > Number.MAX_SAFE_INTEGER - this.omittedKnownBytesLowerBound) {
                this.omittedKnownBytesLowerBound = Number.MAX_SAFE_INTEGER; this.omittedBytesSaturated = true;
            } else this.omittedKnownBytesLowerBound += bytes;
        };
        try {
            const payload = Object.getOwnPropertyDescriptor(input, 'payload')?.value;
            if (!(payload instanceof Uint8Array)) throw new Error('Omitted bytes unavailable');
            const bytes = capturedByteLength(payload);
            if (!Number.isSafeInteger(bytes)) throw new Error('Omitted bytes unavailable');
            add(bytes);
        } catch {this.unknownOmittedPayloads = count(this.unknownOmittedPayloads);}
        if (headerBytes === null) this.unknownOmittedHeaderCopies = count(this.unknownOmittedHeaderCopies); else add(headerBytes);
    }
    private pendingBytes(): number {
        let bytes = 0;
        for (const record of this.records.values()) if (record.state !== 'resolved') bytes += record.payloadBytes + (record.headersBytes ?? 0);
        return bytes;
    }
    retain(input: ActionProofDemandInput): ShadowActionProofDemand | undefined {
        try {
            const owner = input.owner, source = input.source, copyId = input.copyId ?? 'original';
            if (![owner.epoch, owner.incarnation, owner.attemptId].every(value => uuid.test(value))
                || !digest.test(source.chainId) || !digest.test(source.blockId)
                || source.previousBlockId !== null && !digest.test(source.previousBlockId)
                || !Number.isSafeInteger(source.blockNum) || source.blockNum < 1 || source.blockNum > 0xffffffff
                || source.selectionId !== null && !/^h45srcsel1:[0-9a-f]{64}$/.test(source.selectionId)
                || !/^h45actionadmission1:[0-9a-f]{64}$/.test(input.admissionId)
                || !Number.isSafeInteger(input.traceOrdinal) || input.traceOrdinal < 0 || input.traceOrdinal > 0xffffffff
                || !stages.includes(input.stage) || typeof copyId !== 'string' || copyId.length < 1 || copyId.length > 128
                || input.stage === 'ds-input' && copyId !== 'original'
                || !(input.payload instanceof Uint8Array)) throw new Error('Invalid captured shadow demand');
            const payloadBytes = capturedByteLength(input.payload);
            if (payloadBytes < 1) throw new Error('Captured payload is empty');
            const captured = {owner: {epoch: owner.epoch, incarnation: owner.incarnation, attemptId: owner.attemptId},
                source: {chainId: source.chainId, blockNum: source.blockNum, blockId: source.blockId,
                    previousBlockId: source.previousBlockId, selectionId: source.selectionId},
                admissionId: input.admissionId, traceOrdinal: input.traceOrdinal, stage: input.stage, copyId};
            const identity = key(captured);
            if (this.records.has(identity)) {this.rejectedRetains = count(this.rejectedRetains); this.fail('duplicate-demand'); return;}
            if (this.records.size >= this.limits.maximumDemands) {this.omit(input, 'count-limit'); return;}
            if (payloadBytes > this.limits.maximumBytes) {this.omit(input, 'byte-limit'); return;}
            let headers: Buffer | null = null;
            try {
                const captured = Object.getOwnPropertyDescriptor(input, 'headers');
                if (captured && !Object.hasOwn(captured, 'value')) throw new Error('Captured header accessor unavailable');
                if (captured?.value !== undefined) headers = capturedHeaders(captured.value);
            } catch {this.fail('headers-unavailable');}
            const record: DemandRecord = {...captured,
                payloadBytes, payloadSha256: hash(input.payload),
                headersBytes: headers?.length ?? null, headersSha256: headers ? hash(headers) : null,
                state: 'pending', classifications: []};
            if (record.payloadBytes + (record.headersBytes ?? 0) > this.limits.maximumBytes - this.pendingBytes()) {
                this.omit(input, 'byte-limit', record.headersBytes); return;
            }
            this.records.set(identity, record);
            if (headers === null) this.fail('headers-unavailable');
            return Object.freeze({}) as ShadowActionProofDemand;
        } catch {this.rejectedRetains = count(this.rejectedRetains); this.omit(input, 'invalid-demand');}
    }
    observe(token: VerifiedActionDsTransition): void {
        let record: DemandRecord | undefined, description: VerifiedActionDsTransitionDescription;
        try {
            description = ActionAttemptAdjudicator.prototype.consumeVerifiedDsTransition.call(this.adjudicator, token, accepted => {
                if (!record) return;
                if (!accepted) {record.state = 'uncertain'; this.fail('observer-failed'); return;}
                record.classifications = description.results.map(value => value.classification);
                if (record.headersBytes === null || record.classifications.some(value => value !== 'confirmed-handoff' && value !== 'intentional-no-effect')) {
                    record.state = 'uncertain'; this.unavailableTransitions = count(this.unavailableTransitions); this.fail('stage-unavailable'); return;
                }
                record.state = 'resolved';
            });
            record = this.records.get(key({...description, stage: 'ds-input', copyId: 'original'}));
            if (!record || record.state !== 'pending' || record.payloadSha256 !== description.payloadSha256
                || record.payloadBytes !== description.payloadBytes
                || record.headersSha256 !== null && record.headersSha256 !== description.headersSha256) {
                record = undefined; this.rejectedTransitions = count(this.rejectedTransitions); this.fail('unmatched-transition');
            }
        } catch {this.rejectedTransitions = count(this.rejectedTransitions); this.fail('invalid-transition');}
    }
    snapshot() {
        const byStage = Object.fromEntries(stages.map(stage => [stage,
            {pendingDemands: 0, resolvedDemands: 0, knownPendingBytes: 0, unknownPendingHeaders: 0}])) as
            Record<ActionProofDemandStage, {pendingDemands: number; resolvedDemands: number; knownPendingBytes: number; unknownPendingHeaders: number}>;
        let pendingDemands = 0, resolvedDemands = 0, knownPendingBytes = 0, unknownPendingHeaders = 0;
        for (const value of this.records.values()) {
            const stage = byStage[value.stage];
            if (value.state === 'resolved') {resolvedDemands++; stage.resolvedDemands++;}
            else {
                pendingDemands++; stage.pendingDemands++;
                const bytes = value.payloadBytes + (value.headersBytes ?? 0); knownPendingBytes += bytes; stage.knownPendingBytes += bytes;
                if (value.headersBytes === null) {unknownPendingHeaders++; stage.unknownPendingHeaders++;}
            }
        }
        const transitionState = this.adjudicator.transitionSnapshot();
        return Object.freeze({observationOnly: true as const, accounting: this.incomplete || transitionState.incomplete ? 'incomplete' as const : 'complete' as const,
            limits: {...this.limits}, retainedDemands: this.records.size, pendingDemands, resolvedDemands, knownPendingBytes, unknownPendingHeaders,
            rejectedRetains: this.rejectedRetains, omittedDemands: this.omittedDemands, rejectedTransitions: this.rejectedTransitions,
            omittedKnownBytesLowerBound: this.omittedKnownBytesLowerBound, omittedBytesSaturated: this.omittedBytesSaturated,
            unknownOmittedPayloads: this.unknownOmittedPayloads, unknownOmittedHeaderCopies: this.unknownOmittedHeaderCopies,
            unavailableTransitions: this.unavailableTransitions, lastFailure: this.lastFailure, stages: byStage, transitions: transitionState,
            demands: [...this.records.values()].map(value => ({...value, owner: {...value.owner}, source: {...value.source}, classifications: [...value.classifications]}))});
    }
}
