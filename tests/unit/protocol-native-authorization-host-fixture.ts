import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {ProtocolAbiActionInput, ProtocolNativeActionObservations, ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import {ProtocolAbiCoordinator} from '../../src/indexer/protocol/abi-coordinator.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiObservationStore, protocolAbiCaptureDigest} from '../../src/indexer/protocol/abi-observation-store.js';
import {ProtocolAbiProofReader} from '../../src/indexer/protocol/abi-proof.js';
import {ProtocolNativeObservationStore, type ProtocolNativeObservationRecord} from '../../src/indexer/protocol/native-observation-store.js';
import {protocolNativeInputInventory} from '../../src/indexer/protocol/native-observation-facts.js';
import {ProtocolSourceBindingStore, type ProtocolSourceProfile} from '../../src/indexer/protocol/source-bindings.js';
import {protocolImmutableJson} from '../../src/indexer/protocol/immutable-bundle-store.js';
import {ProtocolNativeActionReader} from '../../src/indexer/protocol/native-authorization.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

export const chainId = '1'.repeat(64), transactionId = 'a'.repeat(64), chain = 'native-authorization-host-contract';
export const blockId = (height: number) => height.toString(16).padStart(64, '0');
export const clone = <T>(value: T): T => structuredClone(value);
export const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const json = protocolImmutableJson;
export const gate = () => {let release!: () => void; const promise = new Promise<void>(resolve => {release = resolve;}); return {promise, release};};
export const profile: ProtocolSourceProfile = {id: 'host-contract-fixture', profileId: 'synthetic-native-authorization-v1', components: [
    {id: 'host-node', runtime: 'node', version: '0.0.0-dev.1', sourceRevision: 'b'.repeat(40), sha256: 'c'.repeat(64)},
    {id: 'host-rust', runtime: 'rust', version: '0.0.0-dev.1', sourceRevision: 'b'.repeat(40), sha256: 'd'.repeat(64)},
]};
export const schemaJson = '{ "fixture": "synthetic-native-authorization-v1" }';
export function originalInputs(): ProtocolAbiActionInput[] {
    const input = (actionOrdinal: number, inputActionOrdinal: number, receiver: string, account: string,
                   rawHex: string, globalSequence: string): ProtocolAbiActionInput => ({transactionId, actionOrdinal,
        inputActionOrdinal, receiver, account, name: 'dispatch', rawHex, globalSequence, receiptAbiSequence: '4294967295'});
    return [input(1, 1, 'unknown', 'unknown', '0102', '9007199254740993'),
        input(2, 1, 'notified', 'unknown', '0102', '9007199254740994'),
        input(3, 3, 'unknown', 'unknown', '0102', '9007199254740995'),
        input(4, 4, 'contract', 'contract', '03', '9007199254740996'),
        input(5, 5, 'unsupported', 'unsupported', '04', '18446744073709551614'),
        input(6, 5, 'notified', 'unsupported', '04', '18446744073709551615')];
}
function traces(inputs: readonly ProtocolAbiActionInput[]): unknown[] {
    if (!inputs.length) return [];
    return [['transaction_trace_v0', {id: transactionId, status: 0, scheduled: false, failed_dtrx_trace: null,
        except: null, error_code: null, cpu_usage_us: 0, net_usage_words: 0,
        action_traces: inputs.map(input => ['action_trace_v1', {action_ordinal: input.actionOrdinal,
            creator_action_ordinal: input.actionOrdinal === 2 || input.actionOrdinal === 3 ? 1 : input.actionOrdinal === 6 ? 5 : 0,
            receiver: input.receiver, context_free: false, except: null, error_code: null,
            act: {account: input.account, name: input.name, authorization: [], data: input.rawHex},
            receipt: ['action_receipt_v0', {receiver: input.receiver, global_sequence: input.globalSequence,
                recv_sequence: '18446744073709551615', auth_sequence: [], act_digest: 'f'.repeat(64),
                code_sequence: 0, abi_sequence: 4294967295}]}])}]];
}
function decisions(inputs = originalInputs()): ProtocolNativeActionObservations {
    return {schemaVersion: 1, decisions: inputs.filter(input => input.receiver === input.account).map(input => {
        const origin = {transactionId: input.transactionId, actionOrdinal: input.actionOrdinal, rawSha256: hash(Buffer.from(input.rawHex, 'hex'))};
        return input.actionOrdinal === 1 ? {origin, kind: 'native', nativeKind: 'opaque.host-native.v1'}
            : input.actionOrdinal === 5 ? {origin, kind: 'incomplete', error: {code: 'unsupported_origin', message: 'Only this origin is unsupported'}}
            : {origin, kind: 'contract'};
    })};
}
export interface HostFixtureOptions {
    mutateTraces?: (value: any) => void;
    mutateInputs?: (value: ProtocolAbiActionInput[]) => void;
    mutateRecord?: (value: ProtocolNativeObservationRecord) => void;
    mutateBlock?: (value: any) => void;
    maxAncestryBlocks?: number;
}

/** Synthetic protocol/source and ES transport only. All canonical commits/certificates come from the actual coordinator. */
export async function nativeAuthorizationFixture(options: HostFixtureOptions = {}) {
    const memory = frontierMemoryClient(), client: any = memory.client;
    const bindings = new ProtocolSourceBindingStore(client, chain), observations = new ProtocolAbiObservationStore(client, chain);
    const frontier = new ProtocolAbiFrontierStore(client, chain), nativeStore = new ProtocolNativeObservationStore(client, chain);
    const contextId = (await bindings.prepareContext({schemaVersion: 1, chainId, protocol: profile, schemaJson})).id;
    const makeCoordinator = (ownerId: string) => new ProtocolAbiCoordinator({chainId, profile, ownerId, bindings, observations, store: frontier});
    let coordinator = makeCoordinator('host-owner-one'), sessionId = 'host-reader-one';
    await coordinator.start(); let generation = (await coordinator.openSource(contextId, sessionId)).generation;
    const calls = {observe: 0, decode: 0, encode: 0, contract: 0, closed: 0, handshakes: [] as unknown[]};
    const faults: any = {};
    const native: any = {interfaceVersion: 1,
        observe(input: any, source: any) {
            calls.observe++;
            if (faults.observeThrows) throw faults.observeThrows;
            const decoded = JSON.parse(Buffer.from(input.block).toString());
            assert.equal(json(decoded.source), json(source)); assert.equal(input.schemaJson, schemaJson);
            if (faults.observeMutates) input.traces[0] ^= 1;
            const result = decisions(source.blockNum === 2 ? originalInputs() : []);
            faults.changeObserved?.(result); return result;
        },
        decodeValue(kind: string, raw: Uint8Array) {
            calls.decode++; assert.equal(kind, 'opaque.host-native.v1');
            if (faults.decodeThrows) throw faults.decodeThrows;
            if (faults.decodeMutates) raw[0] ^= 1;
            faults.onDecode?.();
            if (Object.hasOwn(faults, 'decodedValue')) return faults.decodedValue;
            return {rawHex: Buffer.from(raw).toString('hex')};
        },
        encodeValue(kind: string, value: any) {
            calls.encode++; assert.equal(kind, 'opaque.host-native.v1');
            if (faults.encodeThrows) throw faults.encodeThrows;
            faults.onEncode?.(value);
            return faults.encodeDifferent ? Uint8Array.from([9]) : Buffer.from(value.rawHex, 'hex');
        },
    };
    const provider: ProtocolProvider = {profileId: profile.profileId, nativeActions: native,
        contractCodec: {decodeAbi() {calls.contract++; throw new Error('Contract ABI must remain unused');},
            encodeAbi() {calls.contract++; throw new Error('Contract ABI must remain unused');},
            decodeValue() {calls.contract++; throw new Error('Contract ABI must remain unused');},
            encodeValue() {calls.contract++; throw new Error('Contract ABI must remain unused');}},
        createShipSession(handshake) {
            calls.handshakes.push(clone(handshake));
            return {decodeTraces(bytes: Uint8Array) {
                if (faults.traceDecodeThrows) throw faults.traceDecodeThrows;
                const value = JSON.parse(Buffer.from(bytes).toString());
                if (faults.traceMutates) bytes[0] ^= 1;
                faults.changeDecoded?.(value); return value;
            }, close() {calls.closed++;}} as any;
        }, normalizeDelta() {throw new Error('Not a state normalization fixture');},
    };
    async function append(height: number, identity = height, parent = height - 1) {
        const source = {chainId, blockNum: height, blockId: blockId(identity), previousBlockId: height === 1 ? null : blockId(parent)};
        const inputs = height === 2 ? originalInputs() : [], rawTraces = traces(inputs), rawBlock = {fixture: 'host-contract', source: clone(source)};
        if (height === 2) {options.mutateTraces?.(rawTraces); options.mutateBlock?.(rawBlock);}
        const capture = {kind: 'unattested-ship-result-sections-v1' as const, schemaJson,
            blockHex: Buffer.from(json(rawBlock)).toString('hex'), tracesHex: Buffer.from(json(rawTraces)).toString('hex'), deltasHex: '00'};
        const captureSha256 = protocolAbiCaptureDigest(source, capture);
        const selectionId = (await bindings.prepareSelection({schemaVersion: 1, contextId, readerSessionId: sessionId, readerRole: 'live', assignmentId: null,
            source, captureSha256, frameSha256: hash(json([source, capture])), head: {blockNum: height, blockId: source.blockId},
            irreversible: {blockNum: 0, blockId: blockId(0)}})).id;
        const canonicalInputs = clone(inputs); if (height === 2) options.mutateInputs?.(canonicalInputs);
        const abi = await observations.prepare({schemaVersion: 1, protocol: profile, source: {...source, inputSha256: captureSha256}, capture,
            observation: {status: 'observed', facts: {schemaVersion: 1, actionInputs: canonicalInputs, deployments: [], finalStates: []}}});
        await bindings.prepareObservationLink({schemaVersion: 1, selectionId, observationId: abi.id, observationDigest: abi.digest});
        const record: ProtocolNativeObservationRecord = {schemaVersion: 1, kind: 'observation', nativeInterfaceVersion: 1,
            contextId, protocol: clone(profile), source: clone(source), captureRef: {abiObservationId: abi.id, abiObservationDigest: abi.digest, inputSha256: captureSha256},
            inventory: clone(protocolNativeInputInventory(inputs)), observation: {status: 'observed', facts: decisions(inputs)}};
        if (height === 2) options.mutateRecord?.(record);
        const retained = await nativeStore.prepare(selectionId, record);
        const admitted = await coordinator.admit(selectionId, generation); assert.equal(admitted.status, 'accepted'); generation = admitted.generation;
        await coordinator.drain();
        return {source, selectionId, inputs, abi, retained, record};
    }
    await append(1); const selected = await append(2);
    const proofs = () => new ProtocolAbiProofReader({chainId, profile, store: new ProtocolAbiFrontierStore(client, chain, 0, {readOnly: true}),
        ...(options.maxAncestryBlocks === undefined ? {} : {maxAncestryBlocks: options.maxAncestryBlocks})});
    const reader = (overrides: any = {}) => new ProtocolNativeActionReader({chainId, profile, provider,
        store: new ProtocolNativeObservationStore(client, chain, 0, undefined, {readOnly: true}), proofReader: proofs(), ...overrides});
    async function replaceOwner() {
        coordinator = makeCoordinator('host-owner-two'); await coordinator.start(); sessionId = 'host-reader-two';
        generation = (await coordinator.openSource(contextId, sessionId)).generation;
    }
    return {memory, client, bindings, observations, frontier, nativeStore, contextId, selected, provider, native, faults, calls,
        reader, proofs, append, replaceOwner, revoke: () => coordinator.revokeSource(sessionId),
        get coordinator() {return coordinator;}};
}

/** Hold an actual client read after capturing its response, without replacing any proof/store method. */
export function holdRead(client: any, predicate: (request: any) => boolean) {
    const entered = gate(), release = gate(), original = client.get; let held = false;
    client.get = async (request: any, options: any) => {
        const response = await original(request, options);
        if (!held && predicate(request)) {held = true; entered.release(); await release.promise;}
        return response;
    };
    return {entered: entered.promise, release: release.release, restore() {client.get = original;}};
}
