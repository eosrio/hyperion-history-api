import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import type {ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import type {ProjectionCheckpoint} from '@eosrio/hyperion-sdk/projection';
import {stateResponseHeaders} from '../../src/api/helpers/state-headers.js';
import {ProtocolAbiCoordinator} from '../../src/indexer/protocol/abi-coordinator.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiObservationStore, protocolAbiCaptureDigest} from '../../src/indexer/protocol/abi-observation-store.js';
import {ProtocolAbiProofUnavailableError} from '../../src/indexer/protocol/abi-proof.js';
import {ProtocolSourceBindingStore} from '../../src/indexer/protocol/source-bindings.js';
import {PortableProjectionSource} from '../../src/indexer/projection/source.js';
import {resolveStatefulOwnerConfigurationV2} from '../../src/indexer/projection/stateful-config.js';
import {StatefulProjectionControllerV2} from '../../src/indexer/projection/stateful-controller.js';
// @ts-ignore Component transport fixture; never a production database or Wire codec qualification.
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

const chainId = '1'.repeat(64), chain = 'stateful-finality-fixture';
const id = (value: number) => value.toString(16).padStart(64, '0');
const point = (height: number, identity = height): ProjectionCheckpoint => ({blockNum: height, blockId: id(identity)});
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const schemaJson = '{"version":"engineering-only"}';
const profile = {id: 'source-engineering', profileId: 'source-engineering-v1', components: [
    {id: 'fixture', runtime: 'node' as const, version: '0.0.0-dev.1', sourceRevision: 'b'.repeat(40), sha256: 'c'.repeat(64)}]};

/** Opaque constructed facts exercise the actual journal, coordinator and proof reader, not a Wire value codec. */
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
    async function append(height: number, irreversible = point(0), identity = height, parent = height - 1) {
        const source = {...point(height, identity), chainId, previousBlockId: height === 1 ? null : id(parent)};
        const capture = {kind: 'unattested-ship-result-sections-v1' as const, schemaJson, blockHex: '00',
            tracesHex: height === 1 ? null : '00', deltasHex: '00'};
        const captureSha256 = protocolAbiCaptureDigest(source, capture);
        const selectionId = (await bindings.prepareSelection({schemaVersion: 1, contextId, readerSessionId: 'reader', readerRole: 'live',
            assignmentId: null, source, captureSha256, frameSha256: sha(`frame-${height}-${identity}-${irreversible.blockId}`),
            head: irreversible.blockNum > height ? irreversible : point(height, identity), irreversible})).id;
        const record = {schemaVersion: 1 as const, protocol: profile, source: {...source, inputSha256: captureSha256}, capture,
            observation: height === 1 ? {status: 'native-genesis' as const, facts: nativeFacts}
                : {status: 'observed' as const, facts: {schemaVersion: 1 as const, actionInputs: [], deployments: [], finalStates: []}}};
        const receipt = await observations.prepare(record);
        await bindings.prepareObservationLink({schemaVersion: 1, selectionId, observationId: receipt.id, observationDigest: receipt.digest});
        const admission = await coordinator.admit(selectionId, generation); generation = admission.generation;
        expect(admission.status).toBe('accepted'); await coordinator.drain();
    }
    const source = () => new PortableProjectionSource({client: memory.client, chain, chainId, profile, provider, maxAncestryBlocks: maximumAncestry});
    return {append, source};
}

const unavailable = {statusCode: 503};

test('the target is the reported LIB proven on the canonical branch, never the head', async () => {
    const f = await fixture();
    await f.append(1); await f.append(2); await f.append(3, point(1)); await f.append(4, point(2));
    const source = f.source();
    expect(await source.head()).toEqual(point(4));
    expect(await source.irreversibleTarget()).toEqual(point(2));
});

test('nothing is eligible before the source reports a LIB', async () => {
    const f = await fixture();
    await f.append(1); await f.append(2);
    expect(await f.source().irreversibleTarget()).toEqual(point(0));
});

test('a LIB above covered replay is capped at the covered head', async () => {
    const f = await fixture();
    await f.append(1); await f.append(2, point(9));
    expect(await f.source().irreversibleTarget()).toEqual(point(2));
});

test('a reported LIB off the canonical branch is unavailable', async () => {
    const f = await fixture();
    await f.append(1); await f.append(2); await f.append(3, point(2, 99));
    await expect(f.source().irreversibleTarget()).rejects.toMatchObject(unavailable);
});

test('a LIB that regresses or changes identity is fenced for this source', async () => {
    const f = await fixture();
    await f.append(1); await f.append(2); await f.append(3, point(2));
    const source = f.source();
    expect(await source.irreversibleTarget()).toEqual(point(2));
    await f.append(4, point(1));
    await expect(source.irreversibleTarget()).rejects.toMatchObject(unavailable);
});

test('a slower older LIB read cannot lower the fence set by a newer one', async () => {
    const f = await fixture();
    await f.append(1); await f.append(2); await f.append(3, point(1)); await f.append(4, point(2));
    const source = f.source() as any, revalidate = source.revalidate.bind(source);
    // head() and the LIB proof revalidate first; the third call runs with the older LIB already read.
    let calls = 0, enter!: () => void, release!: () => void;
    const entered = new Promise<void>(yes => {enter = yes;}), held = new Promise<void>(yes => {release = yes;});
    source.revalidate = async (proof: unknown) => {
        if (++calls === 3) {enter(); await held;}
        return revalidate(proof);
    };
    const older = source.irreversibleTarget(); void older.catch(() => {});
    await entered;
    await f.append(5, point(3));
    expect(await source.irreversibleTarget()).toEqual(point(3));
    release();
    await expect(older).rejects.toMatchObject(unavailable);
    await f.append(6, point(3));
    expect(await source.irreversibleTarget()).toEqual(point(3));
});

test('a LIB outside bounded ancestry fails closed without historical certificates', async () => {
    const f = await fixture(2);
    await f.append(1); await f.append(2); await f.append(3); await f.append(4); await f.append(5, point(1));
    await expect(f.source().irreversibleTarget()).rejects.toMatchObject(unavailable);
});

const base = {interfaceVersion: 2, sourceInputVersion: 2, backend: {kind: 'mongodb', id: 'state', database: 'state'},
    recovery: {bytes: 1024 * 1024}, api: {timeoutMs: 1000, maximumPendingProbes: 8}};

test('reversible keeps its existing identity and irreversible owns a separate instance', () => {
    const omitted = resolveStatefulOwnerConfigurationV2(base)!, explicit = resolveStatefulOwnerConfigurationV2({...base, finality: 'reversible'})!;
    const irreversible = resolveStatefulOwnerConfigurationV2({...base, finality: 'irreversible'})!;
    expect(omitted.finality).toBe('reversible');
    expect(omitted.generation).toBe('initial');
    expect(explicit.configDigest).toBe(omitted.configDigest);
    // Computed by the code before this option existed. A change here disturbs every deployed instance.
    expect(omitted.configDigest).toBe('ee5b156223af3c280238d9127cddaf2f58c3a207756f503ce1ad7f8383566811');
    expect(irreversible.finality).toBe('irreversible');
    expect(irreversible.generation).not.toBe(omitted.generation);
    // No explicit reversible name can reach the irreversible namespace.
    const named = resolveStatefulOwnerConfigurationV2({...base, generation: irreversible.generation.replace(':', '.')})!;
    expect(named.generation).not.toBe(irreversible.generation);
    expect(() => resolveStatefulOwnerConfigurationV2({...base, generation: irreversible.generation})).toThrow();
    expect(irreversible.configDigest).not.toBe(omitted.configDigest);
    expect(() => resolveStatefulOwnerConfigurationV2({...base, finality: 'final'})).toThrow();
});

test('only the stateful route reports finality on served views', () => {
    const view = {checkpoint: point(4)};
    expect(stateResponseHeaders(view, 'irreversible')['hyperion-state-finality']).toBe('irreversible');
    expect(Object.hasOwn(stateResponseHeaders(view), 'hyperion-state-finality')).toBe(false);
});

const identity = {ownerId: 'owner'}, declarationDigest = 'd'.repeat(64);
function owner(finality: 'reversible' | 'irreversible', options: {checkpoint?: ProjectionCheckpoint; head?: ProjectionCheckpoint;
    target?: ProjectionCheckpoint; raw?: unknown; rollback?: unknown; orphaned?: boolean;
    select?: (admit: (target: unknown) => Promise<void>, state: {target: ProjectionCheckpoint}) => Promise<unknown>} = {}) {
    const calls = {head: 0, target: 0, frames: [] as number[], rollbacks: 0, failures: 0, revalidations: 0, errors: [] as unknown[]};
    const state = {target: options.target ?? point(5), checkpoint: options.checkpoint ?? point(5), head: options.head ?? point(9), orphaned: options.orphaned ?? false};
    const recovery = () => ({version: 2, view: {revision: 'r'.repeat(64), checkpoint: state.checkpoint}, owner: {identity},
        raw: options.raw ?? null, pending: null, gap: null, rollback: options.rollback ?? null});
    const adapter = {recovery: async () => recovery(), acquireOwner: async () => ({lease: true}),
        admitRaw: async () => {}, rollbackOwned: async () => {calls.rollbacks++;}, retainedCheckpoints: async () => ({recovery: recovery(), checkpoints: [point(4), point(3)]}),
        markRawFailure: async () => {calls.failures++;}, markSourceFailure: async () => {calls.failures++;}};
    const source = {head: async () => {calls.head++; return state.head;}, irreversibleTarget: async () => {calls.target++; return state.target;},
        open: async (value: ProjectionCheckpoint) => {
            if (state.orphaned && value.blockNum === state.checkpoint.blockNum && value.blockNum >= 5)
                throw new ProtocolAbiProofUnavailableError('source_not_canonical', 'Orphaned');
            return {source: value};
        },
        revalidate: async () => {calls.revalidations++;}, assertStatefulView: async () => {},
        statefulBlock: async (height: number, _declaration: unknown, admit: (target: unknown) => Promise<void>) => {
            calls.frames.push(height);
            if (options.select) return options.select(admit, state);
            throw new Error('Stop after selecting the frame');
        }};
    const controller = new StatefulProjectionControllerV2({declaration: {digest: declarationDigest,
        projection: {definition: {id: 'items', binding: {chainId}}, limits: {keyBytes: 256}}}, adapter, source, identity, custody: {},
        reduce: async () => {}, assertActive: () => {}, requireAttemptScope: false, run: (_metadata: unknown, work: () => Promise<boolean>) => work(),
        maximumFramesPerDrain: 1, finality, onError: (error: unknown) => {calls.errors.push(error);}} as any);
    const expected = () => ({declarationDigest, owner: {identity}, view: recovery().view}) as any;
    return {controller, calls, state, expected};
}

test('irreversible stops at the proven target while reversible follows the head', async () => {
    const irreversible = owner('irreversible');
    await irreversible.controller.drain();
    expect(irreversible.calls.frames).toEqual([]);
    expect(irreversible.calls.head).toBe(0);
    const reversible = owner('reversible');
    await reversible.controller.drain();
    expect(reversible.calls.frames).toEqual([6]);
    expect(reversible.calls.target).toBe(0);
});

test('irreversible applies the next block once it becomes eligible', async () => {
    const value = owner('irreversible', {target: point(6)});
    await value.controller.drain();
    expect(value.calls.frames).toEqual([6]);
});

test('an orphaned checkpoint never rolls back irreversible state, while reversible state recovers', async () => {
    const irreversible = owner('irreversible', {orphaned: true});
    await irreversible.controller.drain();
    expect(irreversible.calls.rollbacks).toBe(0);
    expect(irreversible.calls.frames).toEqual([]);
    expect(String(irreversible.calls.errors[0])).toContain('irreversible finality floor');
    const reversible = owner('reversible', {orphaned: true});
    await reversible.controller.drain();
    expect(reversible.calls.rollbacks).toBe(1);
});

test('a retained rollback is refused in irreversible mode and resumed in reversible mode', async () => {
    const rollback = {status: 'running', sourceRevision: 'r'.repeat(64), operationId: 'o', from: point(5), ancestor: point(4)};
    const irreversible = owner('irreversible', {rollback});
    await irreversible.controller.drain();
    expect(irreversible.calls.rollbacks).toBe(0);
    const reversible = owner('reversible', {rollback});
    await reversible.controller.drain();
    expect(reversible.calls.rollbacks).toBe(1);
});

test('durable raw input above an older reported LIB waits without failing and is not served', async () => {
    const block = {blockNum: 6, blockId: id(6), previousBlockId: id(5)};
    const value = owner('irreversible', {raw: {target: {digest: 'a'.repeat(64), target: {block}}}});
    await value.controller.drain();
    expect(value.calls.failures).toBe(0);
    expect(value.calls.frames).toEqual([]);
    expect(value.calls.errors).toEqual([]);
    await expect(value.controller.attest(value.expected())).rejects.toThrow();
});

test('a selected block is rechecked against finality before anything irreversible happens', async () => {
    const block = {blockNum: 6, blockId: id(60), previousBlockId: id(5)}, rawSource = {commitId: 'c'};
    const value = owner('irreversible', {target: point(6), raw: {target: {digest: 'a'.repeat(64), target: {block, rawSource}}},
        select: async (admit, state) => {
            await admit({block, reference: rawSource});
            state.target = point(5); // The replacement branch reports an older LIB, so block 6 is not final there.
            return {source: {digest: 'b'.repeat(64), source: {}}, proof: {}};
        }});
    await value.controller.drain();
    expect(value.calls.frames).toEqual([6]);
    expect(value.calls.target).toBe(2);
    expect(value.calls.revalidations).toBe(0);
    expect(value.calls.failures).toBe(0);
    expect(value.calls.errors).toEqual([]);
    await expect(value.controller.attest(value.expected())).rejects.toThrow();
});

test('a served view must stay within the eligible target', async () => {
    const value = owner('irreversible');
    await value.controller.drain();
    await value.controller.attest(value.expected());
    value.state.target = point(4);
    await expect(value.controller.attest(value.expected())).rejects.toThrow('eligible finality target');
    const reversible = owner('reversible', {head: point(5)});
    await reversible.controller.drain();
    await reversible.controller.attest(reversible.expected());
    expect(reversible.calls.target).toBe(0);
});
