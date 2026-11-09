import {expect, test} from 'bun:test';
import type {ProjectionCheckpoint} from '@eosrio/hyperion-sdk/projection';
import {resolveStatefulOwnerConfigurationV2} from '../../src/indexer/projection/stateful-config.js';
import {StatefulProjectionControllerV2} from '../../src/indexer/projection/stateful-controller.js';

const chainId = '1'.repeat(64);
const id = (value: number) => value.toString(16).padStart(64, '0');
const point = (height: number): ProjectionCheckpoint => ({blockNum: height, blockId: id(height)});
const base = {interfaceVersion: 2, sourceInputVersion: 2, backend: {kind: 'mongodb', id: 'state', database: 'state'},
    recovery: {bytes: 1024 * 1024}, api: {timeoutMs: 1000, maximumPendingProbes: 8}};

test('the serving lag bound is validated and stays out of the instance identity', () => {
    const omitted = resolveStatefulOwnerConfigurationV2(base)!, bounded = resolveStatefulOwnerConfigurationV2({...base, maximumServingLagBlocks: 120})!;
    expect(omitted.maximumServingLagBlocks).toBeUndefined();
    expect(Object.hasOwn(omitted, 'maximumServingLagBlocks')).toBe(false);
    expect(bounded.maximumServingLagBlocks).toBe(120);
    // Same golden as stateful-finality.test.ts: a serving policy must not disturb deployed instances.
    expect(omitted.configDigest).toBe('ee5b156223af3c280238d9127cddaf2f58c3a207756f503ce1ad7f8383566811');
    expect(bounded.configDigest).toBe(omitted.configDigest);
    expect(bounded.generation).toBe(omitted.generation);
    const irreversible = resolveStatefulOwnerConfigurationV2({...base, finality: 'irreversible'})!;
    expect(resolveStatefulOwnerConfigurationV2({...base, finality: 'irreversible', maximumServingLagBlocks: 3})!.configDigest).toBe(irreversible.configDigest);
    for (const invalid of [0, -1, 1.5, '120', 100_000_001]) expect(() => resolveStatefulOwnerConfigurationV2({...base, maximumServingLagBlocks: invalid})).toThrow();
});

const identity = {ownerId: 'owner'}, declarationDigest = 'd'.repeat(64);
function owner(finality: 'reversible' | 'irreversible', maximumServingLagBlocks?: number) {
    const calls = {head: 0, target: 0};
    const state = {checkpoint: point(5), head: point(9), target: point(5)};
    const recovery = () => ({version: 2, view: {revision: 'r'.repeat(64), checkpoint: state.checkpoint}, owner: {identity},
        raw: null, pending: null, gap: null, rollback: null});
    const adapter = {recovery: async () => recovery(), acquireOwner: async () => ({lease: true})};
    const source = {head: async () => {calls.head++; return state.head;}, irreversibleTarget: async () => {calls.target++; return state.target;},
        open: async (value: ProjectionCheckpoint) => ({source: value}), revalidate: async () => {}, assertStatefulView: async () => {},
        statefulBlock: async () => {throw new Error('No frame is selected in this fixture');}};
    const controller = new StatefulProjectionControllerV2({declaration: {digest: declarationDigest,
        projection: {definition: {id: 'items', binding: {chainId}}, limits: {keyBytes: 256}}}, adapter, source, identity, custody: {},
        reduce: async () => {}, assertActive: () => {}, requireAttemptScope: false, run: (_metadata: unknown, work: () => Promise<boolean>) => work(),
        maximumFramesPerDrain: 1, finality, ...(maximumServingLagBlocks === undefined ? {} : {maximumServingLagBlocks}),
        onError: () => {}} as any);
    const expected = () => ({declarationDigest, owner: {identity}, view: recovery().view}) as any;
    return {controller, calls, state, expected};
}

test('a reversible view trailing the head beyond the bound refuses, and only then is the head read', async () => {
    const unbounded = owner('reversible');
    unbounded.state.head = point(5); await unbounded.controller.drain();
    unbounded.state.head = point(500);
    const reads = unbounded.calls.head;
    await unbounded.controller.attest(unbounded.expected());
    expect(unbounded.calls.head).toBe(reads);

    const value = owner('reversible', 4);
    value.state.head = point(5); await value.controller.drain();
    value.state.head = point(9);
    await value.controller.attest(value.expected());
    value.state.head = point(10);
    await expect(value.controller.attest(value.expected())).rejects.toThrow('serving lag bound');
    expect(value.calls.target).toBe(0);
});

test('an irreversible view is bounded against its eligible target with the same single read', async () => {
    const value = owner('irreversible', 2);
    await value.controller.drain();
    await value.controller.attest(value.expected());
    const reads = value.calls.target;
    value.state.target = point(7);
    await value.controller.attest(value.expected());
    expect(value.calls.target).toBe(reads + 1);
    value.state.target = point(8);
    await expect(value.controller.attest(value.expected())).rejects.toThrow('serving lag bound');
    value.state.target = point(4);
    await expect(value.controller.attest(value.expected())).rejects.toThrow('eligible finality target');
    expect(value.calls.head).toBe(0);
});

test('an invalid serving lag bound is refused before the owner runs', () => {
    expect(() => owner('reversible', 0)).toThrow('serving lag bound');
    expect(() => owner('reversible', 1.5)).toThrow('serving lag bound');
});
