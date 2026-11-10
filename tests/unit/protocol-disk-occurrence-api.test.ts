import {test, expect, beforeAll, afterAll} from 'bun:test';
import {EventEmitter} from 'node:events';
import Fastify from 'fastify';
import {ProtocolActionConsumer, protectProtocolAction} from '../../src/api/helpers/protocol-abi.js';
import {withProtocolProofTransaction} from '../../src/api/helpers/protocol-proof-request.js';
import {ProtocolAbiProofReader, ProtocolAbiProofUnavailableError} from '../../src/indexer/protocol/abi-proof.js';
import {ProtocolNativeActionReader, ProtocolNativeActionUnavailableError} from '../../src/indexer/protocol/native-authorization.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {DiskAbiHistoryCatalog} from '../../src/indexer/protocol/disk-abi-history.js';
import {protocolDiskSelectionId, type DiskSourceRecords} from '../../src/indexer/protocol/disk-source-evidence.js';
import {protocolAbiObservationEvidence} from '../../src/indexer/protocol/abi-observation-store.js';
import {ProtocolNativeObservationStore, protocolNativeObservationEvidence, protocolSourceNativeObservationLinkId}
    from '../../src/indexer/protocol/native-observation-store.js';
import {protocolSourceContextId} from '../../src/indexer/protocol/source-bindings.js';
import {blockId, chain, chainId, nativeAuthorizationFixture, profile, schemaJson} from './protocol-native-authorization-host-fixture.js';
import {writeCatalog} from './disk-capture-fixture.js';

let fixture: Awaited<ReturnType<typeof nativeAuthorizationFixture>>, app: ReturnType<typeof Fastify>, diskSelection: string;
let catalog: DiskAbiHistoryCatalog;
afterAll(async () => {await catalog?.close();});

/** Disk evidence for block 2, recomputed as the logs would give it: the fixture's own observations. */
async function evidence(): Promise<{records(blockNum: number): Promise<DiskSourceRecords>}> {
    const position = await catalog.source(2);
    const abi = protocolAbiObservationEvidence(await fixture.observations.read(fixture.selected.abi.id));
    const context = {schemaVersion: 1 as const, chainId, protocol: profile, schemaJson};
    const selectionId = protocolDiskSelectionId(position);
    const native = {...protocolNativeObservationEvidence(fixture.selected.record), linkId: protocolSourceNativeObservationLinkId(selectionId)};
    const records: DiskSourceRecords = {position, selectionId, context, contextId: protocolSourceContextId(context), abi, native};
    return {async records(blockNum: number) {if (blockNum !== 2) throw new Error('fixture covers block 2'); return records;}};
}

beforeAll(async () => {
    fixture = await nativeAuthorizationFixture({nativeActionInterfaceVersion: 1});
    // Built directly: the process-wide catalog cache has a restart-gated budget other suites share.
    catalog = new DiskAbiHistoryCatalog(await writeCatalog(chainId, [blockId(1), blockId(2)], [], schemaJson), chainId, profile);
    diskSelection = protocolDiskSelectionId(await catalog.source(2));
    const diskHistory = {catalog, bindings: fixture.bindings, observations: fixture.observations, verifyNativeGenesis: undefined,
        evidence: await evidence()} as any;
    const proofReader = new ProtocolAbiProofReader({chainId, profile, diskHistory,
        store: new ProtocolAbiFrontierStore(fixture.client, chain, 0, {readOnly: true})});
    const nativeReader = new ProtocolNativeActionReader({chainId, profile, provider: fixture.provider, proofReader,
        store: new ProtocolNativeObservationStore(fixture.client, chain, 0, undefined, {readOnly: true})});
    app = Fastify({logger: false});
    app.decorate('manager', {chain, conn: {chains: {[chain]: {chain_id: chainId}}}, config: {settings: {es_replicas: 0,
        protocol: {provider: 'extension', package: 'synthetic-host-contract', profileId: profile.profileId}}, api: {enable_caching: false}}});
    app.decorate('elastic', fixture.client);
    const consumer = new ProtocolActionConsumer(app, {id: profile.id, provider: fixture.provider, components: profile.components} as any);
    Object.assign(consumer, {reader: proofReader, nativeReader});
    app.decorate('protocolActionConsumer', consumer);
});

const scope = () => ({method: 'GET', query: {}, routeOptions: {url: '/v2/history/get_actions'}, url: '/v2/history/get_actions',
    raw: Object.assign(new EventEmitter(), {aborted: false, socket: Object.assign(new EventEmitter(), {destroyed: false})})});
const protect = async (action: any) => {const request = scope(); await withProtocolProofTransaction(request, () => protectProtocolAction(app, request, action));};
/** A stored action document of block 2 for fixture input `index`, with `protocol` as given. */
function document(index: number, protocol: unknown, data?: unknown) {
    const input = fixture.selected.inputs[index]!;
    return {block_num: 2, block_id: blockId(2), trx_id: input.transactionId, action_ordinal: input.actionOrdinal, creator_action_ordinal: 0,
        global_sequence: input.globalSequence, act_digest: 'f'.repeat(64), code_sequence: 0, abi_sequence: 4294967295,
        act: {account: input.account, name: input.name, authorization: [], data: data ?? {rawHex: input.rawHex}},
        receipts: [{receiver: input.receiver, global_sequence: input.globalSequence, recv_sequence: '18446744073709551615', auth_sequence: [],
            code_sequence: 0, abi_sequence: 4294967295}], protocol};
}
const occurrence = (index: number, selectionId = diskSelection) =>
    ({schemaVersion: 3, source: {chainId, blockNum: 2, blockId: blockId(2)}, selectionId, input: fixture.selected.inputs[index]});
async function refusal(promise: Promise<unknown>) {
    try {await promise;} catch (error) {
        expect(error instanceof ProtocolAbiProofUnavailableError || error instanceof ProtocolNativeActionUnavailableError).toBe(true);
        return error as {code: string; message: string};
    }
    throw new Error('Expected a proof refusal');
}

test('a disk occurrence of a native action serves exactly like the indexer\'s stored row', async () => {
    const native = fixture.reader(), view = await native.open(fixture.selected.source, fixture.selected.selectionId);
    const decision = await native.authorize(view, fixture.selected.inputs[0]!);
    if (decision.kind !== 'native') throw new Error('native fixture expected');
    const stored = document(0, await native.metadata(decision.grant)), disk = document(0, occurrence(0));
    await protect(stored); await protect(disk);
    expect(disk.protocol).toMatchObject({schemaVersion: 2, kind: 'native', selectionId: diskSelection, input: fixture.selected.inputs[0]});
    delete (stored as any).protocol; delete (disk as any).protocol;
    expect(disk).toEqual(stored);
    expect(disk.act.data).toEqual({rawHex: fixture.selected.inputs[0]!.rawHex});
});

test('a disk occurrence of a contract action expands to contract metadata and needs its ABI like a stored one', async () => {
    const stored = document(3, {schemaVersion: 1, source: {chainId, blockNum: 2, blockId: blockId(2)}, selectionId: fixture.selected.selectionId,
        input: fixture.selected.inputs[3]}), disk = document(3, occurrence(3));
    const storedError = await refusal(protect(stored)), diskError = await refusal(protect(disk));
    expect(diskError.code).toBe(storedError.code);
    expect(diskError.code).toBe('abi_state_unavailable');
});

test('a disk occurrence is never decoded for an incomplete origin, tampered input or another block\'s selection', async () => {
    expect((await refusal(protect(document(4, occurrence(4))))).message).toContain('incomplete native origin');
    const tampered = {...occurrence(0), input: {...fixture.selected.inputs[0]!, rawHex: '0103'}};
    await refusal(protect(document(0, tampered, {rawHex: '0103'})));
    const elsewhere = protocolDiskSelectionId(await catalog.source(1));
    expect((await refusal(protect(document(0, occurrence(0, elsewhere))))).message).toContain('another catalog position');
});

test('raw disk occurrences stay served without decoding authority', async () => {
    const raw = document(0, occurrence(0), fixture.selected.inputs[0]!.rawHex);
    await protect(raw);
    expect(raw.act.data).toBe(fixture.selected.inputs[0]!.rawHex);
    expect((raw.protocol as any).schemaVersion).toBe(3);
});
