import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
import {ImmutableProtocolBundleStore} from '../protocol/immutable-bundle-store.js';
import type {FreshBundlePrepare} from '../protocol/immutable-bundle-store.js';
import {ActionHistorySourceJournal, ActionHistorySourceJournalReadError} from './action-source-journal.js';
import {actionHistoryImmutableJson, validateActionHistoryBlockPlan, fingerprintActionHistoryEffect,
    createActionHistoryFragment, actionHistoryFragmentId, type ActionHistoryBlockPlan, type ActionHistoryEffect} from './action-history-manifest.js';
import {readConfirmedActionPublications, confirmedActionPublicationBytes, actionPublicationEvidenceBounds, type ActionPublicationOwner,
    type ConfirmedActionPublication} from './action-confirmed-publication.js';
import {deriveActionSourceInventory, validateActionSourceTransactionOutput, isActionSourceValidationFailure,
    type ActionSourceInventory, type ActionSourceInventoryInput} from './action-source-inventory.js';
import {actionAttemptDispositionBounds, actionAttemptDispositionId, issueActionAttemptDisposition, readActionAttemptDispositionEvidence,
    readActionContractOutputFailure, validateActionAttemptDisposition, type ActionContractOutputFailure, type ActionContractFailureBinding,
    type ActionAttemptDisposition, type ActionAttemptDispositionEvidence} from './action-attempt-disposition.js';
import {assertCompleteProtocolSearch} from '../protocol/search.js';
import {issueFreshActionWrite} from './action-fresh-write.js';
import {describeWorkerAttemptEnd, type AcceptedWorkerAttemptEnd, type WorkerAttemptSupervisor,
    type WorkerAttemptEndDescription} from '../protocol/worker-attempt-supervisor.js';

export const actionSourceAdmissionHeader = 'hyperion-action-admission-v1';
export const actionSourceIngressHeader = 'hyperion-action-source-v1';
export interface ActionSourceIngress {
    schemaVersion: 1; chainId: string; protocolId: string; profileId: string; components: unknown;
    readerSessionId: string; schemaJson: string; frameHex: string; captureSha256: string;
}
export interface RetainedActionSource {
    /** Schema 2 scopes the output plan to this immutable input; schema 1 retains its legacy identity. */
    readonly schemaVersion: 1 | 2;
    /** Original broker frame and handshake, retained before filtering. These bytes are not consensus attestation. */
    readonly frameHex: string;
    readonly schemaJson: string;
    readonly captureSha256: string;
    readonly ingressId: string;
    readonly previousBlockId: string | null;
    readonly producer: ActionHistoryBlockPlan['producer'];
    readonly executableSha256: string;
    readonly inventoryInput: ActionSourceInventoryInput;
}
interface AdmissionLink {schemaVersion: 1; sourceId: string; target: ActionHistoryBlockPlan['target'];
    planId: string | null; incomplete: string | null}
export interface ActionSourceAdmission {
    readonly id: string;
    readonly sourceId: string;
    readonly source: RetainedActionSource;
    readonly target: ActionHistoryBlockPlan['target'];
    readonly planId: string | null;
    readonly inventory?: ActionSourceInventory;
    readonly incomplete: string | null;
}
export interface ActionSourceHandoffWork {
    readonly admissionId: string; readonly sourceId: string; readonly planId: string;
    readonly source: ActionHistoryBlockPlan['source']; readonly sourceSelectionId: string | null;
    readonly producer: ActionHistoryBlockPlan['producer']; readonly executableSha256: string;
    readonly target: ActionHistoryBlockPlan['target']; readonly transactionId: string; readonly traceOrdinal: number;
    readonly traceSha256: string; readonly dispatchSha256: string;
}
export interface ActionSourceConfirmedHandoff {
    readonly schemaVersion: 1; readonly kind: 'confirmed-action-handoff'; readonly work: ActionSourceHandoffWork;
    readonly fragmentId: string; readonly effectRoot: string;
    readonly effects: readonly Readonly<{effect: ActionHistoryEffect; payloadSha256: string; headersSha256: string; route: 'index_actions'}>[];
}
export interface ActionSourceConfirmedHandoffInput {
    readonly admissionId: string; readonly traceOrdinal: number; readonly dispatchPayload: Uint8Array;
    readonly configuration: string; readonly owner: ActionPublicationOwner;
    readonly publications: readonly ConfirmedActionPublication[];
}
export interface ActionAttemptAssociation {
    readonly schemaVersion: 1; readonly kind: 'action-attempt-association';
    readonly end: WorkerAttemptEndDescription;
    /** An ACK call is not a broker settlement acknowledgement. */
    readonly brokerSettlement: 'unknown';
    readonly results: readonly {id: string; classification: 'confirmed-handoff' | 'intentional-no-effect'
        | 'intentional-suppression' | 'source-incomplete' | 'contract-incomplete' | 'raw-incomplete'}[];
    /** Observed at write time only; readers must revalidate before granting any authority. */
    readonly sourceChecked: true;
}
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hex64 = /^[0-9a-f]{64}$/;
const sourceSyntax = /^h45actionsource1:[0-9a-f]{64}$/;
const admissionSyntax = /^h45actionadmission1:[0-9a-f]{64}$/;
const copy = <T>(input: T): T => JSON.parse(actionHistoryImmutableJson(input));
const sourceIdentity = (source: RetainedActionSource) => 'h45actionsource1:' + sha(actionHistoryImmutableJson(source));
const admissionIdentity = (sourceId: string, target: ActionHistoryBlockPlan['target']) =>
    'h45actionadmission1:' + sha(actionHistoryImmutableJson([sourceId, target]));

/** Source retention, independent membership admission, and whole-transaction preparation.
 * This module grants no sink durability, canonicality, visibility, or query readiness. */
export class ActionSourceAdmissionStore {
    readonly index: string;
    readonly journal: ActionHistorySourceJournal;
    private readonly bundles: ImmutableProtocolBundleStore;
    private operations = 0;
    constructor(private readonly client: Client, private readonly chain: string, replicas = 0) {
        this.bundles = new ImmutableProtocolBundleStore(client, chain, replicas, 'action-source-admission', 'history-source-admission-v1');
        this.index = this.bundles.index;
        this.journal = new ActionHistorySourceJournal(client, chain, replicas);
    }
    private async bounded<T>(work: () => Promise<T>): Promise<T> {
        if (this.operations >= 4) throw new Error('Action source admission concurrent operation budget exhausted');
        this.operations++;
        try {return await work();} finally {this.operations--;}
    }
    private async put(id: string, value: unknown, signal?: AbortSignal): Promise<FreshBundlePrepare> {
        // The outer bundle uses integer-only JSON; retained opaque JSON may contain finite fractional values.
        return this.bundles.prepare(id, {schemaVersion: 1, payloadJson: actionHistoryImmutableJson(value)}, signal);
    }
    private async get(id: string, signal?: AbortSignal): Promise<any> {
        const value: any = await this.bundles.read(id, signal);
        if (!value || Object.keys(value).length !== 2 || value.schemaVersion !== 1 || typeof value.payloadJson !== 'string')
            throw new Error('Invalid action source admission envelope');
        const parsed = JSON.parse(value.payloadJson);
        if (actionHistoryImmutableJson(parsed) !== value.payloadJson) throw new Error('Noncanonical action source admission envelope');
        return parsed;
    }
    async retainIngress(input: ActionSourceIngress, signal?: AbortSignal): Promise<string> {
        const record = copy(input);
        if (record.schemaVersion !== 1 || !hex64.test(record.chainId) || !hex64.test(record.captureSha256)
            || !/^(?:[0-9a-f]{2})+$/.test(record.frameHex) || !record.schemaJson || !record.readerSessionId
            || !record.profileId || !record.protocolId) throw new Error('Invalid action source ingress');
        const id = 'h45actioningress1:' + sha(actionHistoryImmutableJson(record));
        return this.bounded(async () => {await this.put(id, record, signal); return id;});
    }
    async resolveIngress(id: string, signal?: AbortSignal): Promise<ActionSourceIngress> {
        if (typeof id !== 'string' || !/^h45actioningress1:[0-9a-f]{64}$/.test(id)) throw new Error('Invalid action source ingress handle');
        const record = await this.get(id, signal);
        if ('h45actioningress1:' + sha(actionHistoryImmutableJson(record)) !== id) throw new Error('Action source ingress identity mismatch');
        return record;
    }
    async retainRejectedIngress(record: {chainId: string; protocolId: string; profileId: string; frameHex: string;
        reason: {code: string; message: string}}, signal?: AbortSignal): Promise<string> {
        const value = copy({schemaVersion: 1, status: 'incomplete', ...record});
        const id = 'h45actionrejected1:' + sha(actionHistoryImmutableJson(value));
        await this.put(id, value, signal); return id;
    }
    private validateSource(input: unknown): RetainedActionSource {
        const source = copy(input) as RetainedActionSource;
        if (!source || (source.schemaVersion !== 1 && source.schemaVersion !== 2) || typeof source.frameHex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(source.frameHex)
            || typeof source.schemaJson !== 'string' || !source.schemaJson.length || !hex64.test(source.captureSha256)
            || !hex64.test(source.executableSha256) || (source.previousBlockId !== null && !hex64.test(source.previousBlockId)))
            throw new Error('Invalid retained action source');
        return source;
    }
    /** A content-addressed source manifest is discoverable even if admission preparation later fails. */
    async retainSource(input: RetainedActionSource, signal?: AbortSignal): Promise<string> {
        const source = this.validateSource(input), id = sourceIdentity(source);
        return this.bounded(async () => {await this.put(id, source, signal); return id;});
    }
    private async source(id: string, signal?: AbortSignal): Promise<RetainedActionSource> {
        if (!sourceSyntax.test(id)) throw new Error('Invalid retained action source ID');
        const source = this.validateSource(await this.get(id, signal));
        if (sourceIdentity(source) !== id) throw new Error('Retained action source identity mismatch');
        return source;
    }
    private compile(source: RetainedActionSource, target: ActionHistoryBlockPlan['target'], sourceId: string) {
        const inventory = deriveActionSourceInventory(source.inventoryInput);
        if (source.previousBlockId === null) throw new Error('Missing source predecessor cannot establish complete action membership');
        const plan = validateActionHistoryBlockPlan({schemaVersion: 1,
            source: {chainId: inventory.source.chainId, blockNum: inventory.source.blockNum, blockId: inventory.source.blockId,
                previousBlockId: source.previousBlockId, captureSha256: source.captureSha256,
                ...(source.schemaVersion === 2 ? {retainedSourceId: sourceId} : {})}, producer: source.producer, target,
            transactions: inventory.transactions.map(({transactionId, traceOrdinal, traceSha256, disposition}) =>
                ({transactionId, traceOrdinal, traceSha256, disposition}))});
        return {inventory, plan};
    }
    async admit(sourceId: string, targetInput: ActionHistoryBlockPlan['target'], signal?: AbortSignal): Promise<ActionSourceAdmission> {
        const target = copy(targetInput), id = admissionIdentity(sourceId, target);
        return this.bounded(async () => {
            const source = await this.source(sourceId, signal);
            let compiled: ReturnType<ActionSourceAdmissionStore['compile']> | undefined, incomplete: string | null = null;
            try {compiled = this.compile(source, target, sourceId);} catch (error) {
                // Only this pure compilation is classified as source-incomplete. I/O errors must escape without ACK.
                incomplete = String((error as Error)?.message ?? error).slice(0, 4096).toWellFormed();
            }
            const prepared = compiled ? await this.journal.preparePlan(compiled.plan, signal) : undefined;
            const link: AdmissionLink = {schemaVersion: 1, sourceId, target, planId: prepared?.id ?? null, incomplete};
            await this.put(id, link, signal);
            if (compiled && prepared) for (const transaction of compiled.inventory.transactions) {
                if (transaction.disposition !== 'process') await this.journal.recordFragment(prepared.id, transaction.transactionId, [], signal);
            }
            return {id, sourceId, source, target, planId: link.planId, inventory: compiled?.inventory, incomplete};
        });
    }
    async resolve(id: string, signal?: AbortSignal): Promise<ActionSourceAdmission> {
        return this.bounded(() => this.resolveCurrent(id, signal));
    }
    private async resolveCurrent(id: string, signal?: AbortSignal): Promise<ActionSourceAdmission> {
        if (typeof id !== 'string' || !admissionSyntax.test(id)) throw new Error('Invalid action admission handle');
        const link: AdmissionLink = await this.get(id, signal);
        if (!link || link.schemaVersion !== 1 || !sourceSyntax.test(link.sourceId)
            || admissionIdentity(link.sourceId, link.target) !== id || Object.keys(link).length !== 5
            || (link.incomplete !== null && typeof link.incomplete !== 'string')) throw new Error('Invalid action admission link');
        const source = await this.source(link.sourceId, signal);
        if (link.planId === null) {
            if (!link.incomplete) throw new Error('Incomplete admission lacks its cause');
            return {id, sourceId: link.sourceId, source, target: link.target, planId: null, incomplete: link.incomplete};
        }
        if (link.incomplete !== null) throw new Error('Complete action admission has an incomplete cause');
        // Re-issue from original retained source/policy. Stored expected output JSON is never authority.
        const {inventory, plan} = this.compile(source, link.target, link.sourceId);
        const stored = await this.journal.readPlan(link.planId, signal);
        if (actionHistoryImmutableJson(stored.plan) !== actionHistoryImmutableJson(plan)) throw new Error('Action admission plan mismatch');
        return {id, sourceId: link.sourceId, source, target: link.target, planId: link.planId, inventory, incomplete: null};
    }
    async prepareTransaction(admission: ActionSourceAdmission, traceOrdinal: number, payload: Uint8Array,
                             finalActions: readonly unknown[], signal?: AbortSignal) {
        return this.bounded(() => this.prepareTransactionCurrent(admission, traceOrdinal, payload, finalActions, signal));
    }
    private async prepareTransactionCurrent(admission: ActionSourceAdmission, traceOrdinal: number, payload: Uint8Array,
                                            finalActions: readonly unknown[], signal?: AbortSignal) {
        const detached = copy(finalActions), payloadSha256 = sha(payload);
        const current = await this.resolveCurrent(admission.id, signal);
        const transaction = current.inventory?.transactions.find(value => value.traceOrdinal === traceOrdinal);
        if (!current.inventory || !current.planId || !transaction?.dispatch || payloadSha256 !== transaction.dispatch.bodySha256)
            throw new Error('Action admission dispatch/source membership mismatch');
        const actions = validateActionSourceTransactionOutput(current.inventory, traceOrdinal, detached);
        const fragment = await this.journal.recordFragment(current.planId, transaction.transactionId, actions, signal);
        return {actions, fragmentId: fragment.id, planId: current.planId};
    }
    private handoffPayload(payload: Uint8Array): Buffer {
        if (!(payload instanceof Uint8Array) || payload.byteLength < 1 || payload.byteLength > actionPublicationEvidenceBounds.maximumBytes)
            throw new Error('Action handoff dispatch exceeds its byte bounds');
        return Buffer.from(payload);
    }
    private handoffWork(current: ActionSourceAdmission, traceOrdinal: number, payload: Buffer): ActionSourceHandoffWork {
        const inventory = current.inventory, transaction = inventory?.transactions.find(value => value.traceOrdinal === traceOrdinal);
        if (!current.planId || !inventory || !transaction?.dispatch || transaction.disposition !== 'process' || !transaction.groups.length
            || sha(payload) !== transaction.dispatch.bodySha256) throw new Error('Action handoff requires complete nonempty original source work');
        return {admissionId: current.id, sourceId: current.sourceId, planId: current.planId,
            source: {chainId: inventory.source.chainId, blockNum: inventory.source.blockNum, blockId: inventory.source.blockId,
                previousBlockId: current.source.previousBlockId!, captureSha256: current.source.captureSha256},
            sourceSelectionId: inventory.sourceSelectionId, producer: current.source.producer, executableSha256: current.source.executableSha256,
            target: current.target, transactionId: transaction.transactionId, traceOrdinal, traceSha256: transaction.traceSha256,
            dispatchSha256: transaction.dispatch.bodySha256};
    }
    private handoffId(work: ActionSourceHandoffWork): string {return 'h45actionhandoff1:' + sha(actionHistoryImmutableJson(work));}

    /** Confirmed broker handoff only. No sink acceptance, canonicality, readiness or capacity release. */
    async recordConfirmedHandoff(input: ActionSourceConfirmedHandoffInput, signal?: AbortSignal): Promise<{id: string; outcome: ActionSourceConfirmedHandoff}> {
        return this.bounded(async () => {
            signal?.throwIfAborted();
            const owner = input.owner;
            // Issuance, owners and the SUM of all retained bytes are checked before copying/parsing ticket data.
            const publications = readConfirmedActionPublications(owner, input.publications);
            const payload = this.handoffPayload(input.dispatchPayload);
            if (typeof input.configuration !== 'string' || Buffer.byteLength(input.configuration) > actionPublicationEvidenceBounds.maximumBytes)
                throw new Error('Action handoff configuration exceeds its byte bounds');
            const configuration = input.configuration, admissionId = input.admissionId, traceOrdinal = input.traceOrdinal;
            const consumer = owner.consumer, publisher = owner.publisher, predicate = owner.current;
            const currentOwner = () => {
                signal?.throwIfAborted();
                if (owner.consumer !== consumer || owner.publisher !== publisher || owner.current !== predicate || !predicate())
                    throw new Error('Action handoff lost its original publication owner');
            };
            currentOwner();
            const current = await this.resolveCurrent(admissionId, signal); currentOwner();
            const work = this.handoffWork(current, traceOrdinal, payload);
            const configured = JSON.parse(configuration), count = configured?.config?.scaling?.ad_idx_queues;
            if (actionHistoryImmutableJson(configured) !== configuration || sha(configuration) !== work.producer.configurationSha256
                || configured?.config?.indexer?.disable_indexing === true || !Number.isInteger(count) || count < 1 || count > 0xffffffff)
                throw new Error('Action handoff configuration/routing authority mismatch');
            const route = this.chain + ':index_actions:';
            const actions = publications.map(publication => {
                const suffix = publication.queue.startsWith(route) ? publication.queue.slice(route.length) : '';
                const ordinal = Number(suffix);
                if (!/^[1-9][0-9]{0,9}$/.test(suffix) || ordinal > count || ordinal > 0xffffffff)
                    throw new Error('Action handoff publication is outside configured action routing');
                const action = JSON.parse(publication.payload.toString());
                if (actionHistoryImmutableJson(action) !== publication.payload.toString() || Object.hasOwn(action, 'ds_error')
                    || action.protocol?.status === 'incomplete') throw new Error('Incomplete or noncanonical action cannot establish a confirmed handoff');
                return action;
            });
            const prepared = await this.prepareTransactionCurrent(current, traceOrdinal, payload, actions, signal); currentOwner();
            const effects = publications.map((publication, index) => {
                const headers = publication.headers;
                if (!headers || Object.keys(headers).length !== 3 || headers.block_num !== work.source.blockNum
                    || headers[actionSourceAdmissionHeader] !== work.admissionId || headers.action_fragment_id !== prepared.fragmentId)
                    throw new Error('Action handoff publication headers do not bind the prepared original work');
                return {effect: fingerprintActionHistoryEffect(prepared.actions[index]), payloadSha256: sha(publication.payload),
                    headersSha256: sha(publication.headersJson), route: 'index_actions' as const};
            });
            const effectRoot = sha(actionHistoryImmutableJson({fragmentId: prepared.fragmentId, effects}));
            const outcome: ActionSourceConfirmedHandoff = {schemaVersion: 1, kind: 'confirmed-action-handoff', work,
                fragmentId: prepared.fragmentId, effectRoot, effects};
            const id = this.handoffId(work);
            currentOwner(); const proof = await this.put(id, outcome, signal); currentOwner();
            return issueFreshActionWrite({id, outcome: copy(outcome)}, 'confirmed-handoff', id, outcome, proof, this.bundles);
        });
    }

    /** Observed record only: reads neither re-acknowledge durability nor issue capacity/readiness authority. */
    async readConfirmedHandoff(admissionId: string, traceOrdinal: number, dispatchPayload: Uint8Array,
                               signal?: AbortSignal): Promise<{id: string; outcome: ActionSourceConfirmedHandoff}> {
        return this.bounded(async () => {
            const payload = this.handoffPayload(dispatchPayload);
            const current = await this.resolveCurrent(admissionId, signal), work = this.handoffWork(current, traceOrdinal, payload), id = this.handoffId(work);
            const outcome: ActionSourceConfirmedHandoff = await this.get(id, signal);
            if (!outcome || Object.keys(outcome).length !== 6 || outcome.schemaVersion !== 1 || outcome.kind !== 'confirmed-action-handoff'
                || actionHistoryImmutableJson(outcome.work) !== actionHistoryImmutableJson(work) || !Array.isArray(outcome.effects)
                || !outcome.effects.length || outcome.effects.length > actionPublicationEvidenceBounds.maximumPublications
                || outcome.effects.length !== current.inventory!.transactions.find(value => value.traceOrdinal === traceOrdinal)!.groups.length
                || outcome.effects.some(entry => !entry || Object.keys(entry).length !== 4 || entry.route !== 'index_actions'
                    || !hex64.test(entry.payloadSha256) || !hex64.test(entry.headersSha256))
                || outcome.effectRoot !== sha(actionHistoryImmutableJson({fragmentId: outcome.fragmentId, effects: outcome.effects})))
                throw new Error('Invalid observed confirmed action handoff');
            const plan = this.compile(current.source, current.target, current.sourceId).plan;
            const fragment = createActionHistoryFragment(plan, work.transactionId, outcome.effects.map(entry => entry.effect));
            if (actionHistoryFragmentId(fragment, plan) !== outcome.fragmentId) throw new Error('Observed action handoff fragment/root mismatch');
            signal?.throwIfAborted(); return {id, outcome: copy(outcome)};
        });
    }
    private attemptBinding(input: {admissionId: string; configuration: string; owner: ActionPublicationOwner; traceOrdinal?: number; dispatchPayload?: Uint8Array}) {
        const admissionId = input.admissionId, configuration = input.configuration, owner = input.owner;
        const consumer = owner.consumer, publisher = owner.publisher, predicate = owner.current;
        const currentOwner = () => {if (owner.consumer !== consumer || owner.publisher !== publisher || owner.current !== predicate || !predicate())
            throw new Error('Action attempt lost its original owner');};
        currentOwner();
        if (!admissionSyntax.test(admissionId) || typeof configuration !== 'string'
            || Buffer.byteLength(configuration) > actionAttemptDispositionBounds.maximumBytes) throw new Error('Invalid action attempt binding');
        const traceOrdinal = input.traceOrdinal;
        if (traceOrdinal !== undefined && (!Number.isSafeInteger(traceOrdinal) || traceOrdinal < 0)) throw new Error('Invalid action attempt ordinal');
        const originalPayload = input.dispatchPayload;
        if (originalPayload !== undefined && (!(originalPayload instanceof Uint8Array) || originalPayload.byteLength < 1))
            throw new Error('Action attempt dispatch is not bounded bytes');
        if (Buffer.byteLength(configuration) + (originalPayload?.byteLength ?? 0) > actionAttemptDispositionBounds.maximumBytes)
            throw new Error('Action attempt aggregate input byte budget exhausted');
        const dispatchPayload = originalPayload === undefined ? undefined : Buffer.from(originalPayload);
        return {admissionId, configuration, owner, traceOrdinal, dispatchPayload, currentOwner};
    }
    private attemptOwner(owner: ActionPublicationOwner, configuration: string, current: ActionSourceAdmission) {
        const consumer = owner.consumer, publisher = owner.publisher, predicate = owner.current;
        if (typeof configuration !== 'string' || Buffer.byteLength(configuration) > actionAttemptDispositionBounds.maximumBytes
            || sha(configuration) !== current.source.producer.configurationSha256
            || actionHistoryImmutableJson(JSON.parse(configuration)) !== configuration) throw new Error('Action attempt configuration authority mismatch');
        return () => {if (owner.consumer !== consumer || owner.publisher !== publisher || owner.current !== predicate || !predicate())
            throw new Error('Action attempt lost its original owner');};
    }
    private attemptWork(current: ActionSourceAdmission, stage: ActionAttemptDisposition['work']['stage'], traceOrdinal?: number): ActionAttemptDisposition['work'] {
        const source = current.source, input = source.inventoryInput;
        const transaction = traceOrdinal === undefined ? undefined : current.inventory?.transactions.find(value => value.traceOrdinal === traceOrdinal);
        if (traceOrdinal !== undefined && !transaction) throw new Error('Action attempt lacks original transaction membership');
        return {stage, admissionId: current.id, sourceId: current.sourceId, ingressId: source.ingressId,
            source: {chainId: input.source.chainId, blockNum: input.source.blockNum, blockId: input.source.blockId,
                previousBlockId: source.previousBlockId, captureSha256: source.captureSha256},
            sourceSelectionId: input.sourceSelectionId ?? null, producer: source.producer, executableSha256: source.executableSha256,
            policySha256: current.inventory?.policySha256 ?? sha(actionHistoryImmutableJson(input.policy)), target: current.target,
            planId: current.planId, transaction: transaction ? {transactionId: transaction.transactionId, traceOrdinal: transaction.traceOrdinal,
                traceSha256: transaction.traceSha256, dispatchSha256: transaction.dispatch?.bodySha256 ?? null, expectedGroups: transaction.groups.length} : null};
    }
    private sourceAttemptObservations(current: ActionSourceAdmission, configuration: string): ActionAttemptDisposition[] {
        const observation = (reason: ActionAttemptDisposition['reason'], disposition: ActionAttemptDisposition['disposition'],
            ordinal?: number, output: ActionAttemptDisposition['output'] = {kind: 'unresolved'}): ActionAttemptDisposition =>
            ({schemaVersion: 1, kind: 'action-attempt-disposition', work: this.attemptWork(current, 'main-source', ordinal), disposition, reason, output});
        if (!current.planId) {
            let reason: ActionAttemptDisposition['reason'] | undefined;
            if (current.source.inventoryInput.traces === null || current.source.inventoryInput.traces === undefined) reason = 'source-traces-missing';
            else if (current.source.previousBlockId === null) reason = 'source-predecessor-missing';
            else try {this.compile(current.source, current.target, current.sourceId);} catch (error) {if (isActionSourceValidationFailure(error)) reason = 'source-inventory-invalid';}
            return reason ? [observation(reason, 'source-unprocessable')] : [];
        }
        const transactions = current.inventory!.transactions, result: ActionAttemptDisposition[] = [];
        let bytes = Buffer.byteLength(configuration);
        const append = (value: ActionAttemptDisposition) => {
            bytes += Buffer.byteLength(actionHistoryImmutableJson(value));
            if (result.length >= actionAttemptDispositionBounds.maximumRecords || bytes > actionAttemptDispositionBounds.maximumBytes)
                throw new Error('Action attempt aggregate source observation budget exhausted');
            result.push(value);
        };
        if (!transactions.length) append(observation('empty-source-vector', 'no-effects', undefined, {kind: 'none-required'}));
        for (const transaction of transactions) {
            if (transaction.disposition === 'excluded') append(observation('policy-excluded', 'policy-excluded', transaction.traceOrdinal, {kind: 'none-required'}));
            else if (!transaction.dispatch && transaction.disposition === 'no-effects') append(observation('no-effects', 'no-effects', transaction.traceOrdinal, {kind: 'none-required'}));
            else if (transaction.dispatch && JSON.parse(configuration)?.config?.indexer?.fetch_traces === false)
                append(observation('traces-disabled', 'operator-disabled', transaction.traceOrdinal));
        }
        return result;
    }
    async prepareSourceAttemptDispositions(input: {admissionId: string; configuration: string; owner: ActionPublicationOwner}, signal?: AbortSignal): Promise<readonly ActionAttemptDispositionEvidence[]> {
        return this.bounded(async () => {
            signal?.throwIfAborted();
            const {admissionId, configuration, owner, currentOwner} = this.attemptBinding(input);
            const current = await this.resolveCurrent(admissionId, signal); currentOwner();
            this.attemptOwner(owner, configuration, current)();
            const observations = this.sourceAttemptObservations(current, configuration);
            if (observations.length > actionAttemptDispositionBounds.maximumRecords) throw new Error('Action attempt count budget exhausted');
            if (Buffer.byteLength(configuration) + Buffer.byteLength(actionHistoryImmutableJson(observations)) > actionAttemptDispositionBounds.maximumBytes)
                throw new Error('Action attempt aggregate source evidence byte budget exhausted');
            return observations.map(observation => issueActionAttemptDisposition(this, owner, observation, async () => {
                currentOwner(); const fresh = await this.resolveCurrent(admissionId, signal); currentOwner();
                const rederived = this.sourceAttemptObservations(fresh, configuration).find(value => actionAttemptDispositionId(value) === actionAttemptDispositionId(observation));
                if (!rederived) throw new Error('Original source attempt observation is no longer derivable'); return rederived;
            }));
        });
    }
    private transactionAttemptObservation(current: ActionSourceAdmission, traceOrdinal: number, payload: Buffer,
        configuration: string): ActionAttemptDisposition | undefined {
        const transaction = current.inventory?.transactions.find(value => value.traceOrdinal === traceOrdinal);
        if (!current.planId || !transaction?.dispatch || sha(payload) !== transaction.dispatch.bodySha256)
            throw new Error('Action attempt dispatch/source membership mismatch');
        const base = {schemaVersion: 1 as const, kind: 'action-attempt-disposition' as const,
            work: this.attemptWork(current, 'ds-transaction', traceOrdinal)};
        if (transaction.disposition === 'no-effects' && transaction.groups.length === 0)
            return {...base, disposition: 'no-effects', reason: 'no-effects', output: {kind: 'none-required'}};
        if (transaction.disposition === 'process' && transaction.groups.length > 0 && JSON.parse(configuration)?.config?.indexer?.disable_indexing === true)
            return {...base, disposition: 'operator-disabled', reason: 'indexing-disabled', output: {kind: 'unresolved'}};
        return undefined;
    }
    async prepareTransactionAttemptDisposition(input: {admissionId: string; traceOrdinal: number; dispatchPayload: Uint8Array;
        configuration: string; owner: ActionPublicationOwner}, signal?: AbortSignal): Promise<ActionAttemptDispositionEvidence | undefined> {
        return this.bounded(async () => {
            const binding = this.attemptBinding(input); signal?.throwIfAborted();
            const derive = async () => {
                binding.currentOwner(); const current = await this.resolveCurrent(binding.admissionId, signal); binding.currentOwner();
                this.attemptOwner(binding.owner, binding.configuration, current)();
                return this.transactionAttemptObservation(current, binding.traceOrdinal!, binding.dispatchPayload!, binding.configuration);
            };
            const observation = await derive();
            if (observation && Buffer.byteLength(binding.configuration) + binding.dispatchPayload!.length + Buffer.byteLength(actionHistoryImmutableJson(observation)) > actionAttemptDispositionBounds.maximumBytes)
                throw new Error('Action attempt aggregate transaction evidence byte budget exhausted');
            return observation && issueActionAttemptDisposition(this, binding.owner, observation, async () => {
                const value = await derive(); if (!value) throw new Error('Original transaction attempt is no longer derivable'); return value;
            });
        });
    }
    async prepareContractAttemptDisposition(input: ActionContractFailureBinding & {failure: ActionContractOutputFailure}, signal?: AbortSignal): Promise<ActionAttemptDispositionEvidence> {
        return this.bounded(async () => {
            const binding = this.attemptBinding(input), failure = input.failure; signal?.throwIfAborted();
            const exact = {admissionId: binding.admissionId, traceOrdinal: binding.traceOrdinal!, dispatchPayload: binding.dispatchPayload!,
                configuration: binding.configuration, owner: binding.owner};
            const derive = async (): Promise<ActionAttemptDisposition> => {
                const reason = readActionContractOutputFailure(exact, failure); binding.currentOwner();
                const current = await this.resolveCurrent(binding.admissionId, signal); binding.currentOwner();
                this.attemptOwner(binding.owner, binding.configuration, current)();
                this.handoffWork(current, binding.traceOrdinal!, binding.dispatchPayload!);
                return {schemaVersion: 1, kind: 'action-attempt-disposition', work: this.attemptWork(current, 'ds-transaction', binding.traceOrdinal),
                    disposition: 'contract-output-incomplete', reason, output: {kind: 'unresolved'}};
            };
            const observation = await derive();
            if (Buffer.byteLength(binding.configuration) + binding.dispatchPayload!.length + Buffer.byteLength(actionHistoryImmutableJson(observation)) > actionAttemptDispositionBounds.maximumBytes)
                throw new Error('Action attempt aggregate contract evidence byte budget exhausted');
            return issueActionAttemptDisposition(this, binding.owner, observation, derive);
        });
    }
    async prepareRawIncompleteAttemptDisposition(input: ActionSourceConfirmedHandoffInput, signal?: AbortSignal): Promise<ActionAttemptDispositionEvidence> {
        return this.bounded(async () => {
            signal?.throwIfAborted();
            const owner = input.owner, tickets = input.publications;
            // Count/SUM ticket guards precede other request inspection or byte copies.
            const publicationBytes = confirmedActionPublicationBytes(owner, tickets);
            const configuration = input.configuration, dispatchPayload = input.dispatchPayload;
            if (typeof configuration !== 'string' || !(dispatchPayload instanceof Uint8Array)) throw new Error('Invalid raw handoff binding');
            const reserved = Buffer.byteLength(configuration) + dispatchPayload.byteLength;
            if (publicationBytes + reserved > actionAttemptDispositionBounds.maximumBytes) throw new Error('Raw handoff aggregate input byte budget exhausted');
            const publications = readConfirmedActionPublications(owner, tickets, reserved);
            const binding = this.attemptBinding({admissionId: input.admissionId, traceOrdinal: input.traceOrdinal, owner, configuration, dispatchPayload});
            const derive = async (): Promise<ActionAttemptDisposition> => {
                binding.currentOwner(); const current = await this.resolveCurrent(binding.admissionId, signal); binding.currentOwner();
                this.attemptOwner(binding.owner, binding.configuration, current)();
                const work = this.handoffWork(current, binding.traceOrdinal!, binding.dispatchPayload!);
                const configured = JSON.parse(binding.configuration), count = configured?.config?.scaling?.ad_idx_queues;
                if (configured?.config?.indexer?.disable_indexing === true || configured?.config?.indexer?.fetch_traces === false
                    || !Number.isInteger(count) || count < 1 || count > 0xffffffff) throw new Error('Raw handoff configuration/routing authority mismatch');
                const route = this.chain + ':index_actions:';
                const actions = publications.map(publication => {
                    const suffix = publication.queue.startsWith(route) ? publication.queue.slice(route.length) : '';
                    if (!/^[1-9][0-9]{0,9}$/.test(suffix) || Number(suffix) > count || Number(suffix) > 0xffffffff)
                        throw new Error('Raw handoff publication is outside configured action routing');
                    const action = JSON.parse(publication.payload.toString());
                    if (actionHistoryImmutableJson(action) !== publication.payload.toString()) throw new Error('Raw handoff action is not canonical');
                    return action;
                });
                if (!actions.some(action => action.protocol?.schemaVersion === 2 && action.protocol?.status === 'incomplete' && action.ds_error === true))
                    throw new Error('Raw handoff requires at least one checked native incomplete output');
                const prepared = await this.prepareTransactionCurrent(current, binding.traceOrdinal!, binding.dispatchPayload!, actions, signal);
                binding.currentOwner();
                const effects = publications.map((publication, index) => {
                    const headers = publication.headers;
                    if (!headers || Object.keys(headers).length !== 3 || headers.block_num !== work.source.blockNum
                        || headers[actionSourceAdmissionHeader] !== work.admissionId || headers.action_fragment_id !== prepared.fragmentId)
                        throw new Error('Raw handoff publication headers do not bind the exact prepared fragment');
                    const incomplete = actions[index].protocol?.status === 'incomplete';
                    if (incomplete && (actions[index].protocol.schemaVersion !== 2 || actions[index].ds_error !== true))
                        throw new Error('Raw handoff has an unchecked incomplete sibling');
                    if (!incomplete && Object.hasOwn(actions[index], 'ds_error')) throw new Error('Raw handoff has an invalid complete sibling');
                    return {effect: fingerprintActionHistoryEffect(prepared.actions[index]), payloadSha256: sha(publication.payload),
                        headersSha256: sha(publication.headersJson), status: incomplete ? 'incomplete' as const : 'complete' as const};
                });
                const observation: ActionAttemptDisposition = {schemaVersion: 1, kind: 'action-attempt-disposition', work: this.attemptWork(current, 'ds-transaction', binding.traceOrdinal),
                    disposition: 'raw-incomplete-handoff', reason: 'raw-output-incomplete', output: {kind: 'raw-incomplete', fragmentId: prepared.fragmentId, effects}};
                if (publicationBytes + reserved + Buffer.byteLength(actionHistoryImmutableJson(observation)) > actionAttemptDispositionBounds.maximumBytes)
                    throw new Error('Raw handoff aggregate evidence byte budget exhausted');
                return observation;
            };
            const observation = await derive(); return issueActionAttemptDisposition(this, binding.owner, observation, derive);
        });
    }
    async recordAttemptDisposition(input: {owner: ActionPublicationOwner; evidence: ActionAttemptDispositionEvidence}, signal?: AbortSignal): Promise<{id: string; observation: ActionAttemptDisposition}> {
        return this.bounded(async () => {
            signal?.throwIfAborted();
            const evidence = readActionAttemptDispositionEvidence(this, input.owner, input.evidence);
            const observation = await evidence.rederive(); signal?.throwIfAborted();
            if (!evidence.current() || actionHistoryImmutableJson(observation) !== actionHistoryImmutableJson(evidence.observation))
                throw new Error('Action attempt source/output association changed');
            const id = actionAttemptDispositionId(observation);
            const proof = await this.put(id, observation, signal); signal?.throwIfAborted();
            if (!evidence.current()) throw new Error('Action attempt owner changed across persistence');
            return issueFreshActionWrite({id, observation: copy(observation)}, 'attempt-disposition', id, observation, proof, this.bundles);
        });
    }
    async readAttemptDisposition(id: string, signal?: AbortSignal): Promise<{id: string; observation: ActionAttemptDisposition}> {
        return this.bounded(async () => {
            if (typeof id !== 'string' || !/^h45actionattempt1:[0-9a-f]{64}$/.test(id)) throw new Error('Invalid action attempt record ID');
            const observation: ActionAttemptDisposition = await this.get(id, signal);
            validateActionAttemptDisposition(observation);
            if (actionAttemptDispositionId(observation) !== id)
                throw new Error('Invalid observed action attempt record');
            return {id, observation: copy(observation)};
        });
    }
    /** Stores a private observation only after the actual supervisor-issued end has been joined in this process.
     * Reading this JSON later cannot reissue the original end, fresh write, or broker settlement. */
    async recordAttemptAssociation(supervisor: WorkerAttemptSupervisor, evidence: AcceptedWorkerAttemptEnd,
                                   association: Omit<ActionAttemptAssociation, 'schemaVersion' | 'kind' | 'end' | 'brokerSettlement'>,
                                   signal?: AbortSignal): Promise<{id: string; observation: ActionAttemptAssociation}> {
        const end = describeWorkerAttemptEnd(supervisor, evidence);
        if (end.status !== 'quiescent' || end.rootResult !== 'returned' || end.acknowledgementAttempted !== true
            || end.freshWriteOverflow || end.descriptor.headersSha256 === null || !association.sourceChecked
            || !Array.isArray(association.results) || association.results.length !== end.freshWrites.length
            || association.results.length < 1 || association.results.length > 32
            || association.results.some(result => !result || typeof result.id !== 'string'
                || !['confirmed-handoff','intentional-no-effect','intentional-suppression','source-incomplete',
                    'contract-incomplete','raw-incomplete'].includes(result.classification))
            || association.results.some((result, index) => result.id !== end.freshWrites[index]?.id
                || result.classification !== end.freshWrites[index]?.classification))
            throw new Error('Invalid bounded worker attempt association');
        const observation: ActionAttemptAssociation = {schemaVersion: 1, kind: 'action-attempt-association', end,
            brokerSettlement: 'unknown', results: copy(association.results), sourceChecked: association.sourceChecked};
        const id = 'h45actionassociation1:' + sha(actionHistoryImmutableJson([end.epoch, end.incarnation, end.attemptId]));
        return this.bounded(async () => {await this.put(id, observation, signal); return {id, observation: copy(observation)};});
    }
    /** Restart inspection only: a stored association cannot recreate its opaque end or settle its broker ACK. */
    async readAttemptAssociation(id: string, signal?: AbortSignal): Promise<{id: string; observation: ActionAttemptAssociation}> {
        if (!/^h45actionassociation1:[0-9a-f]{64}$/.test(id)) throw new Error('Invalid action attempt association ID');
        return this.bounded(async () => {
            const observation = await this.get(id, signal) as ActionAttemptAssociation;
            const end = observation?.end;
            if (observation.schemaVersion !== 1 || observation.kind !== 'action-attempt-association'
                || observation.brokerSettlement !== 'unknown' || observation.sourceChecked !== true
                || !end || end.status !== 'quiescent' || end.rootResult !== 'returned'
                || end.acknowledgementAttempted !== true || end.freshWriteOverflow !== false
                || !Array.isArray(end.freshWrites) || !Array.isArray(observation.results)
                || observation.results.length !== end.freshWrites.length || observation.results.length < 1
                || observation.results.length > 32
                || observation.results.some((result, index) => result.id !== end.freshWrites[index]?.id
                    || !['confirmed-handoff','intentional-no-effect','intentional-suppression','source-incomplete',
                        'contract-incomplete','raw-incomplete'].includes(result.classification)
                    || result.classification !== end.freshWrites[index]?.classification)
                || id !== 'h45actionassociation1:' + sha(actionHistoryImmutableJson([end.epoch, end.incarnation, end.attemptId])))
                throw new Error('Invalid retained action attempt association');
            return {id, observation: copy(observation)};
        });
    }
    async trySeal(admission: ActionSourceAdmission, signal?: AbortSignal): Promise<boolean> {
        const current = await this.resolve(admission.id, signal);
        if (!current.planId) return false;
        try {await this.journal.seal(current.planId, signal); return true;} catch (error) {
            if (error instanceof ActionHistorySourceJournalReadError && ['missing', 'incomplete'].includes(error.code)) return false;
            throw error;
        }
    }
    async inspectSource(sourceId: string, target: ActionHistoryBlockPlan['target'], signal?: AbortSignal): Promise<ActionSourceAdmission> {
        return this.resolve(admissionIdentity(sourceId, target), signal);
    }
    async noteIncomplete(admissionId: string, traceOrdinal: number | null, message: string, signal?: AbortSignal): Promise<void> {
        if (!admissionSyntax.test(admissionId) || (traceOrdinal !== null && (!Number.isSafeInteger(traceOrdinal) || traceOrdinal < 0)))
            throw new Error('Invalid incomplete action admission association');
        const record = {schemaVersion: 1, admissionId, traceOrdinal, message: message.slice(0, 4096).toWellFormed()};
        await this.put('h45actionincomplete1:' + sha(actionHistoryImmutableJson(record)), record, signal);
    }
    /** Bounded, resumable discovery of retained source manifests, including work without an admission/fragment. */
    async discoverSources(after?: string, signal?: AbortSignal): Promise<{ids: string[]; after?: string}> {
        signal?.throwIfAborted();
        if (after !== undefined && !sourceSyntax.test(after)) throw new Error('Invalid source discovery cursor');
        const response = await this.client.search({index: this.index, size: 100, track_total_hits: false,
            query: {bool: {filter: [{term: {kind: 'manifest'}}, {prefix: {bundle_id: 'h45actionsource1:'}}]}},
            sort: [{bundle_id: 'asc'}], ...(after ? {search_after: [after]} : {}), _source: ['bundle_id']}, {signal});
        assertCompleteProtocolSearch(response);
        signal?.throwIfAborted();
        if (response.hits.hits.length > 100) throw new Error('Retained source discovery exceeds its page budget');
        const ids = response.hits.hits.map(hit => (hit._source as any)?.bundle_id);
        if (ids.some((id, index) => typeof id !== 'string' || !sourceSyntax.test(id) || (index > 0 && id <= ids[index - 1])
            || (after !== undefined && id <= after))) throw new Error('Invalid retained source discovery response');
        return {ids, ...(ids.length === 100 ? {after: ids.at(-1)} : {})};
    }
}
