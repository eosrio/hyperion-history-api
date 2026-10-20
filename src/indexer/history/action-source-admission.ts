import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
import {ImmutableProtocolBundleStore} from '../protocol/immutable-bundle-store.js';
import {ActionHistorySourceJournal, ActionHistorySourceJournalReadError} from './action-source-journal.js';
import {actionHistoryImmutableJson, validateActionHistoryBlockPlan, type ActionHistoryBlockPlan} from './action-history-manifest.js';
import {deriveActionSourceInventory, validateActionSourceTransactionOutput,
    type ActionSourceInventory, type ActionSourceInventoryInput} from './action-source-inventory.js';
import {assertCompleteProtocolSearch} from '../protocol/search.js';

export const actionSourceAdmissionHeader = 'hyperion-action-admission-v1';
export const actionSourceIngressHeader = 'hyperion-action-source-v1';
export interface ActionSourceIngress {
    schemaVersion: 1; chainId: string; protocolId: string; profileId: string; components: unknown;
    readerSessionId: string; schemaJson: string; frameHex: string; captureSha256: string;
}
export interface RetainedActionSource {
    readonly schemaVersion: 1;
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
    private async put(id: string, value: unknown, signal?: AbortSignal): Promise<void> {
        // The outer bundle uses integer-only JSON; retained opaque JSON may contain finite fractional values.
        await this.bundles.prepare(id, {schemaVersion: 1, payloadJson: actionHistoryImmutableJson(value)}, signal);
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
        if (!source || source.schemaVersion !== 1 || typeof source.frameHex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(source.frameHex)
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
    private compile(source: RetainedActionSource, target: ActionHistoryBlockPlan['target']) {
        const inventory = deriveActionSourceInventory(source.inventoryInput);
        if (source.previousBlockId === null) throw new Error('Missing source predecessor cannot establish complete action membership');
        const plan = validateActionHistoryBlockPlan({schemaVersion: 1,
            source: {chainId: inventory.source.chainId, blockNum: inventory.source.blockNum, blockId: inventory.source.blockId,
                previousBlockId: source.previousBlockId, captureSha256: source.captureSha256}, producer: source.producer, target,
            transactions: inventory.transactions.map(({transactionId, traceOrdinal, traceSha256, disposition}) =>
                ({transactionId, traceOrdinal, traceSha256, disposition}))});
        return {inventory, plan};
    }
    async admit(sourceId: string, targetInput: ActionHistoryBlockPlan['target'], signal?: AbortSignal): Promise<ActionSourceAdmission> {
        const target = copy(targetInput), id = admissionIdentity(sourceId, target);
        return this.bounded(async () => {
            const source = await this.source(sourceId, signal);
            let compiled: ReturnType<ActionSourceAdmissionStore['compile']> | undefined, incomplete: string | null = null;
            try {compiled = this.compile(source, target);} catch (error) {
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
        if (typeof id !== 'string' || !admissionSyntax.test(id)) throw new Error('Invalid action admission handle');
        return this.bounded(async () => {
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
            const {inventory, plan} = this.compile(source, link.target);
            const stored = await this.journal.readPlan(link.planId, signal);
            if (actionHistoryImmutableJson(stored.plan) !== actionHistoryImmutableJson(plan)) throw new Error('Action admission plan mismatch');
            return {id, sourceId: link.sourceId, source, target: link.target, planId: link.planId, inventory, incomplete: null};
        });
    }
    async prepareTransaction(admission: ActionSourceAdmission, traceOrdinal: number, payload: Uint8Array,
                             finalActions: readonly unknown[], signal?: AbortSignal) {
        const detached = copy(finalActions), payloadSha256 = sha(payload);
        const current = await this.resolve(admission.id, signal);
        const transaction = current.inventory?.transactions.find(value => value.traceOrdinal === traceOrdinal);
        if (!current.inventory || !current.planId || !transaction?.dispatch || payloadSha256 !== transaction.dispatch.bodySha256)
            throw new Error('Action admission dispatch/source membership mismatch');
        const actions = validateActionSourceTransactionOutput(current.inventory, traceOrdinal, detached);
        const fragment = await this.journal.recordFragment(current.planId, transaction.transactionId, actions, signal);
        return {actions, fragmentId: fragment.id, planId: current.planId};
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
