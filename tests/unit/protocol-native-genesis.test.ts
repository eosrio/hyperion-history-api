import {describe, expect, it} from 'bun:test';
import {createHash} from 'node:crypto';
import {ProtocolAbiCoordinator} from '../../src/indexer/protocol/abi-coordinator.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiProofReader} from '../../src/indexer/protocol/abi-proof.js';
import {ProtocolSourceBindingStore} from '../../src/indexer/protocol/source-bindings.js';
import {ProtocolAbiObservationStore, protocolAbiCaptureDigest, protocolAbiObservationId,
    type ProtocolAbiObservationRecord} from '../../src/indexer/protocol/abi-observation-store.js';
import {reduceProtocolAbiBlock} from '../../src/indexer/protocol/abi-reducer.js';
import {snapshotNativeGenesisFacts, zeroBlockId,
    type ProtocolNativeGenesisVerifier} from '../../src/indexer/protocol/native-genesis.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

// Independent host-contract facts. The captured Wire source is exercised separately with its real verifier.
const chainId = '1'.repeat(64), blockId = '2'.repeat(64), schemaJson = '{"hostFixture":1}';
const profile = {id: '@eosrio/hyperion-wire-plugin', profileId: 'native-genesis-host-fixture', components: [
    {id: 'wire-node', runtime: 'node' as const, version: '0.0.0-dev.1', sourceRevision: '3'.repeat(40), sha256: '4'.repeat(64)}]};
const facts = () => ({schemaVersion: 1 as const, previousBlockId: zeroBlockId, applicationState: 'empty' as const, abiStates: [
    {account: 'sysio', present: true, abiHex: 'aabb', deltaOrdinal: 0},
    {account: 'sysio.null', present: true, abiHex: '', deltaOrdinal: 1},
    {account: 'sysio.prods', present: true, abiHex: '', deltaOrdinal: 2},
]});
function seal(record: ProtocolAbiObservationRecord) {
    const {inputSha256: _, ...position} = record.source;
    record.source.inputSha256 = protocolAbiCaptureDigest(position, record.capture); return record;
}
const record = (): ProtocolAbiObservationRecord => seal({schemaVersion: 1, protocol: structuredClone(profile),
    source: {chainId, blockNum: 1, blockId, previousBlockId: null, inputSha256: ''},
    capture: {kind: 'unattested-ship-result-sections-v1', schemaJson, blockHex: '0001', tracesHex: null, deltasHex: '0203'},
    observation: {status: 'native-genesis', facts: facts()}});
const verifier: ProtocolNativeGenesisVerifier = (input, source) => {
    expect(source).toEqual({chainId, blockNum: 1, blockId, previousBlockId: null});
    expect(input.schemaJson).toBe(schemaJson); expect(input.traces).toBeNull();
    expect(Buffer.from(input.block).toString('hex')).toBe('0001');
    expect(Buffer.from(input.deltas).toString('hex')).toBe('0203'); return facts();
};
async function fixture(verifyNativeGenesis: ProtocolNativeGenesisVerifier | undefined = verifier) {
    const memory = frontierMemoryClient(), client = memory.client as any;
    const store = new ProtocolAbiFrontierStore(client, 'genesis');
    const bindings = new ProtocolSourceBindingStore(client, 'genesis');
    const observations = new ProtocolAbiObservationStore(client, 'genesis');
    const contextId = (await bindings.prepareContext({schemaVersion: 1, chainId, protocol: profile, schemaJson})).id;
    const make = (ownerId: string) => new ProtocolAbiCoordinator({chainId, profile, ownerId, store, bindings, observations, verifyNativeGenesis});
    const coordinator = make('master-one'); await coordinator.start();
    let generation = (await coordinator.openSource(contextId, 'reader-one')).generation;
    async function selected(value = record(), readerSessionId = 'reader-one') {
        const {inputSha256, ...source} = value.source;
        const selectionId = (await bindings.prepareSelection({schemaVersion: 1, contextId, readerSessionId,
            readerRole: 'live', assignmentId: null, source, captureSha256: inputSha256,
            frameSha256: createHash('sha256').update(inputSha256).digest('hex'),
            head: {blockNum: source.blockNum, blockId: source.blockId}, irreversible: {blockNum: 0, blockId: zeroBlockId}})).id;
        return {value, selectionId};
    }
    async function prepare(entry: Awaited<ReturnType<typeof selected>>) {
        const prepared = await observations.prepare(entry.value);
        await bindings.prepareObservationLink({schemaVersion: 1, selectionId: entry.selectionId,
            observationId: prepared.id, observationDigest: prepared.digest});
    }
    async function admit(entry: Awaited<ReturnType<typeof selected>>) {
        const receipt = await coordinator.admit(entry.selectionId, generation); generation = receipt.generation; return receipt;
    }
    const reader = new ProtocolAbiProofReader({chainId, profile, store});
    return {memory, store, bindings, observations, make, coordinator, contextId, selected, prepare, admit, reader};
}

describe('native genesis host admission', () => {
    it('re-verifies original sections without rewriting the absent SHiP predecessor or source identity', async () => {
        const value = record(), identity = protocolAbiObservationId(value), original = structuredClone(value);
        let resolved = 0;
        const reduced = await reduceProtocolAbiBlock(value, async () => {resolved++; throw new Error('No prior genesis account');}, null, verifier);
        expect(reduced).toMatchObject({status: 'complete', reset: false, bindings: [], lastGlobalSequence: null,
            nativeGenesis: {previousBlockId: zeroBlockId, applicationState: 'empty'}});
        expect(resolved).toBe(0); expect(reduced.updates).toHaveLength(3);
        expect(reduced.updates.map(update => [update.account, update.state.abiHex, update.state.source])).toEqual(
            facts().abiStates.map(state => [state.account, state.abiHex, {observationId: identity, chainId, blockNum: 1,
                blockId, inputSha256: value.source.inputSha256, phase: 'block-end', deltaOrdinal: state.deltaOrdinal}]));
        expect(value).toEqual(original); expect(protocolAbiObservationId(value)).toBe(identity);
    });

    it('rejects absent/throwing verifiers, changed facts, fake trace vectors and later-height bootstrap attempts', async () => {
        const invalid: Array<[ProtocolAbiObservationRecord, ProtocolNativeGenesisVerifier | undefined]> = [
            [record(), undefined], [record(), () => {throw new Error('Not this native initialization');}],
        ];
        const changed = record(); (changed.observation as any).facts.abiStates[0].abiHex = 'ffff'; invalid.push([changed, verifier]);
        for (const mutate of [
            (value: ProtocolAbiObservationRecord) => {value.capture.tracesHex = '00';},
            (value: ProtocolAbiObservationRecord) => {value.capture.blockHex = null;},
            (value: ProtocolAbiObservationRecord) => {value.capture.deltasHex = null;},
            (value: ProtocolAbiObservationRecord) => {value.source.blockNum = 2;},
            (value: ProtocolAbiObservationRecord) => {value.source.previousBlockId = zeroBlockId;},
        ]) {const value = record(); mutate(value); invalid.push([seal(value), verifier]);}
        for (const [value, verify] of invalid) {
            const reduced = await reduceProtocolAbiBlock(value, async () => null, null, verify);
            expect(reduced).toMatchObject({status: 'incomplete', reset: true, bindings: [], updates: [], lastGlobalSequence: null});
            expect(reduced).not.toHaveProperty('nativeGenesis');
        }
        expect((await reduceProtocolAbiBlock(record(), async () => null, '1', verifier)).status).toBe('incomplete');
    });

    it('rejects nonportable, duplicate, missing, tombstone and forged native facts before use', () => {
        for (const mutate of [
            (value: any) => {value.abiStates.push({...value.abiStates[0]});},
            (value: any) => {value.abiStates[1].deltaOrdinal = 0;},
            (value: any) => {value.abiStates[1].present = false;},
            (value: any) => {value.abiStates = [];},
            (value: any) => {value.applicationState = 'unknown';},
            (value: any) => {value.previousBlockId = blockId;},
            (value: any) => {value.actionInputs = [];},
            (value: any) => {Object.defineProperty(value, 'abiStates', {enumerable: true, get() {throw new Error('accessor read');}});},
        ]) {const value = facts(); mutate(value); expect(() => snapshotNativeGenesisFacts(value)).toThrow();}
        const value = facts(), snapshot = snapshotNativeGenesisFacts(value); value.abiStates[0].abiHex = 'ff';
        expect(snapshot.abiStates[0].abiHex).toBe('aabb'); expect(Object.isFrozen(snapshot.abiStates[0])).toBe(true);
    });

    it('keeps the ordinary observer trace requirement and never infers empty application state from empty bindings', async () => {
        const value = record(); value.observation = {status: 'observed', facts: {schemaVersion: 1, actionInputs: [], deployments: [], finalStates: []}};
        expect((await reduceProtocolAbiBlock(value, async () => null, null, verifier)).status).toBe('incomplete');
        value.capture.tracesHex = '00'; seal(value);
        const f = await fixture(), entry = await f.selected(value); await f.prepare(entry); await f.admit(entry); await f.coordinator.drain();
        const view = await f.reader.open(value.source, entry.selectionId);
        await expect(f.reader.nativeGenesisFrame(view)).rejects.toMatchObject({code: 'native_genesis_unavailable'});
    });

    it('publishes native ABI barriers and the empty 0 -> actual 1 frame only after durable canonical activation', async () => {
        const f = await fixture(), entry = await f.selected();
        await f.admit(entry); expect(await f.coordinator.drain()).toEqual({committed: 0, pending: 1});
        await expect(f.reader.open(entry.value.source, entry.selectionId)).rejects.toMatchObject({code: 'authority_unavailable'});
        await f.prepare(entry); expect(await f.coordinator.drain()).toEqual({committed: 1, pending: 0});
        const control = await f.coordinator.inspect(); expect(control.head).toMatchObject({blockNum: 1, blockId, coverageStart: 1, lastGlobalSequence: null});
        const commit = await f.store.readCommit(control.head!.commitId) as any;
        expect(commit.source.previousBlockId).toBeNull(); expect(commit.bindings).toEqual([]);
        const view = await f.reader.open(entry.value.source, entry.selectionId);
        expect(await f.reader.nativeGenesisFrame(view)).toEqual({chainId, block: {blockNum: 1, blockId, previousBlockId: zeroBlockId}, changes: []});
        expect((await f.reader.finalState(view, 'sysio')).abiHex).toBe('aabb');
        for (const account of ['sysio.null', 'sysio.prods']) {
            expect(await f.store.readAccount(control.head!.stateRootId, account)).toMatchObject({present: true, abiHex: '', source: {phase: 'block-end'}});
            await expect(f.reader.finalState(view, account)).rejects.toMatchObject({code: 'abi_state_unavailable'});
        }
        await expect(f.reader.nativeGenesisFrame({...view})).rejects.toMatchObject({code: 'invalid_proof'});
        await f.coordinator.revokeSource('reader-one');
        await expect(f.reader.nativeGenesisFrame(view)).rejects.toMatchObject({code: 'authority_unavailable'});
    });

    it('treats forged journal facts as incomplete canonical coverage rather than provider success authority', async () => {
        const f = await fixture(), value = record(); (value.observation as any).facts.abiStates[0].abiHex = 'ffff';
        const entry = await f.selected(value); await f.prepare(entry); await f.admit(entry); await f.coordinator.drain();
        expect((await f.coordinator.inspect()).head).toMatchObject({coverageStart: null, stateRootId: null});
        await expect(f.reader.open(value.source, entry.selectionId)).rejects.toMatchObject({code: 'source_incomplete'});
    });

    it('retries failed commit durability without granting authority or advancing progress early', async () => {
        const f = await fixture(), entry = await f.selected(); await f.prepare(entry); await f.admit(entry);
        const failure = new Error('Storage unavailable');
        f.memory.faults.beforeWrite = (request: any) => {if (request.index === f.store.recordsIndex && request.id.startsWith('h45abicmt1:')) throw failure;};
        await expect(f.coordinator.drain()).rejects.toBe(failure);
        expect((await f.coordinator.inspect()).head).toBeNull();
        await expect(f.reader.open(entry.value.source, entry.selectionId)).rejects.toMatchObject({code: 'authority_unavailable'});
        delete f.memory.faults.beforeWrite;
        expect(await f.coordinator.drain()).toEqual({committed: 1, pending: 0});
        const prior = await f.coordinator.inspect(), restarted = f.make('master-two'); await restarted.start();
        expect((await restarted.inspect()).head).toEqual(prior.head);
        expect(await restarted.openSource(f.contextId, 'reader-two')).toMatchObject({resumeFromBlock: 2});
    });

    it('does not let a changed selected context authorize the retained old native source', async () => {
        const f = await fixture(), entry = await f.selected(); entry.value.protocol = {...profile, profileId: 'foreign-profile'};
        await f.prepare(entry); await f.admit(entry); await f.coordinator.drain();
        expect((await f.coordinator.inspect()).head).toMatchObject({coverageStart: null});
    });

    it('repairs interrupted certificate publication from settled durable ownership on an idle retry', async () => {
        const f = await fixture(), entry = await f.selected(); await f.prepare(entry); await f.admit(entry);
        const failure = new Error('Certificate storage unavailable');
        f.memory.faults.beforeWrite = (request: any) => {if (request.index === f.store.recordsIndex && request.id.startsWith('h45abicert1:')) throw failure;};
        await expect(f.coordinator.drain()).rejects.toBe(failure);
        expect((await f.coordinator.inspect()).head).toMatchObject({blockNum: 1, coverageStart: 1});
        await expect(f.reader.open(entry.value.source, entry.selectionId)).rejects.toMatchObject({code: 'certificate_unavailable'});
        delete f.memory.faults.beforeWrite;
        expect(await f.coordinator.drain()).toEqual({committed: 0, pending: 0});
        const view = await f.reader.open(entry.value.source, entry.selectionId);
        expect((await f.reader.nativeGenesisFrame(view)).block.blockNum).toBe(1);
    });

    it('fences a previously issued native frame proof across owner/source replacement', async () => {
        const f = await fixture(), entry = await f.selected(); await f.prepare(entry); await f.admit(entry); await f.coordinator.drain();
        const prior = await f.reader.open(entry.value.source, entry.selectionId);
        const restarted = f.make('replacement-master'); await restarted.start();
        const replacement = await restarted.openSource(f.contextId, 'replacement-reader');
        await expect(f.reader.nativeGenesisFrame(prior)).rejects.toMatchObject({code: 'authority_unavailable'});
        const value = record(); value.source.blockNum = 2; value.source.blockId = '5'.repeat(64); value.source.previousBlockId = blockId;
        value.capture.tracesHex = '00'; value.observation = {status: 'observed', facts: {schemaVersion: 1, actionInputs: [], deployments: [], finalStates: []}};
        const next = await f.selected(seal(value), 'replacement-reader'); await f.prepare(next);
        expect((await restarted.admit(next.selectionId, replacement.generation)).status).toBe('accepted'); await restarted.drain();
        await expect(f.reader.nativeGenesisFrame(prior)).rejects.toMatchObject({code: 'authority_changed'});
        const current = await f.reader.open(entry.value.source, entry.selectionId);
        expect((await f.reader.nativeGenesisFrame(current)).block).toEqual({blockNum: 1, blockId, previousBlockId: zeroBlockId});
    });
});
