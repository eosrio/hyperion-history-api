import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
import {ImmutableProtocolBundleReadError, ImmutableProtocolBundleStore} from '../protocol/immutable-bundle-store.js';
import {
    actionHistoryFragmentId, actionHistoryImmutableJson, actionHistoryManifestBounds, actionHistoryManifestId,
    actionHistoryPlanId, ActionHistoryManifestError, assembleActionHistoryManifest, createActionHistoryFragment,
    fingerprintActionHistoryEffect, validateActionHistoryBlockPlan, validateActionHistoryFragment, validateActionHistoryManifest,
    type ActionHistoryBlockManifest, type ActionHistoryBlockPlan, type ActionHistoryTransactionFragment
} from './action-history-manifest.js';

type RecordKind = 'plan' | 'fragment' | 'fragment-link' | 'manifest' | 'seal';
export class ActionHistorySourceJournalReadError extends Error {
    constructor(readonly code: 'missing' | 'incomplete' | 'invalid', readonly recordKind: RecordKind,
                readonly recordId: string, message: string) {super(message); this.name = 'ActionHistorySourceJournalReadError';}
}

interface FragmentLink {schemaVersion: 1; planId: string; transactionId: string; fragmentId: string}
interface SealLink {schemaVersion: 1; planId: string; manifestId: string}
const hex64 = /^[0-9a-f]{64}$/;
const planSyntax = /^h45actionplan1:[0-9a-f]{64}$/;
const fragmentSyntax = /^h45actionfragment1:[0-9a-f]{64}$/;
const manifestSyntax = /^h45actionmanifest1:[0-9a-f]{64}$/;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const linkId = (planId: string, transactionId: string) => 'h45actiontx1:' + sha256(actionHistoryImmutableJson(
    ['hyperion-action-history-transaction-link-v1', {planId, transactionId}]));
const sealId = (planId: string) => 'h45actionseal1:' + sha256(actionHistoryImmutableJson(['hyperion-action-history-seal-link-v1', planId]));
const keys = (value: any, fields: readonly string[]) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
function invalid(message: string): never {throw new ActionHistoryManifestError(message);}

/**
 * Durable expected source membership only. No sink completion, canonicality, visibility or query authority.
 * Links publish last; every write result requires all configured copies. Partial data is retained for retry.
 */
export class ActionHistorySourceJournal {
    readonly index: string;
    private readonly bundles: ImmutableProtocolBundleStore;
    private readonly readOnly: boolean;
    private operations = 0;

    constructor(client: Client, private readonly chain: string, replicas = 0, options: {readOnly?: boolean} = {}) {
        this.readOnly = options.readOnly === true;
        this.bundles = new ImmutableProtocolBundleStore(client, chain, replicas, 'action-source-journal',
            'history-source-journal-v1', undefined, {readOnly: this.readOnly});
        this.index = this.bundles.index;
    }

    private writable(signal?: AbortSignal): void {
        signal?.throwIfAborted();
        if (this.readOnly) throw new Error('Read-only action source journal cannot prepare records');
    }

    private async boundedOperation<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
        signal?.throwIfAborted();
        // Refuse excess work rather than retaining an unbounded queue of caller batches.
        if (this.operations >= 4) throw new Error('Action source journal concurrent operation budget exhausted');
        this.operations++;
        try {
            const result = await work();
            signal?.throwIfAborted();
            return result;
        } finally {this.operations--;}
    }

    private planId(input: unknown): asserts input is string {
        if (typeof input !== 'string' || !planSyntax.test(input)) invalid('Invalid action source journal plan ID');
    }

    private target(plan: ActionHistoryBlockPlan): void {
        const prefix = this.chain + '-action-';
        if (!plan.target.name.startsWith(prefix) || plan.target.name.length === prefix.length) {
            invalid('Action source journal target does not belong to the configured chain action namespace');
        }
    }

    private async read(kind: RecordKind, id: string, signal?: AbortSignal): Promise<unknown> {
        signal?.throwIfAborted();
        try {
            const value = await this.bundles.read(id, signal);
            signal?.throwIfAborted();
            return value;
        } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof ImmutableProtocolBundleReadError) {
                throw new ActionHistorySourceJournalReadError(error.code, kind, id, error.message);
            }
            throw error;
        }
    }

    private async referenced<T>(operation: () => Promise<T>): Promise<T> {
        try {return await operation();} catch (error) {
            if (error instanceof ActionHistorySourceJournalReadError && error.code === 'missing') {
                throw new ActionHistorySourceJournalReadError('incomplete', error.recordKind, error.recordId,
                    'Action source journal reference is missing: ' + error.recordId);
            }
            throw error;
        }
    }

    private validate<T>(kind: RecordKind, id: string, work: () => T): T {
        try {return work();} catch (error) {
            if (error instanceof ActionHistoryManifestError) {
                throw new ActionHistorySourceJournalReadError('invalid', kind, id, error.message);
            }
            throw error;
        }
    }

    async preparePlan(input: ActionHistoryBlockPlan, signal?: AbortSignal): Promise<{id: string; plan: ActionHistoryBlockPlan}> {
        this.writable(signal);
        const plan = validateActionHistoryBlockPlan(input), id = actionHistoryPlanId(plan);
        this.target(plan);
        return this.boundedOperation(signal, async () => {
            await this.bundles.prepare(id, plan, signal);
            return {id, plan};
        });
    }

    async readPlan(id: string, signal?: AbortSignal): Promise<{id: string; plan: ActionHistoryBlockPlan}> {
        signal?.throwIfAborted(); this.planId(id);
        return this.boundedOperation(signal, () => this.loadPlan(id, signal));
    }

    private async loadPlan(id: string, signal?: AbortSignal): Promise<{id: string; plan: ActionHistoryBlockPlan}> {
        const input = await this.read('plan', id, signal);
        const plan = this.validate('plan', id, () => {
            const plan = validateActionHistoryBlockPlan(input);
            this.target(plan);
            if (actionHistoryPlanId(plan) !== id) invalid('Action source journal plan identity mismatch');
            return plan;
        });
        return {id, plan};
    }

    async recordFragment(planId: string, transactionId: string, logicalActions: readonly unknown[],
                         signal?: AbortSignal): Promise<{id: string; fragment: ActionHistoryTransactionFragment}> {
        this.writable(signal); this.planId(planId);
        if (typeof transactionId !== 'string' || !hex64.test(transactionId)) invalid('Invalid action source journal transaction ID');
        if (!Array.isArray(logicalActions) || logicalActions.length > actionHistoryManifestBounds.maximumEffects) {
            invalid('Action source journal actions exceed the bounded effect count');
        }
        // Detach the entire caller batch before the first await, including all opaque contract data.
        const actions: any[] = JSON.parse(actionHistoryImmutableJson(logicalActions));
        const effects = actions.map(action => {
            if (!action || typeof action !== 'object' || Array.isArray(action) || action.trx_id !== transactionId ||
                !Number.isSafeInteger(action.block_num) || action.block_num < 1 || action.block_num > 0xffffffff ||
                (Object.hasOwn(action, 'block_id') && (typeof action.block_id !== 'string' || !hex64.test(action.block_id)))) {
                invalid('Action source journal action has an invalid block or transaction association');
            }
            return fingerprintActionHistoryEffect(action);
        });
        return this.boundedOperation(signal, async () => {
            const {plan} = await this.loadPlan(planId, signal);
            for (const action of actions) {
                if (action.block_num !== plan.source.blockNum ||
                    (Object.hasOwn(action, 'block_id') && action.block_id !== plan.source.blockId)) {
                    invalid('Action source journal action does not match the planned source block');
                }
            }
            const fragment = createActionHistoryFragment(plan, transactionId, effects), id = actionHistoryFragmentId(fragment, plan);
            const link: FragmentLink = {schemaVersion: 1, planId, transactionId, fragmentId: id};
            await this.bundles.prepare(planId, plan, signal);
            await this.bundles.prepare(id, fragment, signal);
            await this.bundles.prepare(linkId(planId, transactionId), link, signal);
            return {id, fragment};
        });
    }

    private async readFragment(planId: string, transactionId: string, plan: ActionHistoryBlockPlan,
                               signal?: AbortSignal): Promise<{id: string; fragment: ActionHistoryTransactionFragment; link: FragmentLink}> {
        const stableId = linkId(planId, transactionId);
        const input: any = await this.read('fragment-link', stableId, signal);
        const link: FragmentLink = this.validate('fragment-link', stableId, () => {
            if (!keys(input, ['schemaVersion', 'planId', 'transactionId', 'fragmentId']) || input.schemaVersion !== 1 ||
                input.planId !== planId || input.transactionId !== transactionId || typeof input.fragmentId !== 'string' ||
                !fragmentSyntax.test(input.fragmentId)) invalid('Invalid action source journal transaction link');
            return input;
        });
        const value = await this.referenced(() => this.read('fragment', link.fragmentId, signal));
        const fragment = this.validate('fragment', link.fragmentId, () => {
            const fragment = validateActionHistoryFragment(value, plan);
            if (fragment.transactionId !== transactionId || actionHistoryFragmentId(fragment, plan) !== link.fragmentId) {
                invalid('Action source journal fragment identity mismatch');
            }
            return fragment;
        });
        return {id: link.fragmentId, fragment, link};
    }

    async seal(planId: string, signal?: AbortSignal): Promise<{id: string; manifest: ActionHistoryBlockManifest}> {
        this.writable(signal); this.planId(planId);
        return this.boundedOperation(signal, () => this.sealPlan(planId, signal));
    }

    private async sealPlan(planId: string, signal?: AbortSignal): Promise<{id: string; manifest: ActionHistoryBlockManifest}> {
        const {plan} = await this.loadPlan(planId, signal);
        const fragments: ActionHistoryTransactionFragment[] = [];
        let effects = 0, bytes = Buffer.byteLength(actionHistoryImmutableJson({schemaVersion: 1, planId, fragments: []}));
        // Sequential I/O bounds concurrency independently of transaction count; no persistent plan/fragment cache.
        await this.bundles.prepare(planId, plan, signal);
        for (const transaction of plan.transactions) {
            const value = await this.referenced(() => this.readFragment(planId, transaction.transactionId, plan, signal));
            effects += value.fragment.effects.length;
            bytes += Buffer.byteLength(actionHistoryImmutableJson(value.fragment)) + (fragments.length > 0 ? 1 : 0);
            if (effects > actionHistoryManifestBounds.maximumEffects || bytes > actionHistoryManifestBounds.maximumBytes) {
                invalid('Action source journal block exceeds bounded manifest membership');
            }
            await this.bundles.prepare(value.id, value.fragment, signal);
            await this.bundles.prepare(linkId(planId, transaction.transactionId), value.link, signal);
            fragments.push(value.fragment);
        }
        const manifest = assembleActionHistoryManifest(plan, fragments), id = actionHistoryManifestId(manifest, plan);
        await this.bundles.prepare(id, manifest, signal);
        const seal: SealLink = {schemaVersion: 1, planId, manifestId: id};
        await this.bundles.prepare(sealId(planId), seal, signal);
        signal?.throwIfAborted();
        return {id, manifest};
    }

    /** Reads verified membership and references, not an all-copy write receipt or coverage certificate. */
    async readManifest(planId: string, signal?: AbortSignal): Promise<{id: string; manifest: ActionHistoryBlockManifest}> {
        signal?.throwIfAborted(); this.planId(planId);
        return this.boundedOperation(signal, () => this.loadManifest(planId, signal));
    }

    private async loadManifest(planId: string, signal?: AbortSignal): Promise<{id: string; manifest: ActionHistoryBlockManifest}> {
        const stableId = sealId(planId), input: any = await this.read('seal', stableId, signal);
        const seal: SealLink = this.validate('seal', stableId, () => {
            if (!keys(input, ['schemaVersion', 'planId', 'manifestId']) || input.schemaVersion !== 1 || input.planId !== planId ||
                typeof input.manifestId !== 'string' || !manifestSyntax.test(input.manifestId)) invalid('Invalid action source journal seal link');
            return input;
        });
        const {plan} = await this.referenced(() => this.loadPlan(planId, signal));
        const record = await this.referenced(() => this.read('manifest', seal.manifestId, signal));
        const manifest = this.validate('manifest', seal.manifestId, () => {
            const manifest = validateActionHistoryManifest(record, plan);
            if (actionHistoryManifestId(manifest, plan) !== seal.manifestId) invalid('Action source journal manifest identity mismatch');
            return manifest;
        });
        for (const expected of manifest.fragments) {
            const value = await this.referenced(() => this.readFragment(planId, expected.transactionId, plan, signal));
            if (value.id !== actionHistoryFragmentId(expected, plan)) {
                throw new ActionHistorySourceJournalReadError('invalid', 'fragment-link', linkId(planId, expected.transactionId),
                    'Action source journal manifest and fragment link disagree');
            }
        }
        signal?.throwIfAborted();
        return {id: seal.manifestId, manifest};
    }
}
