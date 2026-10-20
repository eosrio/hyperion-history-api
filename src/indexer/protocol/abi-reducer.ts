import type {ProtocolAbiActionAnchor, ProtocolAbiActionInput, ProtocolBlockAbiObservations} from '@eosrio/hyperion-sdk/protocol';
import {assertProtocolAbiObservationFacts} from './abi-observation-facts.js';
import {protocolAbiObservationId, protocolAbiObservationJson, type ProtocolAbiObservationRecord} from './abi-observation-store.js';
import type {ProtocolSourceProfile} from './source-bindings.js';
import {isProtocolHex} from './hex.js';
import {verifyNativeGenesisRecord, type ProtocolNativeGenesisCoverage, type ProtocolNativeGenesisVerifier} from './native-genesis.js';

interface ProtocolAbiAccountSourceBase {
    readonly observationId: string;
    readonly chainId: string;
    readonly blockNum: number;
    readonly blockId: string;
    readonly inputSha256: string;
}

export type ProtocolAbiAccountSource = ProtocolAbiAccountSourceBase & (
    | {readonly phase: 'native-effect'; readonly action: ProtocolAbiActionAnchor & {readonly globalSequence: string}}
    | {readonly phase: 'block-end'; readonly deltaOrdinal: number}
);

/** Null, rather than an older state, represents an account whose ABI is not proven. */
export interface ProtocolAbiAccountState {
    readonly account: string;
    readonly present: boolean;
    /** Empty and malformed bytes remain authoritative barriers; this reducer never parses an ABI. */
    readonly abiHex: string;
    readonly protocol: ProtocolSourceProfile;
    readonly source: ProtocolAbiAccountSource;
}

export interface ProtocolAbiAccountUpdate {
    readonly account: string;
    readonly state: ProtocolAbiAccountState;
}

export interface ProtocolAbiActionBinding extends ProtocolAbiActionInput {
    /** Reused by notification copies; known absent/empty/invalid states cannot authorize decoding. */
    readonly state: ProtocolAbiAccountState | null;
}

export type ProtocolAbiBlockReduction =
    | {readonly status: 'complete'; readonly reset: false;
        readonly bindings: readonly ProtocolAbiActionBinding[]; readonly updates: readonly ProtocolAbiAccountUpdate[];
        readonly lastGlobalSequence: string | null; readonly nativeGenesis?: ProtocolNativeGenesisCoverage}
    | {readonly status: 'incomplete'; readonly reset: true; readonly bindings: readonly []; readonly updates: readonly [];
        readonly lastGlobalSequence: null; readonly reason: {readonly code: string; readonly message: string}};

export type ProtocolAbiAccountResolver = (account: string) => Promise<ProtocolAbiAccountState | null>;

const maximumUint64 = 0xffffffffffffffffn;
const hex64 = /^[0-9a-f]{64}$/;
const hex = isProtocolHex;
const sequenceText = /^(?:0|[1-9][0-9]*)$/;
const maximumItems = 100_000;
const maximumPriorStateBytes = 64 * 1024 * 1024;
const text = (value: unknown, maximum = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const uint32 = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= 0xffffffff;
const anchorKey = (value: ProtocolAbiActionAnchor) => `${value.transactionId}:${value.actionOrdinal}`;

class InvalidAbiReduction extends Error {
    constructor(readonly code: string, message: string) {super(message);}
}

function requireFact(condition: unknown, message: string, code = 'protocol_abi_invalid_facts'): asserts condition {
    if (!condition) throw new InvalidAbiReduction(code, message);
}

function sequence(value: unknown, positive = true): bigint {
    requireFact(typeof value === 'string' && value.length <= 20 && sequenceText.test(value), 'Expected lossless canonical receipt sequence');
    const number = BigInt(value);
    requireFact(number >= (positive ? 1n : 0n) && number <= maximumUint64, 'Receipt sequence is outside uint64');
    return number;
}

function immutableProfile(input: ProtocolSourceProfile): ProtocolSourceProfile {
    requireFact(input && text(input.id, 214) && text(input.profileId) && Array.isArray(input.components)
        && input.components.length > 0 && input.components.length <= 64, 'Invalid account-state protocol profile');
    const seen = new Set<string>();
    const components = input.components.map(component => {
        requireFact(component && text(component.id, 214) && ['node', 'rust'].includes(component.runtime)
            && text(component.version, 128) && /^[0-9a-f]{40}$/.test(component.sourceRevision)
            && hex64.test(component.sha256), 'Invalid account-state component pin');
        const key = `${component.runtime}:${component.id}`;
        requireFact(!seen.has(key), 'Duplicate account-state component pin');seen.add(key);
        return Object.freeze({id: component.id, runtime: component.runtime, version: component.version,
            sourceRevision: component.sourceRevision, sha256: component.sha256});
    }).sort((left, right) => {
        const a = `${left.runtime}:${left.id}`, b = `${right.runtime}:${right.id}`;
        return a < b ? -1 : a > b ? 1 : 0;
    });
    return Object.freeze({id: input.id, profileId: input.profileId, components: Object.freeze(components)});
}

function sameProfile(left: ProtocolSourceProfile, right: ProtocolSourceProfile): boolean {
    return protocolAbiObservationJson(left) === protocolAbiObservationJson(right);
}

function snapshotFacts(input: unknown): ProtocolBlockAbiObservations {
    try {assertProtocolAbiObservationFacts(input);} catch {
        throw new InvalidAbiReduction('protocol_abi_invalid_facts', 'Invalid provider ABI observation facts');
    }
    requireFact(input.actionInputs.length <= maximumItems && input.deployments.length <= maximumItems
        && input.finalStates.length <= maximumItems, 'ABI observation collection exceeds limit');
    // Capture immutable primitive fields before the first resolver await. Strings
    // are reused; large ABI bodies are never cloned once per action/notification.
    return Object.freeze({schemaVersion: 1,
        actionInputs: Object.freeze(input.actionInputs.map(action => Object.freeze({transactionId: action.transactionId,
            actionOrdinal: action.actionOrdinal, receiver: action.receiver, account: action.account, name: action.name,
            rawHex: action.rawHex, globalSequence: action.globalSequence, receiptAbiSequence: action.receiptAbiSequence,
            inputActionOrdinal: action.inputActionOrdinal}))),
        deployments: Object.freeze(input.deployments.map(deployment => Object.freeze({account: deployment.account,
            abiHex: deployment.abiHex, action: Object.freeze({transactionId: deployment.action.transactionId,
                actionOrdinal: deployment.action.actionOrdinal}), globalSequence: deployment.globalSequence,
            effect: deployment.effect}))),
        finalStates: Object.freeze(input.finalStates.map(state => Object.freeze({account: state.account,
            present: state.present, abiHex: state.abiHex, deltaOrdinal: state.deltaOrdinal}))),
    });
}

function incomplete(code: string, message: string): ProtocolAbiBlockReduction {
    return Object.freeze({status: 'incomplete', reset: true, bindings: Object.freeze([]) as readonly [],
        updates: Object.freeze([]) as readonly [], lastGlobalSequence: null,
        reason: Object.freeze({code, message: message.slice(0, 4096)})});
}

/**
 * Reduce one already selected canonical block. Parent continuity, source trust,
 * durable activation and fork-generation fencing belong to the coordinator.
 * Resolver/storage exceptions intentionally propagate for supervised redelivery.
 */
export async function reduceProtocolAbiBlock(record: ProtocolAbiObservationRecord, resolveAccount: ProtocolAbiAccountResolver,
                                            priorLastGlobalSequence?: string | null,
                                            verifyNativeGenesis?: ProtocolNativeGenesisVerifier): Promise<ProtocolAbiBlockReduction> {
    try {
        try {protocolAbiObservationJson(record);} catch {
            throw new InvalidAbiReduction('protocol_abi_invalid_record', 'Invalid portable ABI observation record');
        }
        requireFact(record && record.observation && ['observed', 'native-genesis', 'incomplete'].includes(record.observation.status),
            'Invalid ABI observation record status', 'protocol_abi_invalid_record');
        if (record.observation.status === 'incomplete') return incomplete('protocol_abi_observation_incomplete', 'Source ABI observations are incomplete');
        let observationId: string;
        try {observationId = protocolAbiObservationId(record);} catch {
            throw new InvalidAbiReduction('protocol_abi_invalid_record', 'Invalid ABI observation source identity');
        }
        if (record.observation.status === 'native-genesis') {
            requireFact(priorLastGlobalSequence == null, 'Native genesis cannot extend a receipt fence');
            let facts: ReturnType<typeof verifyNativeGenesisRecord>;
            try {facts = verifyNativeGenesisRecord(record, verifyNativeGenesis);} catch {
                throw new InvalidAbiReduction('protocol_native_genesis_unverified', 'Native genesis source verification failed');
            }
            const protocol = immutableProfile(record.protocol);
            const updates = facts.abiStates.map(final => Object.freeze({account: final.account,
                state: Object.freeze({account: final.account, present: final.present, abiHex: final.abiHex, protocol,
                    source: Object.freeze({observationId, chainId: record.source.chainId, blockNum: 1,
                        blockId: record.source.blockId, inputSha256: record.source.inputSha256,
                        phase: 'block-end' as const, deltaOrdinal: final.deltaOrdinal})})}));
            updates.sort((left, right) => left.account < right.account ? -1 : left.account > right.account ? 1 : 0);
            return Object.freeze({status: 'complete', reset: false, bindings: Object.freeze([]), updates: Object.freeze(updates),
                lastGlobalSequence: null, nativeGenesis: Object.freeze({previousBlockId: facts.previousBlockId, applicationState: 'empty'})});
        }
        requireFact(record.capture.schemaJson !== null && !!record.capture.tracesHex && !!record.capture.deltasHex,
            'Observed facts require their complete retained source sections');
        const facts = snapshotFacts(record.observation.facts);
        const protocol = immutableProfile(record.protocol);
        const position = Object.freeze({observationId, chainId: record.source.chainId, blockNum: record.source.blockNum,
            blockId: record.source.blockId, inputSha256: record.source.inputSha256});
        const previousBlockId = record.source.previousBlockId;
        const prior = priorLastGlobalSequence == null ? null : sequence(priorLastGlobalSequence, false);
        const actions = [...facts.actionInputs].sort((left, right) => sequence(left.globalSequence) < sequence(right.globalSequence) ? -1 : 1);
        const byAnchor = new Map<string, ProtocolAbiActionInput>();
        const seenSequences = new Set<string>();
        let lastGlobalSequence = priorLastGlobalSequence ?? null;
        for (const action of actions) {
            requireFact(uint32(action.actionOrdinal, 1) && uint32(action.inputActionOrdinal, 1), 'Invalid allocated action ordinal');
            const key = anchorKey(action);
            requireFact(!byAnchor.has(key) && !seenSequences.has(action.globalSequence), 'Duplicate action anchor or execution sequence');
            requireFact(prior === null || sequence(action.globalSequence) > prior, 'Receipt sequence does not advance the complete parent block',
                'protocol_abi_sequence_regression');
            byAnchor.set(key, action);seenSequences.add(action.globalSequence);lastGlobalSequence = action.globalSequence;
        }
        for (const action of actions) {
            const origin = byAnchor.get(anchorKey({transactionId: action.transactionId, actionOrdinal: action.inputActionOrdinal}));
            requireFact(origin && origin.receiver === origin.account && origin.inputActionOrdinal === origin.actionOrdinal,
                'Missing or cyclic first-receiver input origin');
            requireFact(origin.account === action.account && origin.name === action.name && origin.rawHex === action.rawHex,
                'Notification input does not match its first receiver');
            if (action.receiver === action.account) requireFact(action.inputActionOrdinal === action.actionOrdinal, 'First receiver cannot borrow another input');
            else requireFact(action.inputActionOrdinal !== action.actionOrdinal && sequence(origin.globalSequence) < sequence(action.globalSequence),
                'Notification must follow its original input');
        }
        const publications = new Map<string, ProtocolBlockAbiObservations['deployments'][number]>();
        for (const publication of facts.deployments) {
            const key = anchorKey(publication.action), action = byAnchor.get(key);
            requireFact(action && action.receiver === action.account && action.inputActionOrdinal === action.actionOrdinal
                && publication.globalSequence === action.globalSequence && publication.effect === 'native-before-receipt',
                'Native publication does not match its mutating first receiver');
            requireFact(!publications.has(key), 'Duplicate native publication anchor');
            publications.set(key, publication);
        }
        const finals = new Map<string, ProtocolBlockAbiObservations['finalStates'][number]>(), finalOrdinals = new Set<number>();
        for (const final of facts.finalStates) {
            requireFact(uint32(final.deltaOrdinal) && !finals.has(final.account) && !finalOrdinals.has(final.deltaOrdinal), 'Duplicate or invalid final account state');
            finals.set(final.account, final);finalOrdinals.add(final.deltaOrdinal);
        }
        const accounts = new Map<string, ProtocolAbiAccountState | null>();
        let resolvedAccountBytes = 0;
        const getAccount = async (account: string): Promise<ProtocolAbiAccountState | null> => {
            if (accounts.has(account)) return accounts.get(account)!;
            const supplied = await resolveAccount(account); // Never catch an infrastructure exception here.
            if (supplied === null) {accounts.set(account, null);return null;}
            let serialized: string;
            try {serialized = protocolAbiObservationJson(supplied, maximumPriorStateBytes);} catch {
                throw new InvalidAbiReduction('protocol_abi_invalid_account_state', 'Resolver returned invalid portable account state');
            }
            // Count each distinct resolved state once, before retaining it in the
            // account memo. Repeated inputs and notification copies share state.
            resolvedAccountBytes += Buffer.byteLength(serialized, 'utf8');
            requireFact(resolvedAccountBytes <= maximumPriorStateBytes,
                'Resolved prior account states exceed the per-block 64MiB budget', 'protocol_abi_account_budget');
            requireFact(supplied && supplied.account === account && typeof supplied.present === 'boolean' && typeof supplied.abiHex === 'string'
                && hex(supplied.abiHex), 'Resolver returned an incompatible account state', 'protocol_abi_invalid_account_state');
            const stateProtocol = immutableProfile(supplied.protocol), source = supplied.source;
            requireFact(sameProfile(stateProtocol, protocol) && source && source.chainId === position.chainId
                && uint32(source.blockNum, 1) && source.blockNum < position.blockNum && hex64.test(source.blockId)
                && hex64.test(source.inputSha256) && /^h45abi1:[0-9a-f]{64}$/.test(source.observationId)
                && (source.blockNum !== position.blockNum - 1 || source.blockId === previousBlockId),
                'Resolver returned foreign or future ABI provenance', 'protocol_abi_invalid_account_state');
            let detachedSource: ProtocolAbiAccountSource;
            const sourceBase: ProtocolAbiAccountSourceBase = {observationId: source.observationId, chainId: source.chainId,
                blockNum: source.blockNum, blockId: source.blockId, inputSha256: source.inputSha256};
            if (source.phase === 'native-effect') {
                requireFact(supplied.present && source.action && hex64.test(source.action.transactionId) && uint32(source.action.actionOrdinal, 1),
                    'Invalid native ABI source anchor', 'protocol_abi_invalid_account_state');
                const nativeSequence = sequence(source.action.globalSequence);
                requireFact(prior === null || nativeSequence <= prior, 'Native ABI source exceeds the complete parent receipt fence',
                    'protocol_abi_invalid_account_state');
                detachedSource = Object.freeze({...sourceBase, phase: 'native-effect', action: Object.freeze({transactionId: source.action.transactionId,
                    actionOrdinal: source.action.actionOrdinal, globalSequence: source.action.globalSequence})});
            } else {
                requireFact(source.phase === 'block-end' && uint32(source.deltaOrdinal), 'Invalid final ABI source anchor', 'protocol_abi_invalid_account_state');
                detachedSource = Object.freeze({...sourceBase, phase: 'block-end', deltaOrdinal: source.deltaOrdinal});
            }
            const state = Object.freeze({account, present: supplied.present, abiHex: supplied.abiHex, protocol: stateProtocol, source: detachedSource});
            accounts.set(account, state);return state;
        };
        const bindings: ProtocolAbiActionBinding[] = [], inputStates = new Map<string, ProtocolAbiAccountState | null>();
        const updated = new Map<string, ProtocolAbiAccountState>();
        for (const action of actions) {
            const originKey = anchorKey({transactionId: action.transactionId, actionOrdinal: action.inputActionOrdinal});
            let state: ProtocolAbiAccountState | null;
            if (action.inputActionOrdinal === action.actionOrdinal) {state = await getAccount(action.account);inputStates.set(originKey, state);}
            else {requireFact(inputStates.has(originKey), 'Notification input binding is unavailable');state = inputStates.get(originKey)!;}
            bindings.push(Object.freeze({...action, state}));
            const publication = publications.get(anchorKey(action));
            if (publication) {
                const source: ProtocolAbiAccountSource = Object.freeze({...position, phase: 'native-effect',
                    action: Object.freeze({transactionId: action.transactionId, actionOrdinal: action.actionOrdinal, globalSequence: action.globalSequence})});
                const state = Object.freeze({account: publication.account, present: true, abiHex: publication.abiHex, protocol, source});
                accounts.set(publication.account, state);updated.set(publication.account, state);
            }
        }
        for (const [account, state] of updated) {
            const final = finals.get(account);
            requireFact(final && final.present && final.abiHex === state.abiHex, 'Native ABI publication disagrees with missing or different final account state',
                'protocol_abi_final_state_mismatch');
        }
        for (const final of [...facts.finalStates].sort((left, right) => left.deltaOrdinal - right.deltaOrdinal)) {
            if (updated.has(final.account)) continue;
            const priorState = await getAccount(final.account);
            requireFact(!priorState || !final.present || (priorState.present ? priorState.abiHex === final.abiHex : final.abiHex === ''),
                'Final ABI changed without an observed publication', 'protocol_abi_final_state_mismatch');
            const source: ProtocolAbiAccountSource = Object.freeze({...position, phase: 'block-end', deltaOrdinal: final.deltaOrdinal});
            const state = Object.freeze({account: final.account, present: final.present, abiHex: final.abiHex, protocol, source});
            accounts.set(final.account, state);updated.set(final.account, state);
        }
        return Object.freeze({status: 'complete', reset: false, bindings: Object.freeze(bindings),
            updates: Object.freeze([...updated].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
                .map(([account, state]) => Object.freeze({account, state}))), lastGlobalSequence});
    } catch (error) {
        if (error instanceof InvalidAbiReduction) return incomplete(error.code, error.message);
        throw error;
    }
}
