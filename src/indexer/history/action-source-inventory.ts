import {createHash} from 'node:crypto';
import type {ProtocolAbiActionInput} from '@eosrio/hyperion-sdk/protocol';
import {compatibleUint64, canonicalUint64} from '../helpers/uint64.js';
import {actionHistoryImmutableJson, actionHistoryManifestBounds} from './action-history-manifest.js';

export type ActionSourceInventoryProfile = 'antelope-default-v1' |
    'wire-sysio-6508c9e8-engineering-v1' | 'wire-sysio-7dede884-engineering-v1';

/** The actual effective policy, captured by the host's immutable producer epoch. */
export interface ActionSourceInventoryPolicy {
    readonly schemaVersion: 1;
    readonly parserVersion: '3.2';
    readonly actionBlacklist: readonly string[];
    readonly actionWhitelist: readonly string[];
    /** Effective root-only guard: root_only and nonempty configured action/delta whitelists. */
    readonly rootOnly: boolean;
    readonly maxDepth: number;
    readonly maxInline: number;
    readonly eosioAlias: string;
}

export interface ActionSourceInventoryPosition {
    readonly chainId: string;
    readonly blockNum: number;
    readonly blockId: string;
    readonly producer: string;
    readonly timestamp: string;
}

/** Only decoded original source and policy enter this interface, never DS-produced expectations.
 * The host resolves and verifies their retained capture/provenance before each derivation. */
export interface ActionSourceInventoryInput {
    readonly profileId: ActionSourceInventoryProfile;
    readonly source: ActionSourceInventoryPosition;
    readonly policy: ActionSourceInventoryPolicy;
    readonly traces: unknown;
    /** All eligible packed-block root actions, decoded under the original protocol context. */
    readonly rootActions?: readonly Readonly<{account: string; name: string}>[];
    /** Original observeBlockAbi facts, checked against every unfiltered Wire occurrence below. */
    readonly wireActionInputs?: readonly ProtocolAbiActionInput[];
    readonly sourceSelectionId?: string;
}

export interface ActionSourceDispatch {
    readonly body: Readonly<Record<string, unknown>>;
    /** Exact canonical bytes used by bodySha256; transport-frame bytes have their own digest. */
    readonly canonicalJson: string;
    readonly bodySha256: string;
    readonly actionOrdinals: readonly number[];
    readonly inlineCount: number;
    readonly filtered: boolean;
}

export interface ActionSourceExpectedGroup {
    readonly actionOrdinals: readonly number[];
    readonly representativeActionOrdinal: number;
    readonly inputActionOrdinal: number | null;
    /** Complete known final source/identity/receipt/counter and first-action usage metadata. */
    readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ActionSourceOccurrenceInventory {
    readonly sourceOrdinal: number;
    readonly actionOrdinal: number;
    readonly creatorActionOrdinal: number;
    readonly inputActionOrdinal: number | null;
    readonly globalSequence: string | null;
    readonly disposition: 'process' | 'excluded' | 'no-effects';
    readonly reason: 'root-only' | 'max-inline' | 'transaction-filter' | 'action-filter' | 'exception' | null;
}

export interface ActionSourceTransactionInventory {
    readonly transactionId: string;
    readonly traceOrdinal: number;
    /** Canonical hash of the complete original trace variant, before any trimming/enrichment. */
    readonly traceSha256: string;
    readonly disposition: 'process' | 'excluded' | 'no-effects';
    readonly dispatch: ActionSourceDispatch | null;
    /** parseAction returns true even for an allowed Antelope action with an exception. */
    readonly parsedActionCount: number;
    readonly occurrences: readonly ActionSourceOccurrenceInventory[];
    readonly groups: readonly ActionSourceExpectedGroup[];
}

export interface ActionSourceInventory {
    readonly schemaVersion: 1;
    readonly profileId: ActionSourceInventoryProfile;
    readonly source: ActionSourceInventoryPosition;
    readonly policy: ActionSourceInventoryPolicy;
    readonly policySha256: string;
    readonly sourceSelectionId: string | null;
    readonly rootAllowed: boolean;
    readonly transactions: readonly ActionSourceTransactionInventory[];
}

export class ActionSourceInventoryError extends Error {
    readonly code = 'HYPERION_ACTION_SOURCE_INVENTORY_INCOMPLETE';
    constructor(message: string) {super(message); this.name = 'ActionSourceInventoryError';}
}

type ObjectValue = Record<string, any>;
interface Occurrence {
    action: ObjectValue;
    receipt: ObjectValue | null;
    ordinal: number;
    creator: number;
    input?: ProtocolAbiActionInput;
}
const profiles = new Set<ActionSourceInventoryProfile>(['antelope-default-v1',
    'wire-sysio-6508c9e8-engineering-v1', 'wire-sysio-7dede884-engineering-v1']);
const issued = new WeakMap<ActionSourceInventory, Map<number, ActionSourceTransactionInventory>>();
const hex64 = /^[0-9a-f]{64}$/i;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => actionHistoryImmutableJson(value);
const copy = <T>(value: T): T => JSON.parse(json(value));
const fail = (message: string): never => {throw new ActionSourceInventoryError(message);};
function requireValue(value: unknown, message: string): asserts value {if (!value) fail(message);}
function object(value: unknown, message = 'Invalid source object'): ObjectValue {
    requireValue(value && typeof value === 'object' && !Array.isArray(value), message);
    return value as ObjectValue;
}
function uint32(value: unknown, minimum = 0): number {
    requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 0xffffffff,
        'Invalid source uint32 metadata');
    return value;
}
function text(value: unknown, empty = false): string {
    requireValue(typeof value === 'string' && value.length <= 256 && (empty || value.length > 0), 'Invalid source name or text');
    return value;
}
function digest(value: unknown): string {
    requireValue(typeof value === 'string' && hex64.test(value), 'Invalid source digest');
    return value;
}
function sequence(value: unknown, positive = false, final = false): string {
    const result = final ? canonicalUint64(value) : compatibleUint64(value);
    requireValue(!positive || result !== '0', 'Zero committed source sequence');
    return result;
}
function variant(value: unknown, names: readonly string[]): ObjectValue {
    requireValue(Array.isArray(value) && value.length === 2 && names.includes(value[0]), 'Unsupported source variant');
    return object(value[1]);
}
function freeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}
function matches(entries: ReadonlySet<string>, act: ObjectValue): boolean {
    return entries.has(act.account + '::*') || entries.has('*::' + act.name) || entries.has(act.account + '::' + act.name);
}
function authorization(value: unknown): ObjectValue[] {
    requireValue(Array.isArray(value), 'Missing source action authorization');
    return value.map(member => {
        const entry = object(member);
        requireValue(Object.keys(entry).length === 2, 'Unknown source action authorization metadata');
        return {actor: text(entry.actor), permission: text(entry.permission)};
    });
}
function receipt(value: unknown, wire: boolean, final = false): ObjectValue {
    const entry = object(value, 'Missing source receipt');
    const required = ['receiver', 'global_sequence', 'recv_sequence', 'auth_sequence'];
    const optional = final ? (wire ? ['code_sequence', 'abi_sequence'] : []) : ['act_digest', 'code_sequence', 'abi_sequence'];
    requireValue(required.every(field => Object.hasOwn(entry, field)) &&
        Object.keys(entry).every(field => required.includes(field) || optional.includes(field)), 'Unknown or missing source receipt metadata');
    requireValue(Array.isArray(entry.auth_sequence), 'Missing source authorization sequence metadata');
    const result: ObjectValue = {receiver: text(entry.receiver), global_sequence: sequence(entry.global_sequence, true, final),
        recv_sequence: sequence(entry.recv_sequence, false, final), auth_sequence: entry.auth_sequence.map(member => {
            const auth = object(member);
            requireValue(Object.keys(auth).length === 2, 'Unknown authorization sequence metadata');
            return {account: text(auth.account), sequence: sequence(auth.sequence, false, final)};
        })};
    if (!final) result.act_digest = digest(entry.act_digest);
    for (const counter of ['code_sequence', 'abi_sequence']) {
        if (!final || wire) result[counter] = uint32(entry[counter]);
    }
    return result;
}
function rawOccurrence(value: unknown, wire: boolean): Occurrence {
    const action = variant(value, ['action_trace_v0', 'action_trace_v1']);
    const ordinal = uint32(action.action_ordinal, 1), creator = uint32(action.creator_action_ordinal);
    const act = object(action.act);
    text(act.account); text(act.name, true); authorization(act.authorization);
    requireValue(typeof act.data === 'string' && /^(?:[0-9a-f]{2})*$/i.test(act.data), 'Source action bytes must be original hex');
    text(action.receiver);
    requireValue(typeof action.context_free === 'boolean' || action.context_free === 0 || action.context_free === 1,
        'Invalid source context-free flag');
    requireValue(Object.hasOwn(action, 'except') && Object.hasOwn(action, 'error_code'), 'Missing source action failure metadata');
    let normalized: ObjectValue | null = null;
    if (action.receipt !== null && action.receipt !== undefined) {
        normalized = receipt(variant(action.receipt, ['action_receipt_v0']), wire);
        requireValue(normalized.receiver === action.receiver, 'Source action and receipt receiver disagree');
    }
    if (action.except === null) requireValue(normalized, 'Committed source action has no receipt');
    if (wire) requireValue(action.except === null && action.error_code === null, 'Unsupported failed Wire action semantics');
    return {action, receipt: normalized, ordinal, creator};
}
function sourcePolicy(value: ActionSourceInventoryPolicy): ActionSourceInventoryPolicy {
    const result = object(value);
    requireValue(Object.keys(result).length === 8 && result.schemaVersion === 1 && result.parserVersion === '3.2' &&
        typeof result.rootOnly === 'boolean', 'Unsupported source inventory policy');
    for (const field of ['actionBlacklist', 'actionWhitelist']) {
        requireValue(Array.isArray(result[field]), 'Missing effective source filters');
        result[field] = [...new Set(result[field].map((entry: unknown) => {
            const pattern = text(entry);
            requireValue(pattern.split('::').length === 2 && pattern.split('::').every(part => part.length > 0),
                'Expected normalized account::action filter');
            return pattern;
        }))].sort();
    }
    uint32(result.maxDepth); uint32(result.maxInline); text(result.eosioAlias);
    return result as ActionSourceInventoryPolicy;
}
function signatures(trace: ObjectValue): unknown[] {
    try {
        const partial = trace.partial;
        const result = partial?.[1]?.signatures ?? partial?.[1]?.prunable_data?.prunable_data?.[1]?.signatures ?? [];
        requireValue(Array.isArray(result) && result.every(value => typeof value === 'string'), 'Invalid source signatures');
        return result;
    } catch {return [];}
}
function wireInputs(input: ActionSourceInventoryInput, transactions: readonly {id: string; occurrences: Occurrence[]}[]): void {
    requireValue(Array.isArray(input.wireActionInputs), 'Wire inventory needs original source observation facts');
    const expected = new Map<string, Occurrence>();
    for (const transaction of transactions) for (const occurrence of transaction.occurrences) {
        expected.set(transaction.id + ':' + occurrence.ordinal, occurrence);
    }
    requireValue(input.wireActionInputs.length === expected.size, 'Incomplete Wire source observation membership');
    for (const fact of input.wireActionInputs) {
        const fields = ['transactionId', 'actionOrdinal', 'receiver', 'account', 'name', 'rawHex', 'globalSequence',
            'receiptAbiSequence', 'inputActionOrdinal'];
        requireValue(fact && typeof fact === 'object' && Object.keys(fact).length === fields.length &&
            fields.every(field => Object.hasOwn(fact, field)), 'Invalid original Wire observation metadata');
        uint32(fact.actionOrdinal, 1);
        const key = fact.transactionId + ':' + fact.actionOrdinal, occurrence = expected.get(key);
        requireValue(occurrence, 'Unplanned or repeated Wire source observation');
        const {action, receipt: sourceReceipt} = occurrence;
        requireValue(sourceReceipt && fact.receiver === action.receiver && fact.account === action.act.account &&
            fact.name === action.act.name && fact.rawHex === action.act.data && fact.globalSequence === sourceReceipt.global_sequence &&
            fact.receiptAbiSequence === String(sourceReceipt.abi_sequence), 'Wire observation does not match original source occurrence');
        uint32(fact.inputActionOrdinal, 1);
        occurrence.input = fact;
        expected.delete(key);
    }
    // Independently check the supplied origins against complete original ancestry and action identity.
    for (const transaction of transactions) {
        const byOrdinal = new Map(transaction.occurrences.map(value => [value.ordinal, value]));
        const identity = (value: Occurrence) => json([value.action.act.account, value.action.act.name,
            authorization(value.action.act.authorization), value.action.act.data, Boolean(value.action.context_free)]);
        const identities = new Map(transaction.occurrences.map(value => [value.ordinal, identity(value)]));
        const origins = new Map<number, number>();
        for (const occurrence of transaction.occurrences) {
            if (occurrence.creator > 0) {
                const parent = byOrdinal.get(occurrence.creator);
                requireValue(parent && parent.receipt && occurrence.receipt &&
                    BigInt(parent.receipt.global_sequence) < BigInt(occurrence.receipt.global_sequence), 'Invalid Wire creator ancestry');
            }
            let origin = occurrence;
            const path: number[] = [];
            while (!origins.has(origin.ordinal) && origin.action.receiver !== origin.action.act.account) {
                requireValue(path.length < 64, 'Wire notification ancestry exceeds bounded depth'); path.push(origin.ordinal);
                const parent = byOrdinal.get(origin.creator);
                requireValue(parent && identities.get(parent.ordinal) === identities.get(origin.ordinal) && parent.receipt && origin.receipt &&
                    BigInt(parent.receipt.global_sequence) < BigInt(origin.receipt.global_sequence), 'Invalid Wire notification ancestry');
                origin = parent;
            }
            const inputOrdinal = origins.get(origin.ordinal) ?? origin.ordinal;
            origins.set(origin.ordinal, inputOrdinal);
            for (const ordinal of path) origins.set(ordinal, inputOrdinal);
            requireValue(occurrence.input?.inputActionOrdinal === inputOrdinal, 'Wire origin does not match original source ancestry');
        }
    }
}
function expectedGroups(source: ActionSourceInventoryPosition, transactionId: string, selected: Occurrence[],
                        dispatch: ActionSourceDispatch, policy: ActionSourceInventoryPolicy, wire: boolean,
                        selectionId: string | null): ActionSourceExpectedGroup[] {
    const committed = selected.filter(value => value.action.except === null);
    const metadata = new Map<number, ObjectValue>();
    let usageIncluded = false;
    for (const occurrence of committed) {
        const {action, receipt: sourceReceipt} = occurrence;
        const result: ObjectValue = {'@timestamp': source.timestamp, block_num: source.blockNum, block_id: source.blockId,
            producer: source.producer, trx_id: transactionId, action_ordinal: occurrence.ordinal,
            creator_action_ordinal: occurrence.creator, global_sequence: sourceReceipt!.global_sequence,
            act: {account: action.act.account, name: action.act.name, authorization: authorization(action.act.authorization)}};
        if (action.context_free !== false) result.context_free = action.context_free;
        if (action.error_code !== null) result.error_code = action.error_code;
        if (wire) result.protocol = {schemaVersion: 1,
            source: {chainId: source.chainId, blockNum: source.blockNum, blockId: source.blockId},
            selectionId, input: occurrence.input};
        if (!usageIncluded) {
            const body = dispatch.body;
            result.cpu_usage_us = body.cpu_usage_us;
            if (body.net_usage_words !== 0) result.net_usage_words = body.net_usage_words;
            if ((body.signatures as unknown[]).length) result.signatures = body.signatures;
            if ((body.action_traces as unknown[]).length > 1) {
                result.inline_count = dispatch.inlineCount - 1;
                result.inline_filtered = dispatch.filtered;
                if (dispatch.filtered && policy.maxInline) result.max_inline = policy.maxInline;
            }
            usageIncluded = !(action.act.account === policy.eosioAlias + '.null' && action.act.name === 'nonce');
        }
        metadata.set(occurrence.ordinal, result);
    }
    const digestByOrdinal = new Map(committed.map(value => [value.ordinal, value.receipt!.act_digest]));
    const groups = new Map<string, Occurrence[]>();
    for (const occurrence of committed) {
        const canonical = occurrence.creator > 0 && digestByOrdinal.get(occurrence.creator) === occurrence.receipt!.act_digest
            ? occurrence.creator : occurrence.ordinal;
        const key = wire ? String(occurrence.input!.inputActionOrdinal) : occurrence.receipt!.act_digest + ':' + canonical;
        const group = groups.get(key) ?? []; group.push(occurrence); groups.set(key, group);
    }
    return [...groups.values()].map(members => {
        const representative = wire ? members.find(value => value.ordinal === value.input!.inputActionOrdinal) ?? members[0] : members[0];
        const result = metadata.get(representative.ordinal)!;
        const counterReceipt = wire ? representative.receipt! : members[members.length - 1].receipt!;
        result.code_sequence = counterReceipt.code_sequence; result.abi_sequence = counterReceipt.abi_sequence;
        result.act_digest = members[0].receipt!.act_digest;
        result.receipts = members.map(value => {
            const entry = {...value.receipt}; delete entry.act_digest;
            if (!wire) {delete entry.code_sequence; delete entry.abi_sequence;}
            return entry;
        });
        return {actionOrdinals: members.map(value => value.ordinal), representativeActionOrdinal: representative.ordinal,
            inputActionOrdinal: wire ? representative.input!.inputActionOrdinal : null, metadata: result};
    });
}

/** Rehydration re-runs this derivation from verified retained inputs. Serialized inventory alone is never issued. */
export function deriveActionSourceInventory(original: ActionSourceInventoryInput): ActionSourceInventory {
    try {
        const input = copy(original);
        requireValue(Array.isArray(input.traces) && input.traces.length <= actionHistoryManifestBounds.maximumTransactions,
            'Complete bounded original trace vector is required');
        const wire = input.profileId !== 'antelope-default-v1';
        requireValue(profiles.has(input.profileId), 'Unqualified source inventory profile');
        const source = object(input.source) as unknown as ActionSourceInventoryPosition;
        digest(source.chainId); digest(source.blockId); uint32(source.blockNum, 1); text(source.producer, true); text(source.timestamp, true);
        const policy = sourcePolicy(input.policy), blacklist = new Set(policy.actionBlacklist), whitelist = new Set(policy.actionWhitelist);
        const selectionId = input.sourceSelectionId ?? null;
        if (wire) requireValue(typeof selectionId === 'string' && /^h45srcsel1:[0-9a-f]{64}$/.test(selectionId), 'Wire source selection is required');
        else requireValue(input.wireActionInputs === undefined, 'Antelope source cannot use Wire observation expectations');
        let rootAllowed = true;
        if (policy.rootOnly) {
            requireValue(Array.isArray(input.rootActions), 'Root-only requires original packed-block root actions');
            const roots = input.rootActions.map(value => ({account: text(value.account), name: text(value.name, true)}));
            rootAllowed = roots.some(value => matches(whitelist, value));
        }
        const seenTransactions = new Set<string>(), seenSequences = new Set<string>();
        let actionCount = 0;
        const parsed = (input.traces as unknown[]).map((raw, traceOrdinal) => {
            const trace = variant(raw, ['transaction_trace_v0']);
            const id = digest(trace.id).toLowerCase();
            requireValue(!seenTransactions.has(id), 'Repeated original source transaction'); seenTransactions.add(id);
            requireValue(trace.status === 0 && (trace.scheduled === false || trace.scheduled === 0) && trace.failed_dtrx_trace === null &&
                trace.except === null && trace.error_code === null, 'Unsupported source transaction/failure/deferred semantics');
            requireValue(Array.isArray(trace.action_traces), 'Missing complete source action vector');
            actionCount += trace.action_traces.length;
            requireValue(actionCount <= actionHistoryManifestBounds.maximumEffects, 'Original action membership exceeds bounded count');
            const seenOrdinals = new Set<number>();
            const occurrences: Occurrence[] = trace.action_traces.map((value: unknown) => {
                const occurrence = rawOccurrence(value, wire);
                requireValue(!seenOrdinals.has(occurrence.ordinal), 'Repeated original action ordinal'); seenOrdinals.add(occurrence.ordinal);
                if (occurrence.receipt) {
                    const sequence = occurrence.receipt.global_sequence;
                    requireValue(!seenSequences.has(sequence), 'Repeated original source global sequence'); seenSequences.add(sequence);
                }
                return occurrence;
            });
            uint32(trace.cpu_usage_us); uint32(trace.net_usage_words);
            return {id, trace, raw, traceOrdinal, occurrences};
        });
        if (wire) wireInputs(input, parsed);
        const transactions: ActionSourceTransactionInventory[] = parsed.map(({id, raw, trace, traceOrdinal, occurrences}) => {
            const traceSha256 = hash(json(raw));
            const retained = policy.maxInline && occurrences.length > policy.maxInline ? occurrences.slice(0, policy.maxInline) : occurrences;
            const filtered = retained.length !== occurrences.length;
            const allowedByRoute = rootAllowed && retained.length > 0 && !matches(blacklist, retained[0].action.act) &&
                (whitelist.size === 0 || retained.some((value, index) => (!policy.maxDepth || index <= policy.maxDepth) && matches(whitelist, value.action.act)));
            let dispatch: ActionSourceDispatch | null = null, groups: ActionSourceExpectedGroup[] = [], parsedActionCount = 0;
            if (allowedByRoute) {
                const body = {...trace, action_traces: trace.action_traces.slice(0, retained.length), signatures: signatures(trace)};
                const canonicalJson = json(body);
                dispatch = {body, canonicalJson, bodySha256: hash(canonicalJson), actionOrdinals: retained.map(value => value.ordinal),
                    inlineCount: occurrences.length, filtered};
                const selected = retained.filter(value => !matches(blacklist, value.action.act) && (whitelist.size === 0 || matches(whitelist, value.action.act)));
                parsedActionCount = selected.length;
                groups = expectedGroups(source, id, selected, dispatch, policy, wire, selectionId);
            }
            const disposition = !rootAllowed || (occurrences.length > 0 && !allowedByRoute) ? 'excluded' : groups.length ? 'process' : 'no-effects';
            const membership: ActionSourceOccurrenceInventory[] = occurrences.map((value, sourceOrdinal) => {
                let reason: ActionSourceOccurrenceInventory['reason'] = null;
                if (!rootAllowed) reason = 'root-only';
                else if (sourceOrdinal >= retained.length) reason = 'max-inline';
                else if (!allowedByRoute) reason = 'transaction-filter';
                else if (matches(blacklist, value.action.act) || (whitelist.size > 0 && !matches(whitelist, value.action.act))) reason = 'action-filter';
                else if (value.action.except !== null) reason = 'exception';
                return {sourceOrdinal, actionOrdinal: value.ordinal, creatorActionOrdinal: value.creator,
                    inputActionOrdinal: value.input?.inputActionOrdinal ?? null, globalSequence: value.receipt?.global_sequence ?? null,
                    disposition: reason === 'exception' ? 'no-effects' : reason ? 'excluded' : 'process', reason};
            });
            return {transactionId: id, traceOrdinal, traceSha256, disposition, dispatch, parsedActionCount, occurrences: membership, groups};
        });
        const inventory: ActionSourceInventory = freeze({schemaVersion: 1, profileId: input.profileId, source, policy,
            policySha256: hash(json(policy)), sourceSelectionId: selectionId, rootAllowed, transactions});
        issued.set(inventory, new Map(transactions.map(value => [value.traceOrdinal, value])));
        return inventory;
    } catch (error) {
        if (error instanceof ActionSourceInventoryError) throw error;
        return fail('Invalid source inventory input: ' + (error instanceof Error ? error.message : String(error)));
    }
}

/** Checks the whole final transaction before journal/publication. Opaque contract data is detached unchanged. */
export function validateActionSourceTransactionOutput(inventory: ActionSourceInventory, traceOrdinal: number,
                                                       finalActions: readonly unknown[]): readonly Readonly<Record<string, unknown>>[] {
    try {
        const members = issued.get(inventory);
        requireValue(members, 'Inventory must be re-derived from retained original source, not deserialized expectations');
        const transaction = members.get(traceOrdinal);
        requireValue(transaction && Array.isArray(finalActions) && finalActions.length === transaction.groups.length, 'Incomplete final action group membership');
        const detached = copy(finalActions);
        const wire = inventory.profileId !== 'antelope-default-v1';
        for (let index = 0; index < detached.length; index++) {
            const action = object(detached[index]), expected = transaction.groups[index].metadata;
            requireValue(!Object.hasOwn(action, 'receipt') && !Object.hasOwn(action, 'receiver') && !Object.hasOwn(action, 'except') &&
                !Object.hasOwn(action, 'h45_sequences_v1'), 'Expected final normalized grouped action');
            if (wire) requireValue(!Object.hasOwn(action, 'ds_error'), 'Incomplete Wire decoding cannot certify a source batch');
            requireValue(Array.isArray(action.receipts) && action.receipts.length > 0, 'Missing final receipt membership');
            const act = object(action.act);
            const actual: ObjectValue = {};
            for (const field of ['@timestamp', 'block_num', 'block_id', 'producer', 'trx_id', 'action_ordinal', 'creator_action_ordinal',
                'global_sequence', 'act_digest', 'code_sequence', 'abi_sequence', 'context_free', 'error_code', 'cpu_usage_us',
                'net_usage_words', 'signatures', 'inline_count', 'inline_filtered', 'max_inline', 'protocol']) {
                if (Object.hasOwn(action, field)) actual[field] = action[field];
            }
            actual.global_sequence = sequence(action.global_sequence, true, true);
            actual.code_sequence = uint32(action.code_sequence); actual.abi_sequence = uint32(action.abi_sequence);
            actual.act = {account: text(act.account), name: text(act.name, true), authorization: authorization(act.authorization)};
            actual.receipts = action.receipts.map(value => receipt(value, wire, true));
            requireValue(json(actual) === json(expected), 'Final grouped action metadata differs from independent source membership');
        }
        return freeze(detached as Record<string, unknown>[]);
    } catch (error) {
        if (error instanceof ActionSourceInventoryError) throw error;
        return fail('Invalid final source-bound output: ' + (error instanceof Error ? error.message : String(error)));
    }
}
