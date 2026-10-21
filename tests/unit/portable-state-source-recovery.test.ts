import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import type {ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import type {ProjectionBlock, ProjectionCheckpoint, ProjectionDefinition, ProjectionRetainedCheckpointView} from '@eosrio/hyperion-sdk/projection';
import {ProtocolAbiCoordinator} from '../../src/indexer/protocol/abi-coordinator.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiObservationStore, protocolAbiCaptureDigest} from '../../src/indexer/protocol/abi-observation-store.js';
import {ProtocolSourceBindingStore} from '../../src/indexer/protocol/source-bindings.js';
import {PortableProjectionSource} from '../../src/indexer/projection/source.js';
// @ts-ignore Component transport fixture; never a production database or Wire codec qualification.
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

const chainId = '1'.repeat(64), chain = 'source-recovery-fixture';
const id = (value: number) => value.toString(16).padStart(64, '0');
const point = (height: number, identity = height): ProjectionCheckpoint => ({blockNum: height, blockId: id(identity)});
const block = (height: number, identity = height, parent = height - 1): ProjectionBlock => ({...point(height, identity), previousBlockId: id(parent)});
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const schemaJson = '{"version":"engineering-only"}';
const profile = {id: 'source-engineering', profileId: 'source-engineering-v1', components: [
    {id: 'fixture', runtime: 'node' as const, version: '0.0.0-dev.1', sourceRevision: 'b'.repeat(40), sha256: 'c'.repeat(64)}]};
const definition: ProjectionDefinition = {schemaVersion: 1, id: 'items', mappingRevision: 'a'.repeat(64),
    source: {contract: 'alpha', table: 'items', abiDeployment: `${id(1)}:alpha:${sha(Buffer.from('aa', 'hex'))}`,
        abiSha256: sha(Buffer.from('aa', 'hex'))}, fields: [{name: 'owner', path: ['owner'], type: 'string'}], initialization: {kind: 'genesis'}};
function retained(points: readonly ProjectionCheckpoint[], pending: ProjectionBlock | null = null, gap: ProjectionBlock | null = null): ProjectionRetainedCheckpointView {
    const checkpoint = points[0], floor = points.at(-1)!;
    return {recovery: {binding: {chainId, backendId: 'mongo', projectionId: definition.id,
        mappingRevision: definition.mappingRevision, abiDeployment: definition.source.abiDeployment, abiSha256: definition.source.abiSha256,
        generation: 'd'.repeat(64)}, checkpoint, initialized: checkpoint.blockNum > 0,
        pending: pending && {block: pending, digest: null, reason: 'retry'}, gap: gap && {block: gap, digest: null, reason: 'gap'},
        revision: 'e'.repeat(64), coverage: {floor, retainedBlocks: points.length - 1, retainedBytes: points.length - 1,
            maxBlocks: 4096, maxBytes: 1024 * 1024 * 1024}, rollback: null}, checkpoints: points};
}

/** Opaque constructed facts exercise the actual journal/coordinator/proof/planner, not a Wire value codec. */
async function fixture(maximumAncestry = 256) {
    const memory = frontierMemoryClient(), store = new ProtocolAbiFrontierStore(memory.client, chain);
    const bindings = new ProtocolSourceBindingStore(memory.client, chain), observations = new ProtocolAbiObservationStore(memory.client, chain);
    const nativeFacts = {schemaVersion: 1 as const, previousBlockId: id(0), applicationState: 'empty' as const,
        abiStates: [{account: 'alpha', abiHex: 'aa', present: true as const, deltaOrdinal: 0}]};
    const provider = {profileId: profile.profileId, contractCodec: {decodeAbi: () => ({version: 'engineering-only'})},
        verifyNativeGenesis: () => nativeFacts} as unknown as ProtocolProvider;
    const coordinator = new ProtocolAbiCoordinator({chainId, profile, ownerId: 'source-owner', store, bindings, observations,
        verifyNativeGenesis: provider.verifyNativeGenesis});
    await coordinator.start();
    const contextId = (await bindings.prepareContext({schemaVersion: 1, chainId, protocol: profile, schemaJson})).id;
    let generation = (await coordinator.openSource(contextId, 'reader')).generation;
    async function append(height: number, identity = height, parent = height - 1, irreversible = point(0), abiHex?: string) {
        const source = {...point(height, identity), chainId, previousBlockId: height === 1 ? null : id(parent)};
        const capture = {kind: 'unattested-ship-result-sections-v1' as const, schemaJson, blockHex: '00',
            tracesHex: height === 1 ? null : '00', deltasHex: '00'};
        const captureSha256 = protocolAbiCaptureDigest(source, capture);
        const selectionId = (await bindings.prepareSelection({schemaVersion: 1, contextId, readerSessionId: 'reader', readerRole: 'live',
            assignmentId: null, source, captureSha256, frameSha256: sha(`frame-${height}-${identity}-${irreversible.blockId}`),
            head: irreversible.blockNum > height ? irreversible : point(height, identity), irreversible})).id;
        const publication = {transactionId: id(100000 + identity), actionOrdinal: 1, inputActionOrdinal: 1,
            receiver: 'alpha', account: 'alpha', name: 'setabi', rawHex: '00', globalSequence: String(height), receiptAbiSequence: '1'};
        const record = {schemaVersion: 1 as const, protocol: profile, source: {...source, inputSha256: captureSha256}, capture,
            observation: height === 1 ? {status: 'native-genesis' as const, facts: nativeFacts}
                : {status: 'observed' as const, facts: {schemaVersion: 1 as const,
                    actionInputs: abiHex === undefined ? [] : [publication],
                    deployments: abiHex === undefined ? [] : [{account: 'alpha', abiHex,
                        action: {transactionId: publication.transactionId, actionOrdinal: 1},
                        globalSequence: publication.globalSequence, effect: 'native-before-receipt' as const}],
                    finalStates: abiHex === undefined ? [] : [{account: 'alpha', present: true, abiHex, deltaOrdinal: 0}]}}};
        const receipt = await observations.prepare(record);
        await bindings.prepareObservationLink({schemaVersion: 1, selectionId, observationId: receipt.id, observationDigest: receipt.digest});
        const admission = await coordinator.admit(selectionId, generation); generation = admission.generation;
        expect(admission.status).toBe('accepted'); await coordinator.drain();
        return {selectionId, source, commitId: (await coordinator.inspect()).head!.commitId};
    }
    const source = () => new PortableProjectionSource({client: memory.client, chain, chainId, profile, provider, maxAncestryBlocks: maximumAncestry});
    return {memory, store, coordinator, bindings, append, source};
}

test('plans from one validated retained snapshot and rejects cloned grants and running operations', async () => {
    const f = await fixture(); await f.append(1); await f.append(2); await f.append(3);
    const source = f.source(), input = retained([point(2), point(1), point(0)]);
    const plan = await source.planRecovery(input, 'reversible');
    expect(plan).toEqual({target: point(3), reportedIrreversible: point(0), finality: 'reversible', checkpointStatus: 'canonical',
        intents: {pending: 'absent', gap: 'absent'}, rollback: null});
    expect(Object.isFrozen(plan.target)).toBe(true);
    await source.revalidateRecovery(plan);
    await expect(source.revalidateRecovery({...plan})).rejects.toMatchObject({statusCode: 503});
    input.recovery.checkpoint.blockId = id(99); // The issued grant captured its input before any I/O.
    await source.revalidateRecovery(plan);
    const running = retained([point(2), point(1)]);
    (running.recovery as any).rollback = {operationId: 'original', sourceRevision: 'f'.repeat(64), from: point(3), ancestor: point(1),
        status: 'running', reason: null};
    await expect(source.planRecovery(running, 'reversible')).rejects.toMatchObject({statusCode: 503});
});

test('finds the newest exact retained common ancestor after restart instead of assuming the retained floor', async () => {
    const f = await fixture(2); await f.append(1); await f.append(2); await f.append(3); await f.append(4);
    const old = retained([point(4), point(3), point(2), point(1), point(0)]);
    await f.append(3, 30, 2); await f.append(4, 40, 30);
    const source = f.source(), plan = await source.planRecovery(old, 'reversible');
    expect(plan.checkpointStatus).toBe('orphaned');
    expect(plan.rollback).toEqual({ancestor: point(2), reason: 'orphaned-checkpoint'});
    await source.revalidateRecovery(plan);
    expect(f.memory.calls.filter((call: any) => call.method === 'get').length).toBeGreaterThan(0);
});

test('same-height orphan intents cancel at the actual applied point, while canonical pending failures are preserved', async () => {
    const f = await fixture(); await f.append(1); await f.append(2); await f.append(3); await f.append(4);
    const source = f.source();
    const orphan = await source.planRecovery(retained([point(2), point(1)], block(3, 30, 2)), 'reversible');
    expect(orphan.rollback).toEqual({ancestor: point(2), reason: 'orphaned-intent'});
    const canonical = await source.planRecovery(retained([point(2), point(1)], block(3), block(4, 40, 3)), 'reversible');
    expect(canonical.intents).toEqual({pending: 'canonical', gap: 'orphaned'});
    expect(canonical.rollback).toBeNull();
    const repaired = await source.planRecovery(retained([point(3), point(2), point(1)], null, block(4, 40, 3)), 'reversible');
    expect(repaired.intents).toEqual({pending: 'absent', gap: 'orphaned'});
    expect(repaired.rollback).toEqual({ancestor: point(3), reason: 'orphaned-intent'});
});

test('ahead-of-coverage checkpoints and unresolved pending or gap work never grant cancellation', async () => {
    const f = await fixture(); await f.append(1); await f.append(2);
    const source = f.source();
    const pending = await source.planRecovery(retained([point(2), point(1)], block(3, 30, 2)), 'reversible');
    expect(pending.intents.pending).toBe('unresolved'); expect(pending.rollback).toBeNull();
    const ahead = await source.planRecovery(retained([point(4), point(3), point(2)]), 'reversible');
    expect(ahead.checkpointStatus).toBe('ahead'); expect(ahead.rollback).toBeNull();
    const gap = await source.planRecovery(retained([point(2), point(1)], null, block(5, 50, 40)), 'reversible');
    expect(gap.intents.gap).toBe('unresolved'); expect(gap.rollback).toBeNull();
});

test('missing applied ancestry requests durable rollback-unavailable with an explicit canonical candidate', async () => {
    const f = await fixture(); await f.append(1); await f.append(2); await f.append(3, 30, 2);
    const source = f.source(), plan = await source.planRecovery(retained([point(3)]), 'reversible');
    expect(plan.rollback).toEqual({ancestor: point(3, 30), reason: 'retention-unavailable'});
});

test('applied metadata from another chain cannot receive a canonical recovery grant', async () => {
    const f = await fixture(); await f.append(1); await f.append(2);
    const foreign = retained([point(1), point(0)]);
    (foreign.recovery.binding as {chainId: string}).chainId = 'f'.repeat(64);
    await expect(f.source().planRecovery(foreign, 'reversible')).rejects.toMatchObject({code: 'projection.invalid-contract'});
});

test('keeps reported LIB ahead of historical coverage and permits irreversible native-genesis initialization', async () => {
    const f = await fixture(); await f.append(1, 1, 0, point(1000));
    const source = f.source(), plan = await source.planRecovery(retained([point(0)]), 'irreversible');
    expect(plan.target).toEqual(point(1)); expect(plan.reportedIrreversible).toEqual(point(1000));
    expect(plan.checkpointStatus).toBe('canonical'); expect(plan.rollback).toBeNull();
    expect((await source.frame(1, definition, undefined, plan.target)).frame.block).toEqual(block(1));
    await source.assertState(await source.openState(point(1), 'irreversible'), definition);
});

test('validates exact LIB identity and rejects regression and reconnect revocation', async () => {
    const f = await fixture(); await f.append(1); await f.append(2, 2, 1, point(1));
    const source = f.source(), plan = await source.planRecovery(retained([point(1)]), 'irreversible');
    expect(plan.target).toEqual(point(1));
    await f.append(3, 3, 2, point(0));
    await expect(source.revalidateRecovery(plan)).rejects.toMatchObject({statusCode: 503});
    const invalid = await fixture(); await invalid.append(1); await invalid.append(2, 2, 1, point(1, 99));
    await expect(invalid.source().planRecovery(retained([point(1)]), 'irreversible')).rejects.toMatchObject({statusCode: 503});
    await f.coordinator.revokeSource('reader');
    await expect(source.revalidateRecovery(plan)).rejects.toMatchObject({statusCode: 503});
});

test('a restarted irreversible instance keeps its canonical finality floor while replay reports an older LIB', async () => {
    const f = await fixture(); await f.append(1); await f.append(2); await f.append(3, 3, 2, point(3));
    // This completed point belongs to an independently initialized irreversible instance.
    const applied = retained([point(3), point(2), point(1)]);
    await f.append(4, 4, 3, point(2));
    const restarted = f.source(), waiting = await restarted.planRecovery(applied, 'irreversible');
    expect(waiting.target).toEqual(point(2)); expect(waiting.checkpointStatus).toBe('canonical');
    expect(waiting.rollback).toBeNull();
    await expect(restarted.openState(point(3), 'irreversible')).rejects.toMatchObject({statusCode: 503});
    await f.append(5, 5, 4, point(4));
    const resumed = await restarted.planRecovery(applied, 'irreversible');
    expect(resumed.target).toEqual(point(4)); expect(resumed.rollback).toBeNull();
    await restarted.assertState(await restarted.openState(point(3), 'irreversible'), definition);
});

test('a proven orphan irreversible checkpoint stays unavailable without issuing an undo plan', async () => {
    const f = await fixture(); await f.append(1); await f.append(2, 2, 1, point(2));
    const applied = retained([point(2), point(1)]);
    await f.append(2, 20, 1, point(2, 20));
    await expect(f.source().planRecovery(applied, 'irreversible')).rejects.toMatchObject({statusCode: 503});
    expect((await f.source().planRecovery(applied, 'reversible')).rollback)
        .toEqual({ancestor: point(1), reason: 'orphaned-checkpoint'});
});

test('uses certified native genesis for reversible rollback to zero and never treats zero as a serving grant', async () => {
    const f = await fixture(); await f.append(1, 10); await f.append(2, 20, 10);
    const source = f.source(), plan = await source.planRecovery(retained([point(1), point(0)]), 'reversible');
    expect(plan.rollback).toEqual({ancestor: point(0), reason: 'orphaned-checkpoint'});
    await expect(source.openState(point(0), 'irreversible')).rejects.toMatchObject({statusCode: 503});
    await expect(source.openState(point(1, 10), 'irreversible')).rejects.toMatchObject({statusCode: 503});
});

test('irreversible queries validate ABI at completed state and eligible target despite a later reversible ABI change', async () => {
    const f = await fixture(); await f.append(1); await f.append(2, 2, 1, point(2));
    const source = f.source(), state = await source.openState(point(1), 'irreversible');
    await f.append(3, 3, 2, point(2), 'bb');
    await source.assertState(state, definition);
    await expect(source.assertState({...state}, definition)).rejects.toMatchObject({statusCode: 503});
    const reversible = await source.openState(point(1), 'reversible');
    await expect(source.assertState(reversible, definition)).rejects.toMatchObject({code: 'projection.invalid-contract'});
    await expect(source.openState(point(3), 'irreversible')).rejects.toMatchObject({statusCode: 503});
});

test('bounded missing input fences the exact eligible target rather than a later reversible head', async () => {
    const f = await fixture(2); await f.append(1); await f.append(2); await f.append(3, 3, 2, point(3)); await f.append(4, 4, 3, point(3));
    const source = f.source(), plan = await source.planRecovery(retained([point(0)]), 'irreversible');
    const admitted: ProjectionBlock[] = [];
    await expect(source.frame(1, definition, async block => {admitted.push(block);}, plan.target))
        .rejects.toMatchObject({name: 'PortableProjectionFrameError', block: block(3)});
    expect(admitted).toEqual([block(3)]);
    const forged: ProjectionBlock[] = [];
    await expect(source.frame(1, definition, async block => {forged.push(block);}, point(3, 99)))
        .rejects.toMatchObject({statusCode: 503});
    expect(forged).toEqual([]);
    await expect(source.frame(4, definition, undefined, plan.target)).rejects.toMatchObject({statusCode: 503});
});

test('fork revocation invalidates a captured recovery plan before admission and an issued query state', async () => {
    const f = await fixture(); await f.append(1); await f.append(2);
    const source = f.source(), plan = await source.planRecovery(retained([point(1)]), 'reversible');
    const state = await source.openState(point(1), 'reversible');
    await f.append(2, 20, 1);
    await expect(source.revalidateRecovery(plan)).rejects.toMatchObject({statusCode: 503});
    await expect(source.assertState(state, definition)).rejects.toMatchObject({statusCode: 503});
});
