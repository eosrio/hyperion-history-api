import {createHash} from 'node:crypto';
import {boundedCanonicalJson} from '../helpers/bounded-json.js';
import {canonicalUint64} from '../helpers/uint64.js';
import {ACTION_SEQUENCE_NAMESPACE, encodeActionSequenceStorage, restoreActionSequenceStorage} from './action-sequence-storage.js';

export interface ActionHistoryTransactionPlan {
    readonly transactionId: string;
    readonly traceOrdinal: number;
    readonly traceSha256: string;
    readonly disposition: 'process' | 'excluded' | 'no-effects';
}

/** Expected source membership, prepared before output publication; surviving ES rows cannot construct it. */
export interface ActionHistoryBlockPlan {
    readonly schemaVersion: 1;
    readonly source: Readonly<{chainId: string; blockNum: number; blockId: string; previousBlockId: string; captureSha256: string}>;
    readonly producer: Readonly<{protocolId: string; profileId: string; codeRevision: string; configurationSha256: string; pluginsSha256: string}>;
    readonly target: Readonly<{name: string; uuid: string}>;
    readonly transactions: readonly ActionHistoryTransactionPlan[];
}

export interface ActionHistoryEffect {
    readonly globalSequence: string;
    readonly documentSha256: string;
    readonly metadataSha256: string;
}

export interface ActionHistoryTransactionFragment {
    readonly schemaVersion: 1;
    readonly planId: string;
    readonly transactionId: string;
    readonly effects: readonly ActionHistoryEffect[];
}

/** Every planned transaction is present, including explicit empty or excluded transactions. No sink authority. */
export interface ActionHistoryBlockManifest {
    readonly schemaVersion: 1;
    readonly planId: string;
    readonly fragments: readonly ActionHistoryTransactionFragment[];
}

export const actionHistoryManifestBounds = Object.freeze({maximumBytes: 128 * 1024 * 1024,
    maximumTransactions: 100_000, maximumEffects: 100_000});

export class ActionHistoryManifestError extends Error {
    readonly code = 'HYPERION_ACTION_HISTORY_MANIFEST_INVALID';
    constructor(message: string) {super(message); this.name = 'ActionHistoryManifestError';}
}

const hex64 = /^[0-9a-f]{64}$/;
const planIdentity = /^h45actionplan1:[0-9a-f]{64}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(message: string): never {throw new ActionHistoryManifestError(message);}
const uint32 = (value: unknown, minimum = 0): value is number => typeof value === 'number' &&
    Number.isSafeInteger(value) && value >= minimum && value <= 0xffffffff;
const text = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && hex64.test(value);
interface PlanContext {plan: ActionHistoryBlockPlan; id: string; transactions: Map<string, ActionHistoryTransactionPlan>}
const validatedPlans = new WeakMap<object, PlanContext>();

function keys(value: any, required: readonly string[]): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === required.length && required.every(field => Object.hasOwn(value, field));
}

/** JSON identity shared by immutable records and effect fingerprints; action data retains all finite numbers. */
export function actionHistoryImmutableJson(input: unknown, maximumBytes = actionHistoryManifestBounds.maximumBytes): string {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > actionHistoryManifestBounds.maximumBytes) {
        fail('Invalid action history JSON byte budget');
    }
    try {
        return boundedCanonicalJson(input, {maximumBytes, numberPolicy: 'finite', errorPrefix: 'Action history record'});
    } catch (error) {
        throw new ActionHistoryManifestError(error instanceof Error ? error.message : String(error));
    }
}

function snapshot(input: unknown): any {return JSON.parse(actionHistoryImmutableJson(input));}

function ownValue(input: unknown, field: string): unknown {
    if (!input || typeof input !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function boundedArray(input: unknown, maximum: number, message: string): void {
    if (Array.isArray(input) && input.length > maximum) fail(message);
}

function boundedFragments(input: unknown): void {
    boundedArray(input, actionHistoryManifestBounds.maximumTransactions, 'Action history block exceeds bounded transaction count');
    if (!Array.isArray(input)) return;
    let effects = 0;
    for (let index = 0; index < input.length; index++) {
        const fragment = ownValue(input, String(index)), members = ownValue(fragment, 'effects');
        if (Array.isArray(members)) {
            effects += members.length;
            if (effects > actionHistoryManifestBounds.maximumEffects) fail('Action history block exceeds bounded effect count');
        }
    }
}

function freeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

function validatePlan(record: any): ActionHistoryBlockPlan {
    if (!keys(record, ['schemaVersion', 'source', 'producer', 'target', 'transactions']) || record.schemaVersion !== 1 ||
        !keys(record.source, ['chainId', 'blockNum', 'blockId', 'previousBlockId', 'captureSha256']) ||
        !digest(record.source.chainId) || !uint32(record.source.blockNum, 1) || !digest(record.source.blockId) ||
        !digest(record.source.previousBlockId) || !digest(record.source.captureSha256) ||
        !keys(record.producer, ['protocolId', 'profileId', 'codeRevision', 'configurationSha256', 'pluginsSha256']) ||
        !text(record.producer.protocolId) || !text(record.producer.profileId) || typeof record.producer.codeRevision !== 'string' ||
        !/^[0-9a-f]{40}$/.test(record.producer.codeRevision) || !digest(record.producer.configurationSha256) ||
        !digest(record.producer.pluginsSha256) || !keys(record.target, ['name', 'uuid']) ||
        typeof record.target.name !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,254}$/.test(record.target.name) ||
        typeof record.target.uuid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.target.uuid) ||
        !Array.isArray(record.transactions) || record.transactions.length > actionHistoryManifestBounds.maximumTransactions) {
        fail('Invalid action history source block plan');
    }
    const transactions = new Set<string>();
    let ordinal = -1;
    for (const transaction of record.transactions) {
        if (!keys(transaction, ['transactionId', 'traceOrdinal', 'traceSha256', 'disposition']) ||
            !digest(transaction.transactionId) || !uint32(transaction.traceOrdinal) || transaction.traceOrdinal <= ordinal ||
            !digest(transaction.traceSha256) || !['process', 'excluded', 'no-effects'].includes(transaction.disposition) ||
            transactions.has(transaction.transactionId)) fail('Invalid or repeated action history transaction plan');
        transactions.add(transaction.transactionId); ordinal = transaction.traceOrdinal;
    }
    return record;
}

export function validateActionHistoryBlockPlan(input: unknown): ActionHistoryBlockPlan {
    if (input && typeof input === 'object' && validatedPlans.has(input)) return input as ActionHistoryBlockPlan;
    boundedArray(ownValue(input, 'transactions'), actionHistoryManifestBounds.maximumTransactions,
        'Action history source block plan exceeds bounded transaction count');
    const plan = freeze(validatePlan(snapshot(input)));
    validatedPlans.set(plan, {plan, id: identity('h45actionplan1:', 'hyperion-action-history-plan-v1', plan),
        transactions: new Map(plan.transactions.map(transaction => [transaction.transactionId, transaction]))});
    return plan;
}

function identity(prefix: string, domain: string, value: unknown): string {
    return prefix + hash(actionHistoryImmutableJson([domain, value]));
}

export function actionHistoryPlanId(input: ActionHistoryBlockPlan): string {
    return planContext(input).id;
}

function planContext(input: ActionHistoryBlockPlan): PlanContext {
    return validatedPlans.get(validateActionHistoryBlockPlan(input))!;
}

function validateEffects(effects: any): void {
    if (!Array.isArray(effects) || effects.length > actionHistoryManifestBounds.maximumEffects) fail('Invalid action history effect list');
    const seen = new Set<string>();
    for (const effect of effects) {
        if (!keys(effect, ['globalSequence', 'documentSha256', 'metadataSha256']) ||
            !digest(effect.documentSha256) || !digest(effect.metadataSha256)) fail('Invalid action history effect fingerprint');
        let sequence: string;
        try {sequence = canonicalUint64(effect.globalSequence);} catch {fail('Invalid action history effect sequence');}
        if (sequence === '0' || seen.has(sequence)) fail('Zero or repeated action history effect sequence');
        seen.add(sequence);
    }
}

function validateFragment(record: any, context: PlanContext): ActionHistoryTransactionFragment {
    if (!keys(record, ['schemaVersion', 'planId', 'transactionId', 'effects']) || record.schemaVersion !== 1 ||
        typeof record.planId !== 'string' || !planIdentity.test(record.planId) || record.planId !== context.id ||
        !digest(record.transactionId)) fail('Invalid action history transaction fragment binding');
    const transaction = context.transactions.get(record.transactionId);
    if (!transaction) fail('Unplanned action history transaction fragment');
    validateEffects(record.effects);
    if (transaction.disposition !== 'process' && record.effects.length !== 0) fail('Excluded or effect-free transaction contains action effects');
    return record;
}

export function validateActionHistoryFragment(input: unknown, planInput: ActionHistoryBlockPlan): ActionHistoryTransactionFragment {
    boundedArray(ownValue(input, 'effects'), actionHistoryManifestBounds.maximumEffects, 'Action history effect list exceeds bounded count');
    return freeze(validateFragment(snapshot(input), planContext(planInput)));
}

export function createActionHistoryFragment(plan: ActionHistoryBlockPlan, transactionId: string,
                                            effects: readonly ActionHistoryEffect[]): ActionHistoryTransactionFragment {
    return validateActionHistoryFragment({schemaVersion: 1, planId: actionHistoryPlanId(plan), transactionId, effects}, plan);
}

export function actionHistoryFragmentId(input: ActionHistoryTransactionFragment, plan: ActionHistoryBlockPlan): string {
    return identity('h45actionfragment1:', 'hyperion-action-history-fragment-v1', validateActionHistoryFragment(input, plan));
}

function assemble(context: PlanContext, fragments: any): ActionHistoryBlockManifest {
    if (!Array.isArray(fragments) || fragments.length !== context.plan.transactions.length) fail('Incomplete action history transaction membership');
    const members = new Map<string, ActionHistoryTransactionFragment>(), effects = new Set<string>();
    for (const input of fragments) {
        const fragment = validateFragment(input, context);
        if (members.has(fragment.transactionId)) fail('Repeated action history transaction fragment');
        members.set(fragment.transactionId, fragment);
        for (const effect of fragment.effects) {
            if (effects.has(effect.globalSequence)) fail('Repeated action history effect across transactions');
            effects.add(effect.globalSequence);
            if (effects.size > actionHistoryManifestBounds.maximumEffects) fail('Action history block exceeds bounded effect count');
        }
    }
    return {schemaVersion: 1, planId: context.id, fragments: context.plan.transactions.map(value => members.get(value.transactionId)!)};
}

/** Arrival order may vary; the sealed manifest always follows the source plan's transaction order. */
export function assembleActionHistoryManifest(planInput: ActionHistoryBlockPlan,
                                              fragments: readonly ActionHistoryTransactionFragment[]): ActionHistoryBlockManifest {
    const context = planContext(planInput);
    if (!Array.isArray(fragments) || fragments.length !== context.plan.transactions.length) fail('Incomplete action history transaction membership');
    boundedFragments(fragments);
    return freeze(assemble(context, snapshot(fragments)));
}

export function validateActionHistoryManifest(input: unknown, planInput: ActionHistoryBlockPlan): ActionHistoryBlockManifest {
    const context = planContext(planInput);
    boundedFragments(ownValue(input, 'fragments'));
    const record = snapshot(input);
    if (!keys(record, ['schemaVersion', 'planId', 'fragments']) || record.schemaVersion !== 1 ||
        record.planId !== context.id) fail('Invalid action history block manifest binding');
    const result = assemble(context, record.fragments);
    if (result.fragments.some((fragment, index) => fragment.transactionId !== record.fragments[index].transactionId)) {
        fail('Action history block manifest is not in source transaction order');
    }
    return freeze(result);
}

export function actionHistoryManifestId(input: ActionHistoryBlockManifest, plan: ActionHistoryBlockPlan): string {
    return identity('h45actionmanifest1:', 'hyperion-action-history-manifest-v1', validateActionHistoryManifest(input, plan));
}

/** Full logical document digest plus independently validated exact metadata; opaque contract fields stay opaque. */
export function fingerprintActionHistoryEffect(logicalGroupedAction: unknown): ActionHistoryEffect {
    try {
        // Validate descriptors and bound the input before structuredClone in the storage codec can read it.
        const logical = snapshot(logicalGroupedAction);
        const physical = encodeActionSequenceStorage(logical);
        const restored = restoreActionSequenceStorage(physical);
        return freeze({globalSequence: restored.global_sequence,
            documentSha256: hash(actionHistoryImmutableJson(restored)),
            metadataSha256: hash(actionHistoryImmutableJson(physical[ACTION_SEQUENCE_NAMESPACE]))});
    } catch (error) {
        if (error instanceof ActionHistoryManifestError) throw error;
        fail('Invalid action history effect: ' + (error instanceof Error ? error.message : String(error)));
    }
}
