import {createHash} from 'node:crypto';
import {actionHistoryImmutableJson} from './action-history-manifest.js';
import {ActionSourceAdmissionStore, type ActionAttemptAssociation} from './action-source-admission.js';
import {ProtocolSourceBindingStore, type ProtocolSourcePosition} from '../protocol/source-bindings.js';
import {describeWorkerAttemptEnd, type AcceptedWorkerAttemptEnd, type WorkerAttemptSupervisor,
    type WorkerAttemptEndDescription} from '../protocol/worker-attempt-supervisor.js';
import type {FreshActionWrite} from './action-fresh-write.js';
import {isPromise} from 'node:util/types';
import type {VerifiedActionDsTransition, VerifiedActionDsTransitionDescription} from './action-proof-demand.js';

const sha = (value: unknown) => createHash('sha256').update(actionHistoryImmutableJson(value)).digest('hex');
const shaBytes = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown) => actionHistoryImmutableJson(left) === actionHistoryImmutableJson(right);
interface TransitionOrigin {
    issuer: ActionAttemptAdjudicator; description: VerifiedActionDsTransitionDescription;
    active: boolean; consumed: boolean; current: () => void; finalized?: (accepted: boolean) => void;
}
const transitions = new WeakMap<VerifiedActionDsTransition, TransitionOrigin>();
const increment = (value: number) => value === Number.MAX_SAFE_INTEGER ? value : value + 1;
const freeze = <T>(value: T): T => {
    if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);}
    return value;
};

export interface ActionAttemptAdjudicatorOptions {
    /** Synchronous, engineering-injected observation. It grants no processing or capacity authority. */
    readonly onVerifiedDsTransition?: (transition: VerifiedActionDsTransition) => void;
}

export interface CurrentAttemptCanonicalBlock {
    readonly chainId: string;
    readonly blockId: string;
    readonly previousBlockId: string | null;
    readonly irreversible: boolean;
}

export interface CurrentAttemptAuthority {
    configurationSha256(): string;
    canonicalBlock(blockNum: number): Promise<CurrentAttemptCanonicalBlock>;
    /** Revalidate the original process-local observation after later I/O; JSON cannot reissue it. */
    assertCanonicalCurrent(block: CurrentAttemptCanonicalBlock): void;
    /** Source-selected reversible input needs current physical SHIP/coordinator authority. */
    reversibleSelection?(selectionId: string, source: ProtocolSourcePosition, readerSessionId: string): Promise<boolean>;
    targetUuid(name: string): Promise<string>;
}

/** Private post-end association. It never releases reader credits or certifies broker ACK settlement. */
export class ActionAttemptAdjudicator {
    private readonly pending: AcceptedWorkerAttemptEnd[] = [];
    private active = 0;
    private failures = 0;
    private dropped = 0;
    private readonly transitioned = new WeakSet<AcceptedWorkerAttemptEnd>();
    private transitionEmitted = 0;
    private transitionConsumed = 0;
    private transitionFailures = 0;
    private transitionUnconsumed = 0;
    constructor(private readonly supervisor: WorkerAttemptSupervisor, private readonly store: ActionSourceAdmissionStore,
                private readonly selections: ProtocolSourceBindingStore, private readonly current: CurrentAttemptAuthority,
                private readonly options: ActionAttemptAdjudicatorOptions = {}) {}

    /** The supervisor's synchronous callback only queues work; storage and RPC stay off its mutation lane. */
    enqueue(evidence: AcceptedWorkerAttemptEnd): void {
        const end = describeWorkerAttemptEnd(this.supervisor, evidence);
        if (end.role === 'projection' || !end.binding.admissionId && !end.binding.selectionId && !end.freshWrites.length) return;
        if (this.pending.length >= 256) {this.dropped++; return;}
        this.pending.push(evidence); queueMicrotask(() => this.drain());
    }
    snapshot() {return Object.freeze({active: this.active, pending: this.pending.length, failures: this.failures, dropped: this.dropped});}
    transitionSnapshot() {return Object.freeze({emitted: this.transitionEmitted, consumed: this.transitionConsumed,
        failures: this.transitionFailures, unconsumed: this.transitionUnconsumed,
        incomplete: this.transitionFailures > 0 || this.transitionUnconsumed > 0, observationOnly: true as const});}

    /** A token is consumable only once, by its issuer, inside its original synchronous callback. */
    consumeVerifiedDsTransition(token: VerifiedActionDsTransition, finalized?: (accepted: boolean) => void): VerifiedActionDsTransitionDescription {
        const issued = transitions.get(token);
        if (!issued || issued.issuer !== this || !issued.active || issued.consumed)
            throw new Error('Unissued, foreign, expired or consumed DS transition');
        if (finalized !== undefined && typeof finalized !== 'function') throw new Error('Invalid DS transition finalizer');
        issued.current(); issued.consumed = true; issued.finalized = finalized; this.transitionConsumed = increment(this.transitionConsumed);
        return issued.description;
    }
    private drain(): void {
        while (this.active < 4 && this.pending.length) {
            const evidence = this.pending.shift()!; this.active++;
            void this.adjudicate(evidence).catch(() => {this.failures++;}).finally(() => {this.active--; this.drain();});
        }
    }

    async adjudicate(evidence: AcceptedWorkerAttemptEnd): Promise<{state: 'associated'; id: string} | {state: 'unresolved'}> {
        const end = describeWorkerAttemptEnd(this.supervisor, evidence);
        if (end.status !== 'quiescent' || end.rootResult !== 'returned' || end.acknowledgementAttempted !== true
            || end.freshWriteOverflow || end.descriptor.headersSha256 === null || !end.binding.admissionId
            || end.freshWrites.length === 0) return {state: 'unresolved'};
        const admission = await this.store.resolve(end.binding.admissionId);
        const source = admission.source.inventoryInput.source;
        if (end.binding.blockNum !== source.blockNum || end.binding.blockId !== source.blockId
            || end.binding.planId !== admission.planId || end.binding.targetName !== admission.target.name
            || end.binding.targetUuid !== admission.target.uuid || end.binding.configurationSha256 !== admission.source.producer.configurationSha256
            || end.descriptor.kind !== (end.role === 'deserializer' ? 'source-delivery' : 'ds-delivery')
            || (end.role === 'deserializer' && end.binding.ingressId !== admission.source.ingressId))
            return {state: 'unresolved'};
        const originalPayload = end.role === 'deserializer'
            ? Buffer.from(admission.source.frameHex, 'hex')
            : admission.inventory?.transactions.find(value => value.traceOrdinal === end.binding.traceOrdinal)?.dispatch?.canonicalJson;
        if (!originalPayload || shaBytes(typeof originalPayload === 'string' ? Buffer.from(originalPayload) : originalPayload)
            !== end.descriptor.payloadSha256) return {state: 'unresolved'};
        const results: ActionAttemptAssociation['results'][number][] = [];
        for (const write of end.freshWrites) {
            const result = await this.verifyWrite(end, write, admission);
            if (!result) return {state: 'unresolved'};
            results.push(result);
        }
        if (!await this.currentProducerMatches(admission)) return {state: 'unresolved'};
        const block = await this.current.canonicalBlock(source.blockNum);
        if (block.chainId !== source.chainId || block.blockId !== source.blockId
            || (admission.source.previousBlockId !== null && block.previousBlockId !== admission.source.previousBlockId))
            return {state: 'unresolved'};
        const selected = admission.source.inventoryInput.sourceSelectionId;
        let selectedReaderSessionId: string | undefined;
        if (selected) {
            if (end.binding.selectionId !== selected) return {state: 'unresolved'};
            const {selection} = await this.selections.readSelection(selected);
            if (selection.source.chainId !== source.chainId || selection.source.blockNum !== source.blockNum
                || selection.source.blockId !== source.blockId
                || (admission.source.previousBlockId !== null && selection.source.previousBlockId !== admission.source.previousBlockId)
                || selection.captureSha256 !== admission.source.captureSha256
                || (end.binding.readerSessionId && end.binding.readerSessionId !== selection.readerSessionId)) return {state: 'unresolved'};
            selectedReaderSessionId = selection.readerSessionId;
        } else if (end.binding.selectionId) return {state: 'unresolved'};
        if (!block.irreversible && (!selected || !selectedReaderSessionId || !this.current.reversibleSelection
            || !await this.current.reversibleSelection(selected, {chainId: source.chainId, blockNum: source.blockNum,
                blockId: source.blockId, previousBlockId: admission.source.previousBlockId}, selectedReaderSessionId)))
            return {state: 'unresolved'};
        this.current.assertCanonicalCurrent(block);
        if (!await this.currentProducerMatches(admission)) return {state: 'unresolved'};
        this.current.assertCanonicalCurrent(block);
        const persisted = await this.store.recordAttemptAssociation(this.supervisor, evidence, {results, sourceChecked: true});
        this.current.assertCanonicalCurrent(block);
        if (!await this.currentProducerMatches(admission)) return {state: 'unresolved'};
        this.current.assertCanonicalCurrent(block);
        this.observeDsTransition(evidence, end, admission, originalPayload, results, block);
        return {state: 'associated', id: persisted.id};
    }

    private observeDsTransition(evidence: AcceptedWorkerAttemptEnd, end: WorkerAttemptEndDescription,
                                admission: Awaited<ReturnType<ActionSourceAdmissionStore['resolve']>>,
                                payload: string | Uint8Array, results: ActionAttemptAssociation['results'], block: CurrentAttemptCanonicalBlock): void {
        if (end.role !== 'ds_pool_worker' || this.transitioned.has(evidence)) return;
        try {
            const observer = this.options.onVerifiedDsTransition;
            if (observer === undefined) return;
            if (typeof observer !== 'function') throw new Error('DS transition observer is unavailable');
            this.transitioned.add(evidence);
            const source = admission.source.inventoryInput.source;
            const description: VerifiedActionDsTransitionDescription = freeze(JSON.parse(actionHistoryImmutableJson({
                owner: {epoch: end.epoch, incarnation: end.incarnation, attemptId: end.attemptId},
                source: {chainId: source.chainId, blockNum: source.blockNum, blockId: source.blockId, previousBlockId: admission.source.previousBlockId,
                    selectionId: admission.source.inventoryInput.sourceSelectionId ?? null},
                admissionId: admission.id, sourceId: admission.sourceId, planId: admission.planId, traceOrdinal: end.binding.traceOrdinal,
                payloadSha256: end.descriptor.payloadSha256, payloadBytes: typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength,
                headersSha256: end.descriptor.headersSha256, configurationSha256: end.binding.configurationSha256,
                target: admission.target, results, stage: 'ds-input', brokerSettlement: 'unknown', observationOnly: true,
            }, 64 * 1024)));
            const token = Object.freeze({}) as VerifiedActionDsTransition;
            const issued: TransitionOrigin = {issuer: this, description, active: true, consumed: false, current: () => {
                this.current.assertCanonicalCurrent(block);
                if (this.current.configurationSha256() !== description.configurationSha256) throw new Error('DS transition configuration changed');
                this.current.assertCanonicalCurrent(block);
            }};
            transitions.set(token, issued); this.transitionEmitted = increment(this.transitionEmitted);
            let accepted = false;
            try {
                const returned: unknown = observer.call(this.options, token);
                if (returned !== undefined) {
                    // Observe native rejection without awaiting it or reading an opaque then getter.
                    if (isPromise(returned)) Promise.prototype.then.call(returned, () => {}, () => {});
                    throw new Error('DS transition observer must return synchronously without a value');
                }
                accepted = true;
            } finally {
                issued.active = false;
                if (!issued.consumed) this.transitionUnconsumed = increment(this.transitionUnconsumed);
                try {if (accepted) issued.current();}
                catch (error) {accepted = false; throw error;}
                finally {
                    try {issued.finalized?.(accepted);}
                    finally {transitions.delete(token);}
                }
            }
        } catch {this.transitionFailures = increment(this.transitionFailures);}
    }

    private async currentProducerMatches(admission: Awaited<ReturnType<ActionSourceAdmissionStore['resolve']>>): Promise<boolean> {
        const expected = admission.source.producer.configurationSha256;
        if (this.current.configurationSha256() !== expected) return false;
        const target = await this.current.targetUuid(admission.target.name);
        return target === admission.target.uuid && this.current.configurationSha256() === expected;
    }

    private async verifyWrite(end: WorkerAttemptEndDescription, write: FreshActionWrite,
                              admission: Awaited<ReturnType<ActionSourceAdmissionStore['resolve']>>):
        Promise<ActionAttemptAssociation['results'][number] | null> {
        let record: any, work: any, classification: ActionAttemptAssociation['results'][number]['classification'];
        if (write.kind === 'confirmed-handoff') {
            if (end.role !== 'ds_pool_worker' || end.binding.traceOrdinal === undefined) return null;
            const transaction = admission.inventory?.transactions.find(value => value.traceOrdinal === end.binding.traceOrdinal);
            if (!transaction?.dispatch) return null;
            const observed = await this.store.readConfirmedHandoff(admission.id, end.binding.traceOrdinal,
                Buffer.from(transaction.dispatch.canonicalJson));
            if (observed.id !== write.id) return null;
            record = observed.outcome; work = record.work; classification = 'confirmed-handoff';
        } else if (write.kind === 'attempt-disposition') {
            const observed = await this.store.readAttemptDisposition(write.id);
            record = observed.observation; work = record.work;
            if (end.role === 'deserializer' ? work.stage !== 'main-source' : work.stage !== 'ds-transaction') return null;
            classification = record.disposition === 'no-effects' || record.disposition === 'policy-excluded'
                ? 'intentional-no-effect' : record.disposition === 'operator-disabled' ? 'intentional-suppression'
                : record.disposition === 'source-unprocessable' ? 'source-incomplete'
                : record.disposition === 'contract-output-incomplete' ? 'contract-incomplete' : 'raw-incomplete';
        } else return null;
        if (write.kind === 'attempt-disposition') {
            const source = admission.source;
            const ordinal = work.transaction?.traceOrdinal;
            const transaction = ordinal === undefined ? undefined
                : admission.inventory?.transactions.find(value => value.traceOrdinal === ordinal);
            if (ordinal !== undefined && !transaction || end.role === 'ds_pool_worker'
                && (ordinal === undefined || ordinal !== end.binding.traceOrdinal)) return null;
            const expected = {stage: end.role === 'deserializer' ? 'main-source' : 'ds-transaction',
                admissionId: admission.id, sourceId: admission.sourceId, ingressId: source.ingressId,
                source: {chainId: source.inventoryInput.source.chainId, blockNum: source.inventoryInput.source.blockNum,
                    blockId: source.inventoryInput.source.blockId, previousBlockId: source.previousBlockId,
                    captureSha256: source.captureSha256},
                sourceSelectionId: source.inventoryInput.sourceSelectionId ?? null, producer: source.producer,
                executableSha256: source.executableSha256,
                policySha256: admission.inventory?.policySha256 ?? sha(source.inventoryInput.policy),
                target: admission.target, planId: admission.planId,
                transaction: transaction ? {transactionId: transaction.transactionId, traceOrdinal: transaction.traceOrdinal,
                    traceSha256: transaction.traceSha256, dispatchSha256: transaction.dispatch?.bodySha256 ?? null,
                    expectedGroups: transaction.groups.length} : null};
            if (!same(work, expected)) return null;
        }
        if (classification !== write.classification || sha(record) !== write.recordSha256
            || sha(work) !== write.workSha256 || work.admissionId !== admission.id
            || work.sourceId !== admission.sourceId || work.planId !== admission.planId
            || !same(work.target, admission.target) || work.producer.configurationSha256 !== end.binding.configurationSha256
            || work.source.blockNum !== end.binding.blockNum || work.source.blockId !== end.binding.blockId
            || work.sourceSelectionId !== (admission.source.inventoryInput.sourceSelectionId ?? null)
            || (end.role === 'ds_pool_worker' && work.traceOrdinal !== undefined && work.traceOrdinal !== end.binding.traceOrdinal)
            || (end.role === 'ds_pool_worker' && work.transaction?.traceOrdinal !== undefined
                && work.transaction.traceOrdinal !== end.binding.traceOrdinal)) return null;
        return {id: write.id, classification};
    }
}
