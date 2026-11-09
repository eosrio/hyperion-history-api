import {expect, test} from 'bun:test';
import {captureStatefulDeclaration} from '@eosrio/hyperion-sdk/projection-stateful';
import {negotiateStatefulOwnerV2, STATEFUL_OWNER_FAMILY_V2, STATEFUL_OWNER_HOST_CAPABILITIES_V2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {captureStatefulSourceV2} from '@eosrio/hyperion-sdk/projection-stateful-source-v2';
import {ProtocolAbiProofUnavailableError} from '../../src/indexer/protocol/abi-proof.js';
import {StatefulProjectionControllerV2} from '../../src/indexer/projection/stateful-controller.js';
import {createStatefulCandidateCustodyV2, type StatefulCandidateCustodyV2} from '../../src/indexer/projection/stateful-custody.js';
// @ts-ignore Native commands use the existing storage transport fixture, not a physical service.
import {configured} from '../../packages/backend-mongodb/tests/stateful-owner-v2-fixture.mjs';
// @ts-ignore Shared native adapter declaration fixture; no physical database is opened.
import {definition, limits, hex} from '../../packages/backend-mongodb/tests/stateful-fixture.mjs';
// @ts-ignore This shared transport fixture is deliberately not a database or production authority.
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

const chain = 'candidate-retention', index = chain + '-stateful-candidates-v2';
const zero = {blockNum: 0, blockId: '0'.repeat(64)};

/** The shared ES fixture plus range deletes and refresh visibility, so a purge that skips its refresh misses fresh writes. */
function retentionClient() {
    // Floor prunes start at the declaration prefix; a rollback purge starts above a height.
    const memory = frontierMemoryClient(), deleted = new Set<string>(), purged = new Set<string>();
    let visible = new Set<string>(), refreshes = 0;
    const state = {autoRefresh: true, deletes: 0};
    memory.client.indices.refresh = async (request: {index: string}) => {
        refreshes++; visible = new Set([...memory.documents.keys()].filter(key => key.startsWith(request.index + '\0')));
        return {_shards: {total: 1, successful: 1, failed: 0}};
    };
    memory.client.deleteByQuery = async (request: any) => {
        state.deletes++;
        const {gte, lt} = request.query.range.bundle_id;
        expect(request.conflicts).toBe('proceed'); expect(request.wait_for_completion).toBe(true);
        let count = 0;
        for (const [key, entry] of [...memory.documents]) {
            if (!key.startsWith(request.index + '\0') || count >= request.max_docs) continue;
            if (!state.autoRefresh && !visible.has(key)) continue;
            const id = entry.document.bundle_id;
            if (id >= gte && id < lt) {
                memory.documents.delete(key); count++;
                if (entry.document.kind === 'manifest') (/:$/.test(gte) ? deleted : purged).add(id);
            }
        }
        return {took: 1, timed_out: false, total: count, deleted: count, version_conflicts: 0, failures: []};
    };
    const manifests = () => [...memory.documents].filter(([key, entry]) => key.startsWith(index + '\0') && entry.document.kind === 'manifest')
        .map(([, entry]) => entry.document.bundle_id as string);
    const blocks = (declaration?: string) => manifests().filter(id => id.startsWith('h45statecustody2:')
        && (declaration === undefined || id.split(':')[1] === declaration)).map(id => Number(id.split(':')[2])).sort((a, b) => a - b);
    return {memory, deleted, purged, state, manifests, blocks, get refreshes() {return refreshes;}};
}

async function owner() {
    const native = await configured(), projection = await captureStatefulDeclaration(definition(), limits());
    const declaration = await negotiateStatefulOwnerV2(projection, {family: STATEFUL_OWNER_FAMILY_V2, interfaceVersion: 2,
        sourceInputVersions: [2], supported: STATEFUL_OWNER_HOST_CAPABILITIES_V2, limits: projection.limits}, native.adapter.capabilities);
    return {native, declaration};
}

/** A scripted canonical chain. Branch labels make block IDs, so a fork replaces every block above its ancestor. */
function chainSource(declaration: any) {
    const ids = new Map<number, string>(), state = {tip: 0, lib: 0};
    const blockId = (height: number, branch: string) => hex(height * 1000 + branch.charCodeAt(0));
    const extend = (through: number, branch = 'a', from = state.tip + 1) => {
        for (let height = from; height <= through; height++) ids.set(height, blockId(height, branch));
        for (const height of [...ids.keys()]) if (height > through) ids.delete(height);
        state.tip = through;
    };
    const point = (height: number) => height === 0 ? zero : {blockNum: height, blockId: ids.get(height)!};
    const source = {
        head: async () => point(state.tip),
        irreversibleTarget: async () => point(Math.min(state.lib, state.tip)),
        open: async (checkpoint: {blockNum: number; blockId: string}) => {
            if (checkpoint.blockNum > 0 && ids.get(checkpoint.blockNum) !== checkpoint.blockId)
                throw new ProtocolAbiProofUnavailableError('source_not_canonical', 'Checkpoint is on an orphaned branch');
            return {checkpoint};
        },
        revalidate: async () => {}, assertStatefulView: async () => {},
        statefulBlock: async (height: number, _declaration: unknown, admit: (target: any) => Promise<void>) => {
            const previous = point(height - 1), block = {blockNum: height, blockId: ids.get(height)!, previousBlockId: previous.blockId};
            await admit({block, reference: {commitId: 'commit:' + block.blockId, selectionId: 'selection:' + block.blockId,
                observationId: 'observation:' + block.blockId, observationDigest: block.blockId}});
            const captured = await captureStatefulSourceV2(declaration, {previous, block: {...block, timeMs: String(1000 + height)}, inputs: []});
            return {source: captured, proof: {height}};
        },
    };
    return {source, state, extend, blockId, point};
}

interface Harness {
    controller: StatefulProjectionControllerV2; errors: unknown[]; retentionErrors: unknown[]; reductions: number[];
    loads: {blockNum: number; sourceDigest: string; found: boolean}[];
}
function controllerFor(o: Awaited<ReturnType<typeof owner>>, chainState: ReturnType<typeof chainSource>, custody: any,
    options: {generation?: string; finality?: 'reversible' | 'irreversible'; interval?: number; adapter?: any; retention?: ReturnType<typeof retentionClient>} = {}): Harness {
    const harness: Harness = {errors: [], retentionErrors: [], reductions: [], loads: []} as any;
    let observed = custody;
    if (typeof custody.block === 'function') {
        const block = custody.block.bind(custody);
        observed = {...custody, block: (blockNum: number, pending: string | null) => {
            const view = block(blockNum, pending);
            return {retain: view.retain, load: async (digest: string, sourceDigest: string) => {
                // A pruned candidate is never requested: no later read names an ID a retention delete removed.
                const id = `h45statecustody2:${digest}:${String(blockNum).padStart(16, '0')}:${sourceDigest}`;
                expect(options.retention?.deleted.has(id) ?? false).toBe(false);
                const value = await view.load(digest, sourceDigest);
                harness.loads.push({blockNum, sourceDigest, found: value !== null}); return value;
            }};
        }};
    }
    harness.controller = new StatefulProjectionControllerV2({declaration: o.declaration, adapter: options.adapter ?? o.native.adapter,
        source: chainState.source as any, identity: {id: 'retention-owner', generation: options.generation ?? 'one'}, custody: observed,
        reduce: async reduction => {
            harness.reductions.push(reduction.source.block.blockNum);
            reduction.put('collection', 'last', {height: reduction.source.block.blockNum, block: reduction.source.block.blockId});
        },
        assertActive: () => {}, requireAttemptScope: false, run: (_metadata, operation) => operation(), maximumFramesPerDrain: 1,
        finality: options.finality, candidatePruneIntervalBlocks: options.interval ?? 1,
        onError: error => {harness.errors.push(error);}, onRetentionError: error => {harness.retentionErrors.push(error);}});
    return harness;
}
async function drainTo(h: Harness, adapter: any, height: number, blockId?: string, budget = 200) {
    for (let n = 0; n < budget; n++) {
        const recovery = await adapter.recovery();
        if (recovery?.view.checkpoint.blockNum === height && (!blockId || recovery.view.checkpoint.blockId === blockId)
            && recovery.raw === null && recovery.pending === null) return recovery;
        await h.controller.drain();
    }
    throw new Error('Owner did not reach ' + height + ': ' + h.errors.map(String).join('; '));
}

test('custody deletes only whole block-addressed candidates of its own declaration inside the requested range', async () => {
    const r = retentionClient(), o = await owner(), chainState = chainSource(o.declaration);
    const custody = createStatefulCandidateCustodyV2(r.memory.client, chain, 0, o.declaration);
    chainState.extend(6);
    const h = controllerFor(o, chainState, custody, {interval: 1_000_000});
    await drainTo(h, o.native.adapter, 6);
    expect(r.blocks()).toEqual([1, 2, 3, 4, 5, 6]);
    // A plain, source-addressed candidate and another declaration's range stay outside every retention range.
    const stored = await custody.block(3, null).load(o.declaration.digest, (await chainState.source.statefulBlock(3, null, async () => {})).source.digest);
    expect(stored).not.toBeNull();
    await custody.retain(stored!);
    const other = 'e'.repeat(64);
    r.memory.documents.set(r.memory.key(index, `h45statecustody2:${other}:0000000000000001:${'f'.repeat(64)}`),
        {document: {kind: 'manifest', bundle_id: `h45statecustody2:${other}:0000000000000001:${'f'.repeat(64)}`}, seq: 0, primaryTerm: 1});
    expect(await custody.pruneBelow(4)).toEqual({deleted: 6, complete: true});
    expect(r.blocks(o.declaration.digest)).toEqual([4, 5, 6]);
    expect(r.manifests().filter(id => id.startsWith('h45statecandidate2:'))).toHaveLength(1);
    expect(r.manifests().filter(id => id.includes(other))).toHaveLength(1);
    await custody.purgeAbove(5);
    expect(r.blocks(o.declaration.digest)).toEqual([4, 5]);
    // The plain store keeps loading the original layout; the block view falls back to it only for a pending source.
    expect((await custody.load(o.declaration.digest, stored!.source.digest))?.digest).toBe(stored!.digest);
    expect(await custody.block(3, null).load(o.declaration.digest, stored!.source.digest)).toBeNull();
    expect((await custody.block(3, stored!.source.digest).load(o.declaration.digest, stored!.source.digest))?.digest).toBe(stored!.digest);
    await expect(custody.block(4, null).retain(stored!)).rejects.toThrow('Candidate custody block differs');
    expect(await custody.pruneBelow(0)).toEqual({deleted: 0, complete: true});
    expect(h.errors).toEqual([]);
});

test('the bundle store refuses retention ranges outside one declaration of block-addressed candidates', async () => {
    const {ImmutableProtocolBundleStore} = await import('../../src/indexer/protocol/immutable-bundle-store.js');
    const r = retentionClient();
    const store = new ImmutableProtocolBundleStore(r.memory.client as any, chain, 0, 'stateful-candidate-v2', 'stateful-candidates-v2');
    const a = `h45statecustody2:${'a'.repeat(64)}:`, b = `h45statecustody2:${'b'.repeat(64)}:`;
    const bounds = {refresh: false, maximumDocuments: 10};
    for (const [gte, lt] of [[a, b + '~'], [a + '0000000000000005', a + '0000000000000004'], [a + '~', a + '~'],
        ['h45statecandidate2:' + 'a'.repeat(64) + ':', a + '~'], [a + '5', a + '~'], [a, a + '0000000000000001x']]) {
        await expect(store.deleteCandidateRange(gte!, lt!, bounds)).rejects.toThrow('Invalid candidate custody retention range');
    }
    await expect(store.deleteCandidateRange(a, a + '~', {refresh: false, maximumDocuments: 0})).rejects.toThrow('Invalid candidate custody retention range');
    const other = new ImmutableProtocolBundleStore(r.memory.client as any, chain, 0, 'protocol-abi-observation', 'protocol-observations');
    await expect(other.deleteCandidateRange(a, a + '~', bounds)).rejects.toThrow('Invalid candidate custody retention range');
    r.memory.client.deleteByQuery = async () => ({timed_out: false, deleted: 1, version_conflicts: 0, failures: [{cause: 'shard'}]});
    await expect(store.deleteCandidateRange(a, a + '~', bounds)).rejects.toThrow('Incomplete candidate custody retention receipt');
});

test('steady progress keeps a bounded candidate window, and a restart clears what an earlier owner left', async () => {
    const r = retentionClient(), o = await owner(), chainState = chainSource(o.declaration);
    const custody = createStatefulCandidateCustodyV2(r.memory.client, chain, 0, o.declaration);
    chainState.extend(30);
    // The first owner never reaches its interval, as after a crash before any prune.
    const first = controllerFor(o, chainState, custody, {interval: 1_000_000, retention: r});
    await drainTo(first, o.native.adapter, 20);
    expect(r.blocks()).toHaveLength(20);
    await first.controller.stop();
    const restarted = controllerFor(o, chainState, custody, {generation: 'two', retention: r});
    for (let height = 21; height <= 30; height++) {
        const recovery = await drainTo(restarted, o.native.adapter, height);
        // Rollback retention is 8 blocks: the floor is the oldest retained undo ancestor.
        expect(recovery.coverage.floor.blockNum).toBe(height - 8);
        expect(r.blocks()).toEqual(Array.from({length: 9}, (_, n) => height - 8 + n));
    }
    expect(restarted.errors).toEqual([]); expect(restarted.retentionErrors).toEqual([]);
    expect(r.deleted.size).toBe(21);
    // Every candidate read was for the new block at its first reduction, never a pruned one.
    expect(restarted.loads.every(load => !load.found)).toBe(true);
    expect(restarted.reductions).toEqual(Array.from({length: 10}, (_, n) => 21 + n));
});

test('pending and unknown applies recover from their original candidate, including after a cold takeover', async () => {
    const r = retentionClient(), o = await owner(), chainState = chainSource(o.declaration);
    const custody = createStatefulCandidateCustodyV2(r.memory.client, chain, 0, o.declaration);
    chainState.extend(40);
    const first = controllerFor(o, chainState, custody, {retention: r});
    await drainTo(first, o.native.adapter, 20);
    // Pending: the durable intent is written, then the commit outcome is lost before it commits.
    o.native.fixture.failTransaction = 'before';
    await first.controller.drain();
    let recovery = await o.native.adapter.recovery();
    expect(recovery.view.checkpoint.blockNum).toBe(20);
    expect(recovery.pending).not.toBeNull();
    expect(r.blocks()).toContain(21);
    await first.controller.stop();
    // A cold takeover with a fresh custody object finds the original candidate durably and never reduces again.
    const takeover = controllerFor(o, chainState, createStatefulCandidateCustodyV2(r.memory.client, chain, 0, o.declaration),
        {generation: 'two', retention: r});
    await drainTo(takeover, o.native.adapter, 21);
    expect(takeover.reductions).toEqual([]);
    expect(takeover.loads[0]).toMatchObject({blockNum: 21, sourceDigest: recovery.pending!.sourceDigest, found: true});
    // Unknown: the commit happened but its acknowledgement is lost.
    o.native.fixture.failTransaction = 'after';
    await takeover.controller.drain();
    recovery = await o.native.adapter.recovery();
    expect(recovery.view.checkpoint.blockNum).toBe(22); expect(recovery.raw).not.toBeNull();
    const before = takeover.loads.length;
    await drainTo(takeover, o.native.adapter, 22);
    // The committed receipt answers the retry, so custody is not read at all.
    expect(takeover.loads.length).toBe(before);
    // Exact retry: the candidate is kept, then apply fails before any durable intent.
    let refuse = true;
    const adapter = new Proxy(o.native.adapter, {get(target, key) {
        if (key === 'applyOwned') return async (...args: any[]) => {
            if (refuse) {refuse = false; throw new Error('constructed apply interruption before intent');}
            return target.applyOwned(...args);
        };
        const member = Reflect.get(target, key); return typeof member === 'function' ? member.bind(target) : member;
    }});
    const retry = controllerFor(o, chainState, custody, {generation: 'three', adapter, retention: r});
    await drainTo(retry, o.native.adapter, 23);
    expect(retry.reductions).toEqual([23]);
    expect(retry.loads.filter(load => load.blockNum === 23).map(load => load.found)).toEqual([false, true]);
    await drainTo(retry, o.native.adapter, 40);
    expect(r.blocks()).toEqual(Array.from({length: 9}, (_, n) => 32 + n));
});

test('a fork rollback inside the window works, and a switch back to the first branch reduces its blocks again', async () => {
    const run = async (bounded: boolean) => {
        const r = retentionClient(), o = await owner(), chainState = chainSource(o.declaration);
        const created = createStatefulCandidateCustodyV2(r.memory.client, chain, 0, o.declaration);
        const custody = bounded ? created : {load: created.load, retain: created.retain};
        chainState.extend(14);
        const h = controllerFor(o, chainState, custody, {retention: r});
        await drainTo(h, o.native.adapter, 14);
        // Replace 11..16 with branch b; the ancestor 10 is inside the 8-block undo window.
        chainState.extend(16, 'b', 11);
        r.state.autoRefresh = false; // Candidates written moments ago are visible only after a refresh.
        await drainTo(h, o.native.adapter, 16, chainState.blockId(16, 'b'));
        // Switch back to branch a: 11..14 return with their original source digests.
        chainState.extend(18, 'a', 11);
        return {h, r, o, chainState, recovery: await drainTo(h, o.native.adapter, 18, chainState.blockId(18, 'a'), 60).catch(error => error)};
    };
    const bounded = await run(true);
    expect(bounded.recovery).not.toBeInstanceOf(Error);
    expect(bounded.h.errors).toEqual([]);
    expect(bounded.r.refreshes).toBeGreaterThan(0);
    expect(bounded.h.reductions).toEqual([...Array.from({length: 14}, (_, n) => n + 1), 11, 12, 13, 14, 15, 16,
        11, 12, 13, 14, 15, 16, 17, 18]);
    const state = await bounded.o.native.adapter.recovery();
    expect(state.view.checkpoint).toEqual(bounded.chainState.point(18));
    expect(bounded.r.blocks()).toEqual(Array.from({length: 9}, (_, n) => 10 + n));
    // Without purge, the first branch's old candidate names the pre-rollback revision and the owner stalls.
    const plain = await run(false);
    expect(plain.recovery).toBeInstanceOf(Error);
    expect(plain.h.errors.some(error => String(error).includes('Revision or checkpoint changed'))).toBe(true);
});

test('irreversible owners prune below the applied finality floor only', async () => {
    const r = retentionClient(), o = await owner(), chainState = chainSource(o.declaration);
    const custody = createStatefulCandidateCustodyV2(r.memory.client, chain, 0, o.declaration);
    chainState.extend(30); chainState.state.lib = 12;
    const h = controllerFor(o, chainState, custody, {finality: 'irreversible', retention: r});
    await drainTo(h, o.native.adapter, 12);
    for (let n = 0; n < 4; n++) await h.controller.drain();
    expect((await o.native.adapter.recovery()).view.checkpoint.blockNum).toBe(12);
    expect(r.blocks()).toEqual([12]);
    chainState.state.lib = 20;
    await drainTo(h, o.native.adapter, 20);
    expect(r.blocks()).toEqual([20]);
    expect(h.errors).toEqual([]); expect(h.retentionErrors).toEqual([]);
});

test('pruning failures are deferred, never fail a frame, and plain custody keeps every candidate', async () => {
    const r = retentionClient(), o = await owner(), chainState = chainSource(o.declaration);
    const custody = createStatefulCandidateCustodyV2(r.memory.client, chain, 0, o.declaration);
    chainState.extend(16);
    const original = r.memory.client.deleteByQuery;
    r.memory.client.deleteByQuery = async () => {throw new Error('constructed delete outage');};
    const h = controllerFor(o, chainState, custody, {retention: r});
    await drainTo(h, o.native.adapter, 12);
    expect(h.errors).toEqual([]);
    expect(h.retentionErrors.length).toBeGreaterThan(0);
    expect(r.blocks()).toHaveLength(12);
    r.memory.client.deleteByQuery = original;
    await drainTo(h, o.native.adapter, 13);
    expect(r.blocks()).toEqual(Array.from({length: 9}, (_, n) => 5 + n));
    const plain = retentionClient(), other = await owner(), otherChain = chainSource(other.declaration);
    const created = createStatefulCandidateCustodyV2(plain.memory.client, chain, 0, other.declaration);
    otherChain.extend(16);
    const legacy = controllerFor(other, otherChain, {load: created.load, retain: created.retain});
    await drainTo(legacy, other.native.adapter, 16);
    expect(plain.state.deletes).toBe(0);
    expect(plain.manifests().filter(id => id.startsWith('h45statecandidate2:'))).toHaveLength(16);
});

// Type-level: the created custody is the bounded form the owner prunes.
const _bounded: (client: any) => StatefulCandidateCustodyV2 = client => createStatefulCandidateCustodyV2(client, chain, 0, {} as any);
void _bounded;
