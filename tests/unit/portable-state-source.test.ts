import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {loadChainProtocol} from '../../src/indexer/protocol/selection.js';
import {ProtocolAbiProofReader} from '../../src/indexer/protocol/abi-proof.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {PortableProjectionSource} from '../../src/indexer/projection/source.js';
import {captureStatefulDeclaration} from '@eosrio/hyperion-sdk/projection-stateful';
import {captureStatefulOwnerDeclarationV2, negotiateStatefulOwnerV2, STATEFUL_OWNER_FAMILY_V2,
    STATEFUL_OWNER_HOST_CAPABILITIES_V2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {statefulAbiEpoch} from '../../src/indexer/projection/stateful-abi-epoch.js';
import {StatefulProjectionControllerV2} from '../../src/indexer/projection/stateful-controller.js';
import {createStatefulCandidateCustodyV2} from '../../src/indexer/projection/stateful-custody.js';
import {composeStatefulOwnerReadV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
// @ts-ignore Native commands use the existing storage transport fixture, not a physical service.
import {configured as configuredOwner, v1 as backendStateful} from '../../packages/backend-mongodb/tests/stateful-owner-v2-fixture.mjs';
// @ts-ignore Shared native adapter declaration fixture; no physical database is opened.
import {definition as statefulDefinition, limits as statefulLimits} from '../../packages/backend-mongodb/tests/stateful-fixture.mjs';
import type {ProjectionAdapter, ProjectionDefinition} from '@eosrio/hyperion-sdk/projection';
import {resolvePortableStateConfiguration} from '../../src/indexer/projection/config.js';
import {createPortableStateReadGate} from '../../src/indexer/projection/production.js';
import {createPortableStateQueryService} from '../../src/indexer/projection/query-service.js';
import {PortableStateController} from '../../src/indexer/projection/controller.js';
import {admissionReason, projectionFailureApi, projectionFailureFixture} from './portable-state-failure-fixture.js';
// @ts-ignore This shared transport fixture is deliberately not a database or production authority.
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

import {prepared, preparedStatefulInputs, hash, read, original, forward, capture, follow, schemaJson, frames} from './portable-state-source-fixture.mjs';

const definition: ProjectionDefinition = {schemaVersion: 1, id: 'future-items', mappingRevision: 'a'.repeat(64),
    source: {contract: 'items', table: 'items', abiDeployment: 'future-deployment', abiSha256: 'b'.repeat(64)},
    fields: [{name: 'owner', path: ['owner'], type: 'string'}], initialization: {kind: 'genesis'}};

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

test('original-block seam retains complete unfiltered captured sections and actual certified references', async () => {
    const p = await prepared(), admitted: any[] = [];
    const packet = await p.source.originalBlock(2, async target => {admitted.push(target);});
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toEqual({block: {blockNum: 2, blockId: p.positions[1].blockId,
        previousBlockId: p.positions[0].blockId}, reference: {commitId: packet.proof.commitId,
        selectionId: packet.proof.selectionId, observationId: p.observed[1], observationDigest: packet.evidence.observationDigest}});
    expect(Object.isFrozen(admitted[0].reference)).toBe(true);
    expect(Object.keys(admitted[0].reference).sort()).toEqual(['commitId', 'observationDigest', 'observationId', 'selectionId']);
    expect(packet.evidence.frameSha256).toBe(hash(frames[1]));
    const session = p.options.provider.createShipSession(JSON.parse(schemaJson));
    try {
        const result: any = (session.decodeResult(frames[1]) as any)[1];
        expect(packet.observation.capture).toEqual({kind: 'unattested-ship-result-sections-v1', schemaJson,
            blockHex: result.block, tracesHex: result.traces, deltasHex: result.deltas});
    } finally {session.close?.();}
    expect(p.memory.calls.some((call: any) => ['createIndex', 'create', 'index'].includes(call.method))).toBe(false);
});

test('stateful-v2 source consumes retained native genesis and full original vectors with the sealed Wire table port', async () => {
    const p = await prepared();
    expect(p.options.provider.statefulTables?.interfaceVersion).toBe(2);
    const definition = statefulDefinition();
    definition.binding.chainId = capture.chainId;
    definition.selectors = [{id: 'future-items', kind: 'table', contract: 'items', name: 'items',
        abiDeployment: 'future-deployment', abiSha256: 'b'.repeat(64)}];
    const d = await captureStatefulOwnerDeclarationV2(await captureStatefulDeclaration(definition, statefulLimits()), 2);
    const admitted: number[] = [];
    for (let height = 1; height <= 4; height++) {
        const selected = await p.source.statefulBlock(height, d, async target => {admitted.push(target.block.blockNum);});
        expect(selected.source.source.block).toMatchObject({blockNum: height, blockId: p.positions[height - 1].blockId});
        expect(selected.source.source.block.timeMs).toMatch(/^[0-9]+$/);
        expect(selected.source.source.inputs).toEqual([]);
        expect(selected.evidence.observationId).toBe(p.observed[height - 1]);
        await p.source.revalidate(selected.proof);
    }
    expect(admitted).toEqual([1, 2, 3, 4]);
    expect(p.memory.calls.some((call: any) => ['createIndex', 'create', 'index'].includes(call.method))).toBe(false);
});

test('constructed selected action and block-end KV rows retain real epoch, coordinates, bytes and absent scope', async () => {
    const {p, value, rawValue} = await preparedStatefulInputs();
    const reader = new ProtocolAbiProofReader({chainId: capture.chainId, profile: p.options.profile,
        store: new ProtocolAbiFrontierStore(p.options.client, p.options.chain, 0, {readOnly: true})});
    const proof = await reader.open(p.positions[2]), epoch = statefulAbiEpoch(await reader.finalState(proof, 'target'));
    const definition = statefulDefinition(); definition.binding.chainId = capture.chainId;
    definition.selectors = [{id: 'update', kind: 'action', contract: 'target', name: 'update', abiDeployment: epoch.id, abiSha256: epoch.abiSha256},
        {id: 'records', kind: 'table', contract: 'target', name: 'records', abiDeployment: epoch.id, abiSha256: epoch.abiSha256}];
    const d = await captureStatefulOwnerDeclarationV2(await captureStatefulDeclaration(definition, statefulLimits()), 2);
    const result = await p.source.statefulBlock(3, d, async () => {}), inputs = result.source.source.inputs;
    expect(inputs.map(value => value.kind)).toEqual(['action', 'table', 'table', 'table']);
    expect(inputs[0]).toMatchObject({data: value, rawHex: rawValue, receiptOrdinal: 0, actionOrdinal: 1, abiDeployment: epoch.id});
    expect(inputs[1]).toMatchObject({identity: {kind: 'kv-primary', tableId: 0, keyHex: '000001'}, payer: 'payer', data: value,
        deltaOrdinal: 0, rowOrdinal: 0, present: true});
    expect(inputs[2]).toMatchObject({identity: {kind: 'kv-primary', tableId: 0, keyHex: '000001'}, data: null,
        deltaOrdinal: 0, rowOrdinal: 1, present: false});
    expect(inputs[3]).toMatchObject({identity: {kind: 'kv-secondary', tableId: 65535, secondaryKeyHex: '0000', primaryKeyHex: '000001'},
        payer: 'otherpayer', data: null, deltaOrdinal: 1, rowOrdinal: 0});
    for (const input of inputs.filter(value => value.kind === 'table')) expect(Object.hasOwn(input.identity, 'scope')).toBe(false);
    expect((await p.source.statefulBlock(3, d, async () => {})).source.digest).toBe(result.source.digest);
    await p.source.assertStatefulView(result.proof, d);
    await expect(p.source.statefulBlock(3, await captureStatefulOwnerDeclarationV2(await captureStatefulDeclaration({...definition,
        selectors: definition.selectors.map((value: any) => ({...value, abiDeployment: 'earlier-epoch'}))}, statefulLimits()), 2), async () => {})).rejects.toThrow('epoch');
});

test('actual source/owner loop repairs apply-before-retire with immutable custody and a fresh owner without reducer rerun', async () => {
    const p = await prepared({2: {abiHex: abiA}}), reader = new ProtocolAbiProofReader({chainId: capture.chainId,
        profile: p.options.profile, store: new ProtocolAbiFrontierStore(p.options.client, p.options.chain, 0, {readOnly: true})});
    const proof = await reader.open(p.positions[3]), epoch = statefulAbiEpoch(await reader.finalState(proof, 'target'));
    const definition = statefulDefinition(); definition.binding.chainId = capture.chainId;
    definition.selectors = [{id: 'target-table', kind: 'table', contract: 'target', name: 'table',
        abiDeployment: epoch.id, abiSha256: epoch.abiSha256}];
    const projection = await captureStatefulDeclaration(definition, statefulLimits());
    const native = await configuredOwner(undefined, {projection: await backendStateful.captureStatefulDeclaration(definition, statefulLimits())});
    // Host and backend deliberately have independent installed SDK module identities.
    const declaration = await negotiateStatefulOwnerV2(projection, {family: STATEFUL_OWNER_FAMILY_V2,
        interfaceVersion: 2, sourceInputVersions: [2], supported: STATEFUL_OWNER_HOST_CAPABILITIES_V2, limits: projection.limits}, native.adapter.capabilities);
    const custody = createStatefulCandidateCustodyV2(p.options.client, p.options.chain, 0, declaration);
    let reductions = 0, refuseRetire = false;
    const adapter = new Proxy(native.adapter, {get(target, key) {
        if (key === 'retireRaw') return async (...args: any[]) => {
            if (refuseRetire) {refuseRetire = false; throw new Error('constructed interruption after committed domain write');}
            return target.retireRaw(...args);
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    }});
    const options = {declaration, adapter, source: p.source, custody, assertActive() {}, requireAttemptScope: false,
        run: async (_metadata: unknown, operation: () => Promise<boolean>) => operation(), maximumFramesPerDrain: 1,
        reduce: async (port: any) => {reductions++; port.put('collection', 'last', {height: port.source.block.blockNum});}};
    const first = new StatefulProjectionControllerV2({...options, identity: {id: 'component-owner', generation: 'one'}});
    await first.drain(); await first.drain();
    const before = await native.adapter.recovery(); expect(before.view.checkpoint.blockNum).toBe(2);
    await first.attest({declarationDigest: declaration.digest, owner: before.owner, view: before.view});
    refuseRetire = true; await first.drain();
    const interrupted = await native.adapter.recovery();
    expect(interrupted.view.checkpoint.blockNum).toBe(3); expect(interrupted.raw).not.toBeNull(); expect(interrupted.gap).not.toBeNull();
    expect(reductions).toBe(3);
    await expect(first.attest({declarationDigest: declaration.digest, owner: interrupted.owner, view: interrupted.view})).rejects.toThrow();
    await first.stop();
    const second = new StatefulProjectionControllerV2({...options, identity: {id: 'component-owner', generation: 'two'}});
    await expect(second.attest({declarationDigest: declaration.digest, owner: interrupted.owner, view: interrupted.view})).rejects.toThrow();
    await second.drain(); const recovered = await native.adapter.recovery();
    expect(recovered.view.checkpoint.blockNum).toBe(3); expect(recovered.raw).toBeNull(); expect(recovered.gap).toBeNull();
    expect(recovered.owner.identity.generation).toBe('two'); expect(reductions).toBe(3);
    const expected = {declarationDigest: declaration.digest, owner: recovered.owner, view: recovered.view};
    await second.attest(expected);
    const response = await composeStatefulOwnerReadV2(declaration, native.adapter, recovered.owner.identity, recovered.view,
        async port => ({row: (await port.get('collection', 'last'))}), () => {});
    expect(response.value.row).toEqual({status: 'present', value: {height: 3}});
    await second.drain(); expect((await native.adapter.recovery()).view.checkpoint.blockNum).toBe(4); expect(reductions).toBe(4);
    await expect(second.attest(expected)).rejects.toThrow();
    await second.stop();
});

test('raw target is admitted before a missing retained selection fails without placeholder capture hashes', async () => {
    const p = await prepared(), admitted: any[] = [];
    await expect(p.source.originalBlock(2, async target => {
        admitted.push(target);
        for (const [key, entry] of p.memory.documents)
            if ((entry as any).document.bundle_id === target.reference.selectionId) p.memory.documents.delete(key);
    })).rejects.toThrow();
    expect(admitted).toHaveLength(1);
    expect(admitted[0].block.blockNum).toBe(2);
    expect(admitted[0].reference.observationId).toBe(p.observed[1]);
    expect(Object.hasOwn(admitted[0].reference, 'captureSha256')).toBe(false);
    expect(Object.hasOwn(admitted[0].reference, 'frameSha256')).toBe(false);
    expect(p.memory.calls.some((call: any) => ['createIndex', 'create', 'index'].includes(call.method))).toBe(false);
});

test('unknown raw admission outcome prevents capture reads and preserves the original failure', async () => {
    const p = await prepared(), unknown = new Error('raw admission acknowledgement unknown');
    let atAdmission = -1;
    await expect(p.source.originalBlock(2, async () => {
        atAdmission = p.memory.calls.length; throw unknown;
    })).rejects.toBe(unknown);
    expect(atAdmission).toBeGreaterThan(0);
    expect(p.memory.calls.length).toBe(atAdmission);
});

test('raw original-block packet cannot return after its source owner is revoked during admission', async () => {
    const p = await prepared();
    await expect(p.source.originalBlock(2, async () => {
        await p.coordinator.revokeSource('fixture-source');
    })).rejects.toMatchObject({code: 'projection_source_unavailable'});
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
    let arm = false, finalRevalidations = 0, queries = 0;
    const adapter = {
        async open(binding: any) {return {binding, checkpoint: {blockNum: 2, blockId: p.positions[1].blockId}};},
        async query(view: any) {queries++; arm = queries === 2; return {view, rows: [{key: 'old', value: {owner: 'alice'}}]};},
    } as unknown as ProjectionAdapter;
    const revalidate = p.source.revalidate.bind(p.source);
    p.source.revalidate = async proof => {
        // The final real gate first revalidates the source, then calls assertDefinition. Advance only inside
        // assertDefinition's own final revalidation, after its checked ABI head has been selected.
        if (arm && ++finalRevalidations === 2) await p.advance(4);
        await revalidate(proof);
    };
    const gate = createPortableStateReadGate({chainId: capture.chainId, configuration, adapter, source: p.source});
    const service = createPortableStateQueryService({chainId: capture.chainId, configuration, adapter, gate});
    expect((await service.query(selected.id, {filter: [], limit: 1})).rows).toEqual([{key: 'old', value: {owner: 'alice'}}]);
    await expect(service.query(selected.id, {filter: [], limit: 1})).rejects.toMatchObject({statusCode: 503,
        code: 'projection.stale-view', retryable: true});
    expect(finalRevalidations).toBe(2);
    expect(queries).toBe(2);
    expect(p.positions).toHaveLength(4);
});

test('actual canonical source reserves before provider decode and a rejected failure marker cannot serve old state', async () => {
    const p = await prepared({2: {abiHex: abiA, publish: true}}), selected = pinned(p, 2, abiA);
    const checkpoint = {blockNum: 2, blockId: p.positions[1].blockId};
    const fixture = projectionFailureFixture(selected, capture.chainId, checkpoint), progress: any[] = [];
    fixture.faults.rejectDetailedMarker = true;
    let rejectDecode = true, decodes = 0;
    const admittedProvider = p.options.provider, originalSource = p.source;
    expect(Object.isFrozen(admittedProvider)).toBe(true);
    // The selected provider stays immutable; only this fixture's source receives the fault wrapper.
    p.source = new PortableProjectionSource({...p.options, provider: {...admittedProvider, createShipSession(schema) {
        const session = admittedProvider.createShipSession(schema);
        return {...session, decodeDeltas(bytes) {
            decodes++;
            if (rejectDecode) throw new Error('controlled provider delta decode failure');
            return session.decodeDeltas(bytes);
        }};
    }}});
    const options = {chainId: capture.chainId, configuration: fixture.configuration, adapter: fixture.adapter,
        source: p.source, maximumFramesPerProjection: 1, onProgress: (value: any) => progress.push(value)};
    const controller = await PortableStateController.create(options), api = await projectionFailureApi(fixture, p.source);
    try {
        expect((await api.query()).statusCode).toBe(200);
        await controller.drain();
        const failure = await api.query(); expect(failure.statusCode).toBe(503); expect(failure.json().retryable).toBe(true);
        expect(fixture.metadata().pending).toEqual({block: {blockNum: 3, blockId: p.positions[2].blockId,
            previousBlockId: checkpoint.blockId}, digest: null, reason: admissionReason});
        expect(fixture.metadata().checkpoint).toEqual(checkpoint);
        expect(progress.at(-1).status).toBe('incomplete'); expect(decodes).toBe(1);
        expect(fixture.calls.some(call => call.command === 'replace')).toBe(false);
        await controller.stop(); rejectDecode = false; fixture.faults.rejectDetailedMarker = false;
        const restarted = await PortableStateController.create({...options, adapter: fixture.createAdapter()});
        await restarted.drain();
        expect((await api.query()).statusCode).toBe(200);
        expect(fixture.metadata().checkpoint).toEqual({blockNum: 3, blockId: p.positions[2].blockId});
        expect(fixture.metadata().pending).toBeNull(); await restarted.stop();
    } finally {p.source = originalSource; await controller.stop(); await api.app.close();}
});
