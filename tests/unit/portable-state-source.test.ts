import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadChainProtocol} from '../../src/indexer/protocol/selection.js';
import {ProtocolAbiCoordinator} from '../../src/indexer/protocol/abi-coordinator.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiObservationStore} from '../../src/indexer/protocol/abi-observation-store.js';
import {ProtocolSourceBindingStore} from '../../src/indexer/protocol/source-bindings.js';
import {PortableProjectionSource} from '../../src/indexer/projection/source.js';
import {PROJECTION_CAPABILITIES, type ProjectionAdapter, type ProjectionDefinition} from '@eosrio/hyperion-sdk/projection';
import {resolvePortableStateConfiguration} from '../../src/indexer/projection/config.js';
import {createPortableStateReadGate} from '../../src/indexer/projection/production.js';
import {createPortableStateQueryService} from '../../src/indexer/projection/query-service.js';
import {PortableStateController} from '../../src/indexer/projection/controller.js';
import {admissionReason, projectionFailureApi, projectionFailureFixture} from './portable-state-failure-fixture.js';
// @ts-ignore This shared transport fixture is deliberately not a database or production authority.
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const read = (name: string) => readFileSync(new URL('./fixtures/wire-native-genesis/' + name, import.meta.url));
const original = read('ship-preflight-20261020.json'), forward = read('receipt-forward-2-4-20261020.json');
expect(hash(original)).toBe('b8edf652dd0ad265917bf0111ca48789ec7a3f1976f2113783202cc3dd38acb4');
expect(hash(forward)).toBe('38d75b7a1ba28e3abd77512854f963e7723631d6837df73bd7aeff656cc8a450');
const capture = JSON.parse(original.toString()), follow = JSON.parse(forward.toString());
const schemaJson = Buffer.from(capture.schema.base64, 'base64').toString('utf8');
const frames = [capture.messages.find((entry: any) => entry.kind === 'block1'),
    ...follow.messages.filter((entry: any) => entry.kind === 'block')].map((entry: any) => {
    const frame = Buffer.from(entry.response.base64, 'base64'); expect(hash(frame)).toBe(entry.response.sha256); return frame;
});
const definition: ProjectionDefinition = {schemaVersion: 1, id: 'future-items', mappingRevision: 'a'.repeat(64),
    source: {contract: 'items', table: 'items', abiDeployment: 'future-deployment', abiSha256: 'b'.repeat(64)},
    fields: [{name: 'owner', path: ['owner'], type: 'string'}], initialization: {kind: 'genesis'}};

/** Actual retained bytes and production source/coordinator methods; broker/ES transport is a component fixture. */
async function prepared(constructedEpochs: Record<number, {abiHex: string; present?: boolean; publish?: boolean}> = {}, initialThrough = 4) {
    const selected = await loadChainProtocol({provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId: capture.profileId});
    const profile = {id: selected.id, profileId: selected.provider.profileId, components: selected.components!};
    const memory = frontierMemoryClient(), chain = 'portable-source-fixture';
    const store = new ProtocolAbiFrontierStore(memory.client, chain), bindings = new ProtocolSourceBindingStore(memory.client, chain);
    const observations = new ProtocolAbiObservationStore(memory.client, chain);
    const coordinator = new ProtocolAbiCoordinator({chainId: capture.chainId, profile, ownerId: 'fixture-owner', store, bindings, observations,
        verifyNativeGenesis: selected.provider.verifyNativeGenesis?.bind(selected.provider)});
    await coordinator.start();
    const contextId = (await bindings.prepareContext({schemaVersion: 1, chainId: capture.chainId, protocol: profile, schemaJson})).id;
    const {generation} = await coordinator.openSource(contextId, 'fixture-source');
    const schema = JSON.parse(schemaJson);
    const positions: any[] = [], observed: string[] = [];
    async function advance(through: number) {
        const session = selected.provider.createShipSession(JSON.parse(schemaJson));
        try {
            const nativeDeltas: any = session.decodeDeltas(Buffer.from((session.decodeResult(frames[0]) as any)[1].deltas, 'hex'));
            const nativeAbiHex = (session.decodeRow('account', Buffer.from(nativeDeltas[0][1].rows[0].data, 'hex')) as any)[1].abi;
            const nativeAbi = selected.provider.contractCodec.decodeAbi(Buffer.from(nativeAbiHex, 'hex'));
            for (const frame of frames.slice(positions.length, through)) {
                const decoded: any = session.decodeResult(frame), result: any = decoded[1];
                const source = {chainId: capture.chainId, blockNum: Number(result.this_block.block_num), blockId: result.this_block.block_id,
                    previousBlockId: result.prev_block?.block_id ?? null};
                const epoch = constructedEpochs[source.blockNum];
                if (epoch) {
                    // Explicit constructed journal cases. Raw account/action sections are encoded with the production
                    // codec and facts are extracted by the actual observer; these are not additional captured blocks.
                    const account = ['account_v0', {name: 'target', creation_date: '2025-01-01T00:00:00.000', abi: epoch.abiHex}];
                    const raw = selected.provider.contractCodec.encodeValue(schema, 'account', account);
                    result.deltas = Buffer.from(selected.provider.contractCodec.encodeValue(schema, 'table_delta[]',
                        [['table_delta_v0', {name: 'account', rows: [{present: epoch.present === false ? 0 : 1, data: Buffer.from(raw).toString('hex')}]}]])).toString('hex');
                    if (epoch.publish) {
                        const traces: any = session.decodeTraces(Buffer.from(result.traces, 'hex'));
                        const action = traces[0][1].action_traces[0][1];
                        action.act.name = 'setabi'; action.act.data = Buffer.from(selected.provider.contractCodec.encodeValue(nativeAbi,
                            'setabi', {account: 'target', abi: epoch.abiHex})).toString('hex');
                        result.traces = Buffer.from(selected.provider.contractCodec.encodeValue(schema, 'transaction_trace[]', traces)).toString('hex');
                    }
                }
                const sourceFrame = epoch ? selected.provider.contractCodec.encodeValue(schema, 'result', decoded) : frame;
                const sections = {kind: 'unattested-ship-result-sections-v1' as const, schemaJson,
                    blockHex: result.block, tracesHex: result.traces, deltasHex: result.deltas};
                const {protocolAbiCaptureDigest} = await import('../../src/indexer/protocol/abi-observation-store.js');
                const captureSha256 = protocolAbiCaptureDigest(source, sections);
                const selectionId = (await bindings.prepareSelection({schemaVersion: 1, contextId, readerSessionId: 'fixture-source',
                    readerRole: 'live', assignmentId: null, source, frameSha256: hash(sourceFrame), captureSha256,
                    head: {blockNum: Number(result.head.block_num), blockId: result.head.block_id},
                    irreversible: {blockNum: Number(result.last_irreversible.block_num), blockId: result.last_irreversible.block_id}})).id;
                let observation: any;
                if (source.blockNum === 1) observation = {status: 'native-genesis', facts: selected.provider.verifyNativeGenesis!({schemaJson,
                    block: Buffer.from(result.block, 'hex'), traces: null, deltas: Buffer.from(result.deltas, 'hex')}, source)};
                else {
                    const deltas: any = session.decodeDeltas(Buffer.from(result.deltas, 'hex')), rows: any[] = [];
                    let ordinal = 0;
                    for (const [, delta] of deltas) for (const row of delta.rows) {
                        if (delta.name === 'account') {
                            const raw = Buffer.from(row.data, 'hex');
                            rows.push({ordinal, present: row.present === 1, raw, value: session.decodeRow('account', raw)});
                        }
                        ordinal++;
                    }
                    observation = {status: 'observed', facts: selected.provider.observeBlockAbi!({
                        traces: session.decodeTraces(Buffer.from(result.traces, 'hex')), accountRows: rows}, source)};
                }
                const receipt = await observations.prepare({schemaVersion: 1, protocol: profile,
                    source: {...source, inputSha256: captureSha256}, capture: sections, observation});
                await bindings.prepareObservationLink({schemaVersion: 1, selectionId, observationId: receipt.id, observationDigest: receipt.digest});
                await coordinator.admit(selectionId, generation); await coordinator.drain();
                positions.push(source); observed.push(receipt.id);
            }
        } finally {session.close?.();}
    }
    await advance(initialThrough);
    const options = {client: memory.client, chain, chainId: capture.chainId, profile, provider: selected.provider};
    memory.calls.length = 0;
    return {memory, options, coordinator, positions, observed, advance, source: new PortableProjectionSource(options)};
}

const observations = JSON.parse(readFileSync(new URL('../../node_modules/@eosrio/hyperion-wire-plugin/fixtures/abi-observations/vectors.json', import.meta.url), 'utf8'));
const sample = observations.vectors.find((entry: any) => entry.profileId === capture.profileId && entry.expected?.deployments.length > 1);
const abiA = sample.expected.deployments[0].abiHex, abiB = sample.expected.deployments[1].abiHex;
function pinned(p: Awaited<ReturnType<typeof prepared>>, height: number, abiHex: string): ProjectionDefinition {
    return {...definition, source: {contract: 'target', table: 'table',
        abiDeployment: `${p.positions[height - 1].blockId}:target:${hash(Buffer.from(abiHex, 'hex'))}`,
        abiSha256: hash(Buffer.from(abiHex, 'hex'))}};
}

test('real6508 original native1 and contiguous2..4 materialize complete empty frames with source graph evidence', async () => {
    const p = await prepared();
    for (let height = 1; height <= 4; height++) {
        const selected = await p.source.frame(height, definition);
        expect(selected.frame).toEqual({chainId: capture.chainId, block: {blockNum: height, blockId: p.positions[height - 1].blockId,
            previousBlockId: height === 1 ? '0'.repeat(64) : p.positions[height - 1].previousBlockId}, changes: []});
        expect(selected.evidence.observationId).toBe(p.observed[height - 1]);
        expect(selected.evidence.frameSha256).toBe(hash(frames[height - 1]));
        await p.source.revalidate(selected.proof);
    }
    expect(p.memory.calls.some((call: any) => ['createIndex', 'create', 'index'].includes(call.method))).toBe(false);
});

test('missing retained original input cannot certify an empty block and carries its actual incomplete target', async () => {
    const p = await prepared();
    for (const [key, entry] of p.memory.documents) if ((entry as any).document.bundle_id === p.observed[1]) p.memory.documents.delete(key);
    await expect(p.source.frame(2, definition)).rejects.toMatchObject({name: 'PortableProjectionFrameError',
        block: {blockNum: 2, blockId: p.positions[1].blockId}});
    expect(p.memory.calls.some((call: any) => ['createIndex', 'create', 'index'].includes(call.method))).toBe(false);
});

test('corrupted source bytes fail the immutable graph; incompatible selected artifacts cannot read it', async () => {
    const p = await prepared();
    for (const entry of p.memory.documents.values()) if ((entry as any).document.bundle_id === p.observed[2]
        && (entry as any).document.kind === 'chunk') (entry as any).document.payload = Buffer.from('{}').toString('base64');
    await expect(p.source.frame(3, definition)).rejects.toMatchObject({name: 'PortableProjectionFrameError'});
    const wrong = new PortableProjectionSource({...p.options, profile: {...p.options.profile, profileId: 'unselected'}});
    await expect(wrong.frame(1, definition)).rejects.toMatchObject({code: 'projection_source_unavailable'});
});

test('bounded old-input loss exposes a real canonical future target and source revocation invalidates issued proofs', async () => {
    const p = await prepared(), bounded = new PortableProjectionSource({...p.options, maxAncestryBlocks: 1});
    const admitted: unknown[] = [];
    await expect(bounded.frame(1, definition, async block => {admitted.push(block);})).rejects
        .toMatchObject({name: 'PortableProjectionFrameError', block: {blockNum: 4}});
    expect(admitted).toEqual([{blockNum: 4, blockId: p.positions[3].blockId, previousBlockId: p.positions[2].blockId}]);
    const selected = await p.source.frame(4, definition);
    await p.coordinator.revokeSource('fixture-source');
    await expect(p.source.revalidate(selected.proof)).rejects.toMatchObject({code: 'projection_source_unavailable'});
});

test('read-only missing journal lookup never provisions indices or projection storage', async () => {
    const selected = await loadChainProtocol({provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId: capture.profileId});
    const memory = frontierMemoryClient();
    const source = new PortableProjectionSource({client: memory.client, chain: 'absent-fixture', chainId: capture.chainId,
        profile: {id: selected.id, profileId: selected.provider.profileId, components: selected.components!}, provider: selected.provider});
    let admissions = 0;
    await expect(source.frame(1, definition, async () => {admissions++;})).rejects.toThrow();
    expect(admissions).toBe(0);
    expect(memory.calls.some((call: any) => ['createIndex', 'create', 'index'].includes(call.method))).toBe(false);
});

test('pre-deployment empty epochs replay but cannot grant definition readiness; exact deployment later permits reads', async () => {
    const p = await prepared({2: {abiHex: ''}, 3: {abiHex: abiA, publish: true}}), selected = pinned(p, 3, abiA);
    const before = await p.source.frame(2, selected);
    expect(before.frame.changes).toEqual([]);
    await expect(p.source.assertDefinition(before.proof, selected)).rejects.toMatchObject({code: 'projection.incomplete'});
    const active = await p.source.frame(3, selected);
    await p.source.assertDefinition(active.proof, selected);
    expect((await p.source.frame(4, selected)).frame.changes).toEqual([]);
});

for (const [name, next] of [['different ABI', {abiHex: abiB, publish: true}], ['ABI clear', {abiHex: '', publish: true}],
    ['deleted account', {abiHex: abiA, present: false}], ['identical-byte explicit setabi', {abiHex: abiA, publish: true}]] as const) {
    test(`no-row ${name} fences frame progress and already-issued old definition reads`, async () => {
        const p = await prepared({2: {abiHex: abiA, publish: true}, 3: next}), selected = pinned(p, 2, abiA);
        const active = await p.source.frame(2, selected);
        await expect(p.source.frame(3, selected)).rejects.toMatchObject({name: 'PortableProjectionFrameError',
            block: {blockNum: 3}, cause: {code: 'projection.invalid-contract'}});
        await expect(p.source.frame(4, selected)).rejects.toMatchObject({name: 'PortableProjectionFrameError'});
        await expect(p.source.assertDefinition(active.proof, selected)).rejects.toThrow();
    });
}

test('ordinary no-op account rows preserve the active deployment and strict inspector never authorizes an empty ABI', async () => {
    const p = await prepared({2: {abiHex: abiA, publish: true}, 3: {abiHex: abiA}}), selected = pinned(p, 2, abiA);
    const current = await p.source.frame(4, selected);
    await p.source.assertDefinition(current.proof, selected);
    const reader = new (await import('../../src/indexer/protocol/abi-proof.js')).ProtocolAbiProofReader({
        chainId: capture.chainId, profile: p.options.profile,
        store: new ProtocolAbiFrontierStore(p.memory.client, p.options.chain, 0, {readOnly: true})});
    const proof = await reader.open(p.positions[3]);
    expect((await reader.inspectFinalState(proof, 'target'))?.source.blockNum).toBe(2);
    expect(await reader.inspectFinalState(proof, 'target', {atBlockNum: 1})).toBeNull();
    await expect(reader.finalState(proof, 'sysio.null')).rejects.toMatchObject({code: 'abi_state_unavailable'});
    expect((await reader.inspectFinalState(proof, 'sysio.null'))?.abiHex).toBe('');
});

for (const [name, next] of [['replacement', {abiHex: abiB, publish: true}], ['clear', {abiHex: '', publish: true}]] as const) {
    test(`same-generation ABI ${name} during final proof revalidation rejects the prior checked head`, async () => {
        const p = await prepared({2: {abiHex: abiA, publish: true}, 3: next}, 2), selected = pinned(p, 2, abiA);
        const active = await p.source.frame(2, selected), revalidate = p.source.revalidate.bind(p.source);
        let advanced = false;
        p.source.revalidate = async proof => {
            if (!advanced) {advanced = true; await p.advance(4);}
            await revalidate(proof); // The old proof legitimately remains canonical under this newer same-generation head.
        };
        await expect(p.source.assertDefinition(active.proof, selected)).rejects.toMatchObject({code: 'projection.stale-view'});
        expect(advanced).toBe(true);
        expect(p.positions).toHaveLength(4);
    });
}

test('actual public query gate permits a stable head and refuses a late ABI clear before publication', async () => {
    const p = await prepared({2: {abiHex: abiA, publish: true}, 3: {abiHex: '', publish: true}}, 2), selected = pinned(p, 2, abiA);
    const configuration = resolvePortableStateConfiguration({backend: {kind: 'mongodb', id: 'fixture-mongo', database: 'fixture_state'},
        projections: [selected]}, capture.chainId)!;
    let queries = 0;
    const adapter = {
        capabilities: {interfaceVersion: 1, supported: PROJECTION_CAPABILITIES},
        async open(binding: any) {return {binding, checkpoint: {blockNum: 2, blockId: p.positions[1].blockId}};},
        async query(view: any) {
            if (++queries === 2) await p.advance(4);
            return {view, rows: [{key: 'old', value: {owner: 'alice'}}]};
        },
    } as unknown as ProjectionAdapter;
    const gate = createPortableStateReadGate({chainId: capture.chainId, configuration, adapter, source: p.source});
    const service = createPortableStateQueryService({chainId: capture.chainId, configuration, adapter, gate});
    expect((await service.query(selected.id, {filter: [], limit: 1})).rows).toEqual([{key: 'old', value: {owner: 'alice'}}]);
    await expect(service.query(selected.id, {filter: [], limit: 1})).rejects.toMatchObject({statusCode: 503,
        code: 'projection.incomplete', retryable: true});
    expect(queries).toBe(2);
    expect(p.positions).toHaveLength(4);
});

test('actual canonical source reserves before provider decode and a rejected failure marker cannot serve old state', async () => {
    const p = await prepared({2: {abiHex: abiA, publish: true}}), selected = pinned(p, 2, abiA);
    const checkpoint = {blockNum: 2, blockId: p.positions[1].blockId};
    const fixture = projectionFailureFixture(selected, capture.chainId, checkpoint, true), progress: any[] = [];
    fixture.faults.rejectDetailedMarker = true;
    let rejectDecode = true, decodes = 0;
    const createSession = p.options.provider.createShipSession.bind(p.options.provider);
    p.options.provider.createShipSession = schema => {
        const session = createSession(schema);
        return {...session, decodeDeltas(bytes) {
            decodes++;
            if (rejectDecode) throw new Error('controlled provider delta decode failure');
            return session.decodeDeltas(bytes);
        }};
    };
    const options = {chainId: capture.chainId, configuration: fixture.configuration, adapter: fixture.adapter,
        source: p.source, maximumFramesPerProjection: 1, onProgress: (value: any) => progress.push(value)};
    const controller = await PortableStateController.create(options), api = await projectionFailureApi(fixture, p.source);
    try {
        expect((await api.query()).statusCode).toBe(200);
        await controller.drain();
        const failure = await api.query(); expect(failure.statusCode).toBe(503); expect(failure.json().retryable).toBe(true);
        expect(fixture.metadata().pending).toEqual({block: {blockNum: 3, blockId: p.positions[2].blockId,
            previousBlockId: checkpoint.blockId}, digest: null, reason: admissionReason});
        expect(fixture.metadata().checkpoint).toMatchObject(checkpoint);
        expect(fixture.metadata().checkpoint.revision).toBe(fixture.metadata().revision);
        expect(progress.at(-1).status).toBe('incomplete'); expect(decodes).toBe(1);
        expect(fixture.calls.some(call => call.command === 'replace')).toBe(false);
        await controller.stop(); rejectDecode = false; fixture.faults.rejectDetailedMarker = false;
        const restarted = await PortableStateController.create({...options, adapter: fixture.createAdapter()});
        await restarted.drain();
        expect((await api.query()).statusCode).toBe(200);
        expect(fixture.metadata().checkpoint).toMatchObject({blockNum: 3, blockId: p.positions[2].blockId});
        expect(fixture.metadata().pending).toBeNull(); await restarted.stop();
    } finally {await controller.stop(); await api.app.close();}
});
