import {test, expect, beforeAll, afterAll} from 'bun:test';
import {DiskAbiHistoryCatalog} from '../../src/indexer/protocol/disk-abi-history.js';
import {DiskSourceEvidence, protocolDiskSelectionId} from '../../src/indexer/protocol/disk-source-evidence.js';
import {protocolAbiCaptureDigest, protocolAbiObservationEvidence} from '../../src/indexer/protocol/abi-observation-store.js';
import {observeProtocolAbiSource} from '../../src/indexer/protocol/source-observation.js';
import {ProtocolAbiProofReader, ProtocolAbiProofUnavailableError} from '../../src/indexer/protocol/abi-proof.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiObservationStore} from '../../src/indexer/protocol/abi-observation-store.js';
import {ProtocolSourceBindingStore} from '../../src/indexer/protocol/source-bindings.js';
import type {DiskAbiHistoryConfiguration} from '../../src/indexer/protocol/disk-abi-history.js';
import type {ProtocolSourceProfile} from '../../src/indexer/protocol/source-bindings.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {preflight, schemaJson, wireBlocks, writeCatalog, writeNodeLogs, type WireBlock} from './disk-capture-fixture.js';

let blocks: WireBlock[] = [], selected: any, profile: ProtocolSourceProfile;
// Built directly: the process-wide catalog cache has a restart-gated budget other suites share.
let pinned: DiskAbiHistoryConfiguration, catalog: DiskAbiHistoryCatalog;
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {for (const close of closers) await close();});
beforeAll(async () => {
    ({blocks, selected} = await wireBlocks());
    profile = {id: selected.id, profileId: selected.provider.profileId, components: selected.components ?? []};
    pinned = await writeCatalog(preflight.chainId, blocks.map(value => value.position.blockId), [], schemaJson);
    catalog = new DiskAbiHistoryCatalog(pinned, preflight.chainId, profile);
    closers.push(() => catalog.close());
});

async function setup(options: {damage?: Parameters<typeof writeNodeLogs>[1]; capture?: boolean} = {}) {
    const capture = await writeNodeLogs(blocks, options.damage);
    const memory = frontierMemoryClient();
    const evidence = options.capture === false ? undefined
        : new DiskSourceEvidence(capture, pinned.ship_abi_sha256, catalog, selected.provider, preflight.chainId, profile);
    if (evidence) closers.push(() => evidence.close());
    const disk = {catalog, evidence, verifyNativeGenesis: selected.provider.verifyNativeGenesis?.bind(selected.provider),
        bindings: new ProtocolSourceBindingStore(memory.client, 'disk-evidence', 0, {readOnly: true}),
        observations: new ProtocolAbiObservationStore(memory.client, 'disk-evidence', 0, undefined, {readOnly: true})};
    const reader = new ProtocolAbiProofReader({chainId: preflight.chainId, profile, diskHistory: disk as any,
        store: new ProtocolAbiFrontierStore(memory.client, 'disk-evidence', 0, {readOnly: true})});
    return {disk, reader};
}
const source = (value: WireBlock) => ({chainId: value.position.chainId, blockNum: value.position.blockNum, blockId: value.position.blockId});
async function proofError(promise: Promise<unknown>): Promise<ProtocolAbiProofUnavailableError> {
    try {await promise;} catch (error) {expect(error).toBeInstanceOf(ProtocolAbiProofUnavailableError); return error as ProtocolAbiProofUnavailableError;}
    throw new Error('Expected a proof refusal');
}

test('records recomputed from the logs equal the records the indexer builds from the SHiP frames', async () => {
    const {disk} = await setup();
    const session = selected.provider.createShipSession(JSON.parse(schemaJson));
    const decode = (type: string, bytes: Uint8Array) => type === 'transaction_trace[]' ? session.decodeTraces(bytes)
        : type === 'table_delta[]' ? session.decodeDeltas(bytes) : session.decodeRow(type, bytes);
    try {
        for (const value of blocks) {
            const records = await disk.evidence!.records(value.position.blockNum);
            const capture = {kind: 'unattested-ship-result-sections-v1' as const, schemaJson, blockHex: value.block.toString('hex'),
                tracesHex: value.traces === null ? null : value.traces.toString('hex'), deltasHex: value.deltas.toString('hex')};
            const {observation} = observeProtocolAbiSource(selected.provider, decode as any, value.position, capture, true);
            const indexed = protocolAbiObservationEvidence({schemaVersion: 1, protocol: profile,
                source: {...value.position, inputSha256: protocolAbiCaptureDigest(value.position, capture)}, capture, observation});
            expect(records.position).toEqual(value.position);
            expect(records.abi).toEqual(indexed);
            expect(records.selectionId).toBe(protocolDiskSelectionId(value.position));
            // This released profile has no native classification; the native profile adds those records.
            expect(records.native).toBeUndefined();
            expect(records.abi.record.observation.status).toBe(value.position.blockNum === 1
                ? (selected.provider.verifyNativeGenesis ? 'native-genesis' : 'incomplete') : 'observed');
        }
        expect(disk.evidence!.records(3)).toBe(disk.evidence!.records(3));
    } finally {session.close?.();}
});

test('a disk selection opens a catalog view bound to the recomputed facts', async () => {
    const {disk, reader} = await setup();
    for (const value of blocks.slice(1)) {
        const records = await disk.evidence!.records(value.position.blockNum);
        const view = await reader.open(source(value), records.selectionId);
        expect(view.selectionId).toBe(records.selectionId);
        expect(view.source).toEqual(value.position);
        const facts = (records.abi.record.observation as any).facts;
        expect(view.bindings.map(binding => [binding.transactionId, binding.actionOrdinal, binding.globalSequence]))
            .toEqual([...facts.actionInputs].sort((a: any, b: any) => BigInt(a.globalSequence) < BigInt(b.globalSequence) ? -1 : 1)
                .map((input: any) => [input.transactionId, input.actionOrdinal, input.globalSequence]));
        expect(view.bindings.length).toBeGreaterThan(0);
        expect(reader.diskEvidence(view)).toBe(records);
    }
});

test('a disk selection is refused for another position, without capture, and outside the catalog', async () => {
    const {reader} = await setup();
    const other = protocolDiskSelectionId(blocks[3]!.position);
    expect((await proofError(reader.open(source(blocks[2]!), other))).message).toContain('another catalog position');
    const uncaptured = await setup({capture: false});
    expect((await proofError(uncaptured.reader.open(source(blocks[2]!), protocolDiskSelectionId(blocks[2]!.position)))).message)
        .toContain('Invalid requested ABI source');
    const later = {chainId: preflight.chainId, blockNum: 5, blockId: '00000005' + '11'.repeat(28)};
    expect((await proofError(reader.open(later, protocolDiskSelectionId({...later, previousBlockId: blocks[3]!.position.blockId})))).code)
        .toBe('source_not_covered');
});

test('damaged logs fail the proof with the capture refusal', async () => {
    const {reader} = await setup({damage: {entry: {stem: 'trace_history', block: 3, trailer: 7}}});
    const error = await proofError(reader.open(source(blocks[2]!), protocolDiskSelectionId(blocks[2]!.position)));
    expect(error.code).toBe('disk_capture_invalid');
});

test('evidence refuses a provider without the SHiP session and ABI observer it recomputes with', async () => {
    expect(() => new DiskSourceEvidence({state_history_dir: '.', blocks_dir: '.', ship_abi: '.'}, 'a'.repeat(64), catalog,
        {profileId: profile.profileId} as any, preflight.chainId, profile)).toThrow('SHiP session and ABI observer');
});
