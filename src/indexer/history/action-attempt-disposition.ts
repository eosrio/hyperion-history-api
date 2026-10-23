import {createHash} from 'node:crypto';
import type {ActionHistoryBlockPlan, ActionHistoryEffect} from './action-history-manifest.js';
import {actionHistoryImmutableJson} from './action-history-manifest.js';
import {canonicalUint64} from '../helpers/uint64.js';
import type {ActionPublicationOwner} from './action-confirmed-publication.js';

/** Private observed attempt evidence. Neither persisted observations nor reads grant settlement/capacity. */
export const actionAttemptDispositionBounds = Object.freeze({maximumRecords: 100_000, maximumBytes: 128 * 1024 * 1024,
    maximumHeaderBytes: 64 * 1024, maximumOperations: 4});
export type ActionAttemptReason = 'source-traces-missing' | 'source-predecessor-missing' | 'source-inventory-invalid'
    | 'policy-excluded' | 'no-effects' | 'empty-source-vector' | 'traces-disabled' | 'indexing-disabled'
    | 'contract-abi-invalid' | 'contract-finalization-invalid' | 'contract-grouping-invalid'
    | 'contract-output-not-portable' | 'raw-output-incomplete';
export interface ActionAttemptDisposition {
    readonly schemaVersion: 1; readonly kind: 'action-attempt-disposition';
    readonly work: {
        readonly stage: 'main-source' | 'ds-transaction'; readonly admissionId: string; readonly sourceId: string; readonly ingressId: string;
        readonly source: {chainId: string; blockNum: number; blockId: string; previousBlockId: string | null; captureSha256: string};
        readonly sourceSelectionId: string | null; readonly producer: ActionHistoryBlockPlan['producer'];
        readonly executableSha256: string; readonly policySha256: string; readonly target: ActionHistoryBlockPlan['target'];
        readonly planId: string | null;
        readonly transaction: null | {transactionId: string; traceOrdinal: number; traceSha256: string;
            dispatchSha256: string | null; expectedGroups: number};
    };
    readonly disposition: 'source-unprocessable' | 'policy-excluded' | 'no-effects' | 'operator-disabled'
        | 'contract-output-incomplete' | 'raw-incomplete-handoff';
    readonly reason: ActionAttemptReason;
    readonly output: {kind: 'unresolved'} | {kind: 'none-required'} | {kind: 'raw-incomplete'; fragmentId: string;
        effects: readonly {effect: ActionHistoryEffect; payloadSha256: string; headersSha256: string; status: 'complete' | 'incomplete'}[]};
}
const reasonKinds: Record<ActionAttemptReason, ActionAttemptDisposition['disposition']> = {
    'source-traces-missing': 'source-unprocessable', 'source-predecessor-missing': 'source-unprocessable', 'source-inventory-invalid': 'source-unprocessable',
    'policy-excluded': 'policy-excluded', 'no-effects': 'no-effects', 'empty-source-vector': 'no-effects',
    'traces-disabled': 'operator-disabled', 'indexing-disabled': 'operator-disabled',
    'contract-abi-invalid': 'contract-output-incomplete', 'contract-finalization-invalid': 'contract-output-incomplete',
    'contract-grouping-invalid': 'contract-output-incomplete', 'contract-output-not-portable': 'contract-output-incomplete',
    'raw-output-incomplete': 'raw-incomplete-handoff'};
const keys = (value: any, names: readonly string[]) => !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uint32 = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= 0xffffffff;
const handle = (value: unknown, prefix: string) => typeof value === 'string' && value.startsWith(prefix) && digest(value.slice(prefix.length));
/** Structural validation for an observed record. This does not re-issue its source, proof, or durability authority. */
export function validateActionAttemptDisposition(value: ActionAttemptDisposition): void {
    const work = value?.work, transaction = work?.transaction, source = work?.source;
    if (!keys(value, ['schemaVersion', 'kind', 'work', 'disposition', 'reason', 'output']) || value.schemaVersion !== 1
        || value.kind !== 'action-attempt-disposition' || !Object.hasOwn(reasonKinds, value.reason) || reasonKinds[value.reason] !== value.disposition
        || !keys(work, ['stage', 'admissionId', 'sourceId', 'ingressId', 'source', 'sourceSelectionId', 'producer', 'executableSha256', 'policySha256', 'target', 'planId', 'transaction'])
        || !['main-source', 'ds-transaction'].includes(work.stage) || !handle(work.admissionId, 'h45actionadmission1:')
        || !handle(work.sourceId, 'h45actionsource1:') || !handle(work.ingressId, 'h45actioningress1:')
        || !keys(source, ['chainId', 'blockNum', 'blockId', 'previousBlockId', 'captureSha256']) || !digest(source.chainId)
        || !uint32(source.blockNum, 1) || !digest(source.blockId) || !digest(source.captureSha256)
        || (source.previousBlockId !== null && !digest(source.previousBlockId))
        || (work.sourceSelectionId !== null && !handle(work.sourceSelectionId, 'h45srcsel1:'))
        || !digest(work.executableSha256) || !digest(work.policySha256)
        || !keys(work.producer, ['protocolId', 'profileId', 'codeRevision', 'configurationSha256', 'pluginsSha256'])
        || !['protocolId', 'profileId'].every(field => typeof work.producer[field] === 'string' && /^[\x21-\x7e]{1,256}$/.test(work.producer[field]))
        || !/^[0-9a-f]{40}$/.test(work.producer.codeRevision) || !digest(work.producer.configurationSha256) || !digest(work.producer.pluginsSha256)
        || !keys(work.target, ['name', 'uuid']) || typeof work.target.name !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,254}$/.test(work.target.name)
        || typeof work.target.uuid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(work.target.uuid)
        || (work.planId !== null && !handle(work.planId, 'h45actionplan1:'))
        || (transaction !== null && (!keys(transaction, ['transactionId', 'traceOrdinal', 'traceSha256', 'dispatchSha256', 'expectedGroups'])
            || !digest(transaction.transactionId) || !uint32(transaction.traceOrdinal) || !digest(transaction.traceSha256)
            || (transaction.dispatchSha256 !== null && !digest(transaction.dispatchSha256))
            || !uint32(transaction.expectedGroups) || transaction.expectedGroups > actionAttemptDispositionBounds.maximumRecords)))
        throw new Error('Invalid observed action attempt association');
    if (value.disposition === 'source-unprocessable') {
        if (work.stage !== 'main-source' || transaction !== null || work.planId !== null || !keys(value.output, ['kind']) || value.output.kind !== 'unresolved')
            throw new Error('Invalid source-unprocessable observation');
    } else {
        if (!work.planId || source.previousBlockId === null) throw new Error('Complete input observation lacks its original membership plan');
        if (value.reason === 'empty-source-vector') {
            if (work.stage !== 'main-source' || transaction !== null) throw new Error('Empty source invents transaction membership');
        } else if (!transaction) throw new Error('Transaction observation lacks original membership');
        if (value.disposition === 'policy-excluded' && (work.stage !== 'main-source' || transaction!.expectedGroups !== 0))
            throw new Error('Invalid excluded work observation');
        if (value.disposition === 'no-effects' && transaction && (transaction.expectedGroups !== 0
            || (work.stage === 'main-source' ? transaction.dispatchSha256 !== null : transaction.dispatchSha256 === null)))
            throw new Error('Invalid no-effect stage or output membership');
        if (value.disposition === 'operator-disabled' && ((value.reason === 'traces-disabled' ? work.stage !== 'main-source' : work.stage !== 'ds-transaction')
            || transaction!.dispatchSha256 === null)) throw new Error('Invalid captured operator suppression');
        if (['contract-output-incomplete', 'raw-incomplete-handoff'].includes(value.disposition)
            && (work.stage !== 'ds-transaction' || !transaction!.expectedGroups || transaction!.dispatchSha256 === null))
            throw new Error('Incomplete work lacks nonempty original membership');
        if (value.disposition === 'raw-incomplete-handoff') {
            const output = value.output;
            if (!keys(output, ['kind', 'fragmentId', 'effects']) || output.kind !== 'raw-incomplete' || !handle(output.fragmentId, 'h45actionfragment1:')
                || !Array.isArray(output.effects) || output.effects.length !== transaction!.expectedGroups || !output.effects.some(effect => effect.status === 'incomplete'))
                throw new Error('Invalid raw handoff output membership');
            for (const entry of output.effects) if (!keys(entry, ['effect', 'payloadSha256', 'headersSha256', 'status'])
                || !['complete', 'incomplete'].includes(entry.status) || !digest(entry.payloadSha256) || !digest(entry.headersSha256)
                || !keys(entry.effect, ['globalSequence', 'documentSha256', 'metadataSha256']) || !digest(entry.effect.documentSha256)
                || !digest(entry.effect.metadataSha256) || canonicalUint64(entry.effect.globalSequence) !== entry.effect.globalSequence || entry.effect.globalSequence === '0')
                throw new Error('Invalid observed raw handoff effect');
        } else if (!keys(value.output, ['kind']) || value.output.kind !== (['policy-excluded', 'no-effects'].includes(value.disposition) ? 'none-required' : 'unresolved'))
            throw new Error('Invalid observed action attempt output');
    }
    actionHistoryImmutableJson(value, actionAttemptDispositionBounds.maximumBytes);
}
declare const attemptBrand: unique symbol;
export interface ActionAttemptDispositionEvidence {readonly [attemptBrand]: true}
interface Evidence {store: object; owner: ActionPublicationOwner; current: () => boolean;
    observation: ActionAttemptDisposition; rederive: () => Promise<ActionAttemptDisposition>}
const issued = new WeakMap<object, Evidence>();
export function actionAttemptDispositionId(value: ActionAttemptDisposition): string {
    return 'h45actionattempt1:' + createHash('sha256').update(actionHistoryImmutableJson({work: value.work,
        disposition: value.disposition, reason: value.reason})).digest('hex');
}
function freeze<T>(value: T): T {
    if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);} return value;
}
function detach<T>(value: T): T {return freeze(JSON.parse(actionHistoryImmutableJson(value, actionAttemptDispositionBounds.maximumBytes)));}
export function issueActionAttemptDisposition(store: object, owner: ActionPublicationOwner,
    observation: ActionAttemptDisposition, rederive: Evidence['rederive']): ActionAttemptDispositionEvidence {
    validateActionAttemptDisposition(observation);
    const consumer = owner.consumer, publisher = owner.publisher, predicate = owner.current;
    const current = () => owner.consumer === consumer && owner.publisher === publisher && owner.current === predicate && predicate();
    if (!current()) throw new Error('Attempt evidence lost its original owner');
    const evidence = Object.freeze({}) as ActionAttemptDispositionEvidence;
    issued.set(evidence, Object.freeze({store, owner, current, observation: detach(observation), rederive})); return evidence;
}
/** Only the original store/owner can consume process-local evidence; reading JSON cannot mint this capability. */
export function readActionAttemptDispositionEvidence(store: object, owner: ActionPublicationOwner, evidence: ActionAttemptDispositionEvidence) {
    const value = issued.get(evidence);
    if (!value || value.store !== store || value.owner !== owner || !value.current()) throw new Error('Unissued, foreign or stale action attempt evidence');
    return value;
}

export interface ActionContractFailureBinding {
    readonly admissionId: string; readonly traceOrdinal: number; readonly dispatchPayload: Uint8Array;
    readonly configuration: string; readonly owner: ActionPublicationOwner;
}
export type ActionContractFailureReason = Extract<ActionAttemptReason, 'contract-abi-invalid' | 'contract-finalization-invalid'
    | 'contract-grouping-invalid' | 'contract-output-not-portable'>;
export class ActionContractOutputFailure extends Error {
    constructor(message: string) {super(message); this.name = 'ActionContractOutputFailure';}
}
interface ContractFailure {admissionId: string; traceOrdinal: number; payloadSha256: string; configuration: string;
    owner: ActionPublicationOwner; current: () => boolean; reason: ActionContractFailureReason}
const failures = new WeakMap<ActionContractOutputFailure, ContractFailure>();
export function isActionContractOutputFailure(value: unknown): value is ActionContractOutputFailure {
    return value instanceof ActionContractOutputFailure && failures.has(value);
}
/** Called only at trusted synchronous decode/output-validation boundaries, never an async hook/I/O catch. */
export function actionContractOutputFailure(binding: ActionContractFailureBinding, reason: ActionContractFailureReason,
    diagnosticMessage: string): ActionContractOutputFailure {
    if (!['contract-abi-invalid', 'contract-finalization-invalid', 'contract-grouping-invalid', 'contract-output-not-portable'].includes(reason)
        || !(binding.dispatchPayload instanceof Uint8Array) || binding.dispatchPayload.byteLength > actionAttemptDispositionBounds.maximumBytes
        || typeof binding.configuration !== 'string' || Buffer.byteLength(binding.configuration) + binding.dispatchPayload.byteLength > actionAttemptDispositionBounds.maximumBytes)
        throw new Error('Invalid bounded contract failure binding');
    const owner = binding.owner, consumer = owner.consumer, publisher = owner.publisher, predicate = owner.current;
    const current = () => owner.consumer === consumer && owner.publisher === publisher && owner.current === predicate && predicate();
    if (!current()) throw new Error('Contract failure lost its original owner');
    const failure = new ActionContractOutputFailure(String(diagnosticMessage).slice(0, 4096).toWellFormed());
    failures.set(failure, {admissionId: binding.admissionId, traceOrdinal: binding.traceOrdinal,
        payloadSha256: createHash('sha256').update(binding.dispatchPayload).digest('hex'), configuration: binding.configuration, owner, current, reason});
    return failure;
}
export function readActionContractOutputFailure(binding: ActionContractFailureBinding, failure: ActionContractOutputFailure): ActionContractFailureReason {
    const value = failures.get(failure);
    if (!value || !value.current() || value.owner !== binding.owner || value.admissionId !== binding.admissionId
        || value.traceOrdinal !== binding.traceOrdinal || value.configuration !== binding.configuration
        || value.payloadSha256 !== createHash('sha256').update(binding.dispatchPayload).digest('hex'))
        throw new Error('Unissued, stale or foreign contract failure evidence');
    return value.reason;
}
