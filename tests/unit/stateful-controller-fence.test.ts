import {expect, test} from 'bun:test';
import {ProofConsumerFencedError, ProofConsumerScope} from '../../src/indexer/protocol/proof-consumer-scope.js';
import {StatefulProjectionControllerV2} from '../../src/indexer/projection/stateful-controller.js';

const id = (value: number) => value.toString(16).padStart(64, '0');
const point = (height: number) => ({blockNum: height, blockId: id(height)});
const block = {...point(6), previousBlockId: id(5)};
const rawSource = {commitId: 'c', selectionId: 's', observationId: 'o', observationDigest: 'd'.repeat(64)};
const raw = {target: {digest: 'a'.repeat(64), target: {block, rawSource}}, sourceDigest: null};
const identity = {ownerId: 'owner'};
const gate = () => {let release!: () => void; const promise = new Promise<void>(yes => {release = yes;}); return {promise, release};};

type Boundary = 'recovery' | 'mark';
type Primary = 'ordinary' | 'foreign';
type Completion = 'success' | 'owned' | 'ordinary' | 'foreign';

/** The actual owner step and scope. Only storage and source are controlled, and they fail at a chosen point. */
function fixture(boundary: Boundary, primaryKind: Primary, completion: Completion, active: boolean) {
    const scope = new ProofConsumerScope('stateful-fallback-' + boundary);
    const held = gate(), release = gate(), effects: string[] = [], errors: unknown[] = [];
    const primary = primaryKind === 'ordinary' ? new Error('Original source failure') : new ProofConsumerFencedError();
    let failed = false, holding = false;
    const settle = async () => {
        holding = true; held.release(); await release.promise;
        if (completion === 'owned') throw scope.signal.reason;
        if (completion === 'ordinary') throw new Error('Original fallback callback failure');
        if (completion === 'foreign') throw new ProofConsumerFencedError();
    };
    const view = () => ({revision: 'r'.repeat(64), checkpoint: point(5)});
    const adapter = {
        async recovery() {
            effects.push('recovery');
            if (boundary === 'recovery' && failed && !holding) await settle();
            return {version: 2, view: view(), owner: {identity}, raw, pending: null, gap: null, rollback: null};
        },
        acquireOwner: async () => ({lease: true}),
        admitRaw: async () => {effects.push('admitRaw');},
        rollbackOwned: async () => {effects.push('rollback');},
        markRawFailure: async () => {effects.push('markRawFailure'); if (boundary === 'mark' && !holding) await settle();},
        markSourceFailure: async () => {effects.push('markSourceFailure');},
    };
    const source = {head: async () => point(9), irreversibleTarget: async () => point(9), open: async (value: unknown) => ({source: value}),
        revalidate: async () => {}, assertStatefulView: async () => {},
        async statefulBlock(_height: number, _declaration: unknown, admit: (target: unknown) => Promise<void>) {
            await admit({block, reference: rawSource});
            failed = true; throw primary;
        }};
    const controller = new StatefulProjectionControllerV2({declaration: {digest: 'd'.repeat(64),
        projection: {definition: {id: 'items', binding: {chainId: '1'.repeat(64)}}, limits: {keyBytes: 256}}}, adapter, source, identity, custody: {},
        reduce: async () => {}, assertActive: () => {}, requireAttemptScope: true, maximumFramesPerDrain: 1,
        run: (_metadata: unknown, work: () => Promise<boolean>) => work(), onError: (error: unknown) => {errors.push(error);}} as any);
    const run = async () => {
        const work = scope.run(() => controller.drain());
        void work.catch(() => {});
        await held.promise;
        if (!active) scope.fence();
        const atFence = effects.length;
        release.release();
        let error: unknown;
        try {await work;} catch (value) {error = value;}
        return {error, later: effects.slice(atFence)};
    };
    return {run, primary, effects, errors};
}

const completions: Completion[] = ['success', 'owned', 'ordinary', 'foreign'];
for (const boundary of ['recovery', 'mark'] as const) for (const primaryKind of ['ordinary', 'foreign'] as const) for (const completion of completions)
    test(`a fence during ${boundary} preserves the ${primaryKind} primary failure when the fallback ends ${completion}`, async () => {
        const value = fixture(boundary, primaryKind, completion, false);
        const {error, later} = await value.run();
        expect(error).toBe(value.primary);
        expect(later).toEqual([]);
        expect(value.errors).toEqual([]);
    });

for (const boundary of ['recovery', 'mark'] as const) for (const completion of ['success', 'ordinary'] as const)
    test(`an active ${boundary} fallback that ends ${completion} reports the primary failure without throwing`, async () => {
        const value = fixture(boundary, 'ordinary', completion, true);
        const {error} = await value.run();
        expect(error).toBeUndefined();
        expect(value.errors).toEqual([value.primary]);
    });
