import {createHash} from 'node:crypto';
import {actionHistoryImmutableJson} from './action-history-manifest.js';
import {ActionSourceAdmissionStore, type ActionAttemptAssociation} from './action-source-admission.js';
import {ProtocolSourceBindingStore, type ProtocolSourcePosition} from '../protocol/source-bindings.js';
import {describeWorkerAttemptEnd, type AcceptedWorkerAttemptEnd, type WorkerAttemptSupervisor,
    type WorkerAttemptEndDescription} from '../protocol/worker-attempt-supervisor.js';
import type {FreshActionWrite} from './action-fresh-write.js';

const sha = (value: unknown) => createHash('sha256').update(actionHistoryImmutableJson(value)).digest('hex');
const shaBytes = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown) => actionHistoryImmutableJson(left) === actionHistoryImmutableJson(right);

export interface CurrentAttemptAuthority {
    configurationSha256(): string;
    canonicalBlock(blockNum: number): Promise<{chainId: string; blockId: string; previousBlockId: string | null;
        irreversible: boolean}>;
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
    constructor(private readonly supervisor: WorkerAttemptSupervisor, private readonly store: ActionSourceAdmissionStore,
                private readonly selections: ProtocolSourceBindingStore, private readonly current: CurrentAttemptAuthority) {}

    /** The supervisor's synchronous callback only queues work; storage and RPC stay off its mutation lane. */
    enqueue(evidence: AcceptedWorkerAttemptEnd): void {
        const end = describeWorkerAttemptEnd(this.supervisor, evidence);
        if (end.role === 'projection' || !end.binding.admissionId && !end.binding.selectionId && !end.freshWrites.length) return;
        if (this.pending.length >= 256) {this.dropped++; return;}
        this.pending.push(evidence); queueMicrotask(() => this.drain());
    }
    snapshot() {return Object.freeze({active: this.active, pending: this.pending.length, failures: this.failures, dropped: this.dropped});}
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
        if (this.current.configurationSha256() !== admission.source.producer.configurationSha256
            || await this.current.targetUuid(admission.target.name) !== admission.target.uuid) return {state: 'unresolved'};
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
        const persisted = await this.store.recordAttemptAssociation(this.supervisor, evidence, {results, sourceChecked: true});
        return {state: 'associated', id: persisted.id};
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
