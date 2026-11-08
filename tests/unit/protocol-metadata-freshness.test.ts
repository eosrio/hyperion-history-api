import {afterEach, describe, expect, it} from 'bun:test';
import {ProtocolActionConsumer} from '../../src/api/helpers/protocol-abi.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ImmutableProtocolBundleStore, ProtocolMetadataFreshness, protocolMetadataReadBoundMs as bound} from '../../src/indexer/protocol/immutable-bundle-store.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

const original = Object.getOwnPropertyDescriptor(performance, 'now')!;
let now = 0;
const freeze = () => {now = 1000; Object.defineProperty(performance, 'now', {configurable: true, value: () => now});};
afterEach(() => {Object.defineProperty(performance, 'now', original);});

const checks = (memory: any) => memory.calls.filter((call: any) => call.method === 'getIndex').length;
function bundle(options: any = {}) {
    const memory = frontierMemoryClient();
    return {memory, store: new ImmutableProtocolBundleStore(memory.client as any, 'fixture', 0, 'freshness', 'freshness-v1', undefined,
        {metadataReadBoundMs: bound, ...options})};
}
function frontier(options: any = {}) {
    const memory = frontierMemoryClient();
    return {memory, store: new ProtocolAbiFrontierStore(memory.client as any, 'fixture', 0, {metadataReadBoundMs: bound, ...options})};
}
const unsafe: [string, (memory: any, index: string) => void][] = [
    ['foreign ownership', (memory, index) => {memory.mappings.get(index)._meta.hyperion_kind = 'foreign';}],
    ['excluded source', (memory, index) => {memory.mappings.get(index)._source = {excludes: ['payload']};}],
    ['a default pipeline', (memory, index) => {memory.settings.get(index)['index.default_pipeline'] = 'prune';}],
    ['async durability', (memory, index) => {memory.settings.get(index)['index.translog.durability'] = 'async';}],
    ['a replica change', (memory, index) => {memory.settings.get(index)['index.number_of_replicas'] = '1';}]
];

describe('protocol index metadata freshness', () => {
    for (const [name, mutate] of unsafe) {
        it('refuses the very next write after ' + name, async () => {
            freeze();
            const {memory, store} = bundle();
            await store.prepare('first', {value: 1}); await store.read('first');
            mutate(memory, store.index);
            await expect(store.prepare('second', {value: 2})).rejects.toThrow();
        });
        it('refuses a read at the bound after ' + name + ', and not before', async () => {
            freeze();
            const {memory, store} = bundle();
            await store.prepare('first', {value: 1});
            mutate(memory, store.index);
            now += bound - 1;
            expect(await store.read('first')).toEqual({value: 1});
            now += 1;
            await expect(store.read('first')).rejects.toThrow();
        });
    }

    it('refuses control writes at once and control reads at the bound', async () => {
        freeze();
        const {memory, store} = frontier();
        const first = await store.compareAndSet(null, {revision: 1});
        memory.settings.get(store.controlIndex)['index.translog.durability'] = 'async';
        expect((await store.readControl())?.value).toEqual({revision: 1});
        await expect(store.compareAndSet(first, {revision: 2})).rejects.toThrow('durability');
        const reader = frontier();
        await reader.store.compareAndSet(null, {revision: 1});
        reader.memory.settings.get(reader.store.controlIndex)['index.translog.durability'] = 'async';
        now += bound;
        await expect(reader.store.readControl()).rejects.toThrow('durability');
    });

    it('keeps refusing frontier records under a lifecycle policy, on writes and at the read bound', async () => {
        freeze();
        const {memory, store} = frontier();
        const prepared = await store.prepareCommit({blockNum: 1});
        memory.settings.get(store.recordsIndex)['index.lifecycle.name'] = 'prune';
        await expect(store.prepareCommit({blockNum: 2})).rejects.toThrow();
        now += bound;
        await expect(store.readCommit(prepared.id)).rejects.toThrow();
    });

    it('does not apply the lifecycle rule to stores that never asked for it', async () => {
        freeze();
        const {memory, store} = bundle();
        await store.prepare('first', {value: 1});
        memory.settings.get(store.index)['index.lifecycle.name'] = 'prune';
        await store.prepare('second', {value: 2});
    });

    it('checks once per write and shares one check across reads inside the bound', async () => {
        freeze();
        const {memory, store} = frontier();
        const prepared = await store.prepareCommit({blockNum: 1});
        expect(checks(memory)).toBe(1);
        await store.prepareCommit({blockNum: 2});
        expect(checks(memory)).toBe(2);
        for (let read = 0; read < 20; read++) await store.readCommit(prepared.id);
        expect(checks(memory)).toBe(2);
        now += bound;
        await store.readCommit(prepared.id);
        expect(checks(memory)).toBe(3);
    });

    it('never caches a failed check', async () => {
        freeze();
        const {memory, store} = bundle();
        await store.prepare('first', {value: 1});
        memory.settings.get(store.index)['index.translog.durability'] = 'async';
        await expect(store.prepare('second', {value: 2})).rejects.toThrow();
        const before = checks(memory);
        await expect(store.read('first')).rejects.toThrow();
        await expect(store.read('first')).rejects.toThrow();
        expect(checks(memory)).toBe(before + 2);
        memory.settings.get(store.index)['index.translog.durability'] = 'request';
        expect(await store.read('first')).toEqual({value: 1});
    });

    it('measures the bound from before the check started', async () => {
        freeze();
        const freshness = new ProtocolMetadataFreshness(bound);let ran = 0;
        await freshness.run(false, async () => {ran++; now += bound - 1;});
        await freshness.run(false, async () => {ran++;});
        expect(ran).toBe(1);
        now += 1;
        await freshness.run(false, async () => {ran++;});
        expect(ran).toBe(2);
    });

    it('lets an overlapping failure outrank an older success', async () => {
        freeze();
        const freshness = new ProtocolMetadataFreshness(bound);let release!: () => void, ran = 0;
        const held = freshness.run(false, () => new Promise<void>(resolve => {release = resolve;}));
        await expect(freshness.run(false, async () => {throw new Error('unsafe');})).rejects.toThrow('unsafe');
        release(); await held;
        await freshness.run(false, async () => {ran++;});
        expect(ran).toBe(1);
    });

    it('does not let an older success move the window backwards', async () => {
        freeze();
        const freshness = new ProtocolMetadataFreshness(bound);let release!: () => void, ran = 0;
        const held = freshness.run(false, () => new Promise<void>(resolve => {release = resolve;}));
        now += 500;
        await freshness.run(true, async () => {});
        release(); await held;
        now += bound - 1;
        await freshness.run(false, async () => {ran++;});
        expect(ran).toBe(0);
    });

    it('sends nothing for an aborted read inside the bound', async () => {
        freeze();
        const aborted = AbortSignal.abort(new Error('stopped'));
        const {memory, store} = bundle();
        await store.prepare('first', {value: 1});
        const sent = memory.calls.length;
        await expect(store.read('first', aborted)).rejects.toThrow('stopped');
        await expect(store.missingManifestHint(['first'], aborted)).rejects.toThrow('stopped');
        expect(memory.calls.length).toBe(sent);
        const control = frontier();
        await control.store.compareAndSet(null, {revision: 1});
        const controlSent = control.memory.calls.length;
        await expect(control.store.readControl(aborted)).rejects.toThrow('stopped');
        expect(control.memory.calls.length).toBe(controlSent);
    });

    it('cannot be configured beyond the stated bound, and zero checks every read', async () => {
        for (const value of [bound + 1, -1, 1.5]) expect(() => new ProtocolMetadataFreshness(value)).toThrow('bound');
        expect(() => bundle({metadataReadBoundMs: bound + 1})).toThrow('bound');
        freeze();
        const {memory, store} = bundle({metadataReadBoundMs: 0});
        await store.prepare('first', {value: 1});
        const before = checks(memory);
        await store.read('first'); await store.read('first');
        expect(checks(memory)).toBe(before + 2);
    });

    it('checks every read unless a store opts in', async () => {
        freeze();
        const memory = frontierMemoryClient(), plain = new ImmutableProtocolBundleStore(memory.client as any, 'fixture', 0, 'freshness', 'freshness-v1');
        await plain.prepare('first', {value: 1});
        let before = checks(memory);
        await plain.read('first'); await plain.read('first');
        expect(checks(memory)).toBe(before + 2);
        const control = new ProtocolAbiFrontierStore(memory.client as any, 'fixture');
        await control.compareAndSet(null, {revision: 1});
        before = checks(memory);
        await control.readControl(); await control.readControl();
        expect(checks(memory)).toBe(before + 2);
    });

    it('gives the API reader the bounded window', async () => {
        freeze();
        const memory = frontierMemoryClient();
        await new ProtocolAbiFrontierStore(memory.client as any, 'fixture').compareAndSet(null, {revision: 1});
        const host: any = {manager: {chain: 'fixture', conn: {chains: {fixture: {chain_id: '1'.repeat(64)}}}, config: {settings: {}}}, elastic: memory.client};
        const consumer = new ProtocolActionConsumer(host, {id: '@eosrio/hyperion-wire-plugin', provider: {profileId: 'freshness-fixture'},
            components: [{id: 'wire-node', runtime: 'node', version: '0.0.0-dev.1', sourceRevision: 'a'.repeat(40), sha256: 'b'.repeat(64)}]} as any);
        const store = (consumer.reader as any).options.store, before = checks(memory);
        await store.readControl(); await store.readControl();
        expect(checks(memory)).toBe(before + 1);
    });

    it('carries the bound into read-only frontier views', async () => {
        freeze();
        const {memory, store} = frontier({metadataReadBoundMs: 0}), view = store.asReadOnly();
        await store.compareAndSet(null, {revision: 1});
        const before = checks(memory);
        await view.readControl(); await view.readControl();
        expect(checks(memory)).toBe(before + 2);
    });
});
