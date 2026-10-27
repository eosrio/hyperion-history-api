import {describe, expect, it} from 'bun:test';
import {createHash} from 'node:crypto';
import {ActionHistorySourceJournal, ActionHistorySourceJournalReadError} from '../../src/indexer/history/action-source-journal.js';
import {actionHistoryImmutableJson, actionHistoryManifestBounds, actionHistoryPlanId,
    fingerprintActionHistoryEffect, type ActionHistoryBlockPlan} from '../../src/indexer/history/action-history-manifest.js';
import {protocolImmutableJson} from '../../src/indexer/protocol/immutable-bundle-store.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

const hex = (character: string) => character.repeat(64), txA = hex('a'), txB = hex('b'), txC = hex('c');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const plan = (): ActionHistoryBlockPlan => ({schemaVersion: 1,
    source: {chainId: hex('1'), blockNum: 42, blockId: hex('2'), previousBlockId: hex('3'), captureSha256: hex('4')},
    producer: {protocolId: 'antelope', profileId: 'ship-v0', codeRevision: '5'.repeat(40), configurationSha256: hex('6'), pluginsSha256: hex('7')},
    target: {name: 'fixture-action-v3-000001', uuid: 'a-fresh-index-uuid'}, transactions: [
        {transactionId: txA, traceOrdinal: 0, traceSha256: hex('8'), disposition: 'process'},
        {transactionId: txB, traceOrdinal: 1, traceSha256: hex('9'), disposition: 'excluded'},
        {transactionId: txC, traceOrdinal: 2, traceSha256: hex('0'), disposition: 'no-effects'}
    ]});
const action = (sequence = '9007199254740993'): any => ({global_sequence: sequence, block_num: 42, trx_id: txA,
    code_sequence: 0xffffffff, abi_sequence: 0, action_ordinal: 7, creator_action_ordinal: 0,
    act: {account: 'contract.a', name: 'send', data: {ratio: 1.25, exponent: 1e100, global_sequence: '0004'}},
    receipts: [{receiver: 'notification', global_sequence: '18446744073709551615', recv_sequence: '9223372036854775808',
        auth_sequence: [{account: 'alice', sequence: '18446744073709551615'}]},
    {receiver: 'contract.a', global_sequence: sequence, recv_sequence: '0', auth_sequence: []}]});

function fixture(replicas = 0) {
    const memory = frontierMemoryClient(replicas), journal = new ActionHistorySourceJournal(memory.client as any, 'fixture', replicas);
    return {memory, journal};
}
async function prepared(replicas = 0) {
    const value = fixture(replicas), source = plan(), {id} = await value.journal.preparePlan(source);
    const fragments = [await value.journal.recordFragment(id, txA, [action()]), await value.journal.recordFragment(id, txB, []),
        await value.journal.recordFragment(id, txC, [])];
    return {...value, source, id, fragments};
}
async function failure(work: Promise<unknown>): Promise<any> {try {await work;} catch (error) {return error;} throw new Error('Expected failure');}
async function dataError(work: Promise<unknown>, code: string, kind?: string) {
    const error = await failure(work); expect(error).toBeInstanceOf(ActionHistorySourceJournalReadError); expect(error.code).toBe(code);
    if (kind) expect(error.recordKind).toBe(kind);
}
function stored(memory: ReturnType<typeof frontierMemoryClient>, index: string, id: string): any {
    const manifest = memory.documents.get(memory.key(index, id))!.document;
    return JSON.parse(Buffer.concat(manifest.chunk_ids.map((chunk: string) =>
        Buffer.from(memory.documents.get(memory.key(index, chunk))!.document.payload, 'base64'))).toString('utf8'));
}
function recordIds(memory: ReturnType<typeof frontierMemoryClient>, index: string, prefix: string): string[] {
    return [...memory.documents.values()].map((value: any) => value.document).filter((value: any) =>
        value.kind === 'manifest' && value.bundle_id.startsWith(prefix)).map((value: any) => value.bundle_id);
}
function replaceRecord(memory: ReturnType<typeof frontierMemoryClient>, index: string, id: string, record: unknown) {
    const payload = protocolImmutableJson(record), digest = hash(payload), chunkId = id + ':' + digest + ':0';
    const old = memory.documents.get(memory.key(index, id));
    memory.documents.set(memory.key(index, id), {...old, document: {kind: 'manifest', bundle_id: id, digest,
        byte_length: Buffer.byteLength(payload), chunk_ids: [chunkId]}});
    memory.documents.set(memory.key(index, chunkId), {seq: 9999, primaryTerm: 1, document: {kind: 'chunk', bundle_id: id,
        digest, byte_length: Buffer.byteLength(payload), chunk_index: 0, payload: Buffer.from(payload).toString('base64')}});
}
function writes(memory: ReturnType<typeof frontierMemoryClient>) {return memory.calls.filter((call: any) => ['create', 'index'].includes(call.method));}
function captureIo(memory: ReturnType<typeof frontierMemoryClient>, after: (method: string, request: any) => void = () => {}) {
    const seen: Array<{method: string; request: any; signal?: AbortSignal}> = [];
    for (const [owner, name, method] of [[memory.client.indices, 'create', 'createIndex'], [memory.client.indices, 'getMapping', 'getMapping'],
        [memory.client.indices, 'getSettings', 'getSettings'], [memory.client, 'get', 'get'], [memory.client, 'create', 'create'],
        [memory.client, 'index', 'index']] as const) {
        const original = owner[name].bind(owner);
        (owner as any)[name] = async (request: any, options?: any) => {
            seen.push({method, request, signal: options?.signal});
            const result = await original(request, options); after(method, request); return result;
        };
    }
    return seen;
}

describe('durable action source membership journal', () => {
    it('retains complete session provenance in distinct source-scoped plans and refuses changes within one plan', async () => {
        const {journal} = fixture(1), legacy = plan();
        const firstPlan = {...legacy, source: {...legacy.source, retainedSourceId: 'h45actionsource1:' + hex('a')},
            transactions: legacy.transactions.slice(0, 1)};
        const secondPlan = {...firstPlan, source: {...firstPlan.source, retainedSourceId: 'h45actionsource1:' + hex('b')}};
        const firstId = (await journal.preparePlan(firstPlan)).id, secondId = (await journal.preparePlan(secondPlan)).id;
        // Constructed locator shapes test byte identity only; they confer no native/source authority.
        const first = {...action(), protocol: {selectionId: 'h45srcsel1:' + hex('c'), native: {linkId: 'h45srcnat1:' + hex('d')}}};
        const second = {...action(), protocol: {selectionId: 'h45srcsel1:' + hex('e'), native: {linkId: 'h45srcnat1:' + hex('f')}}};
        expect(first.act.data).toEqual(second.act.data);
        expect(fingerprintActionHistoryEffect(first).documentSha256).not.toBe(fingerprintActionHistoryEffect(second).documentSha256);
        const original = await journal.recordFragment(firstId, txA, [first]);
        const recovered = await journal.recordFragment(secondId, txA, [second]);
        expect(original.id).not.toBe(recovered.id);
        const firstSeal = await journal.seal(firstId), secondSeal = await journal.seal(secondId);
        expect(firstSeal.manifest.fragments[0]).toEqual(original.fragment);
        expect(secondSeal.manifest.fragments[0]).toEqual(recovered.fragment);
        await expect(journal.recordFragment(firstId, txA, [second])).rejects.toThrow('Immutable ABI observation conflict');
        expect(await journal.readManifest(firstId)).toEqual(firstSeal);
        expect(await journal.readManifest(secondId)).toEqual(secondSeal);
    });
    it('stores a strict independent namespace and survives restart with source-ordered complete membership', async () => {
        const {memory, journal, id, source, fragments} = await prepared(1), sealed = await journal.seal(id);
        expect(journal.index).toBe('fixture-history-source-journal-v1');
        expect(journal.index.startsWith('fixture-action-')).toBe(false);
        expect(memory.mappings.get(journal.index)._meta).toEqual({hyperion_kind: 'action-source-journal', schema_version: 1});
        const restarted = new ActionHistorySourceJournal(memory.client as any, 'fixture', 1);
        expect(await restarted.readPlan(id)).toEqual({id, plan: source});
        expect(await restarted.readManifest(id)).toEqual(sealed); expect(await restarted.seal(id)).toEqual(sealed);
        expect(sealed.manifest.fragments.map(value => value.transactionId)).toEqual([txA, txB, txC]);
        expect(sealed.manifest.fragments.map(value => value.effects.length)).toEqual([1, 0, 0]);
        expect(sealed.manifest.fragments[0]).toEqual(fragments[0].fragment);
        expect(Object.isFrozen(sealed.manifest)).toBe(true); expect(Object.isFrozen(sealed.manifest.fragments[0].effects)).toBe(true);
        for (const call of writes(memory)) {
            expect(call.request.wait_for_active_shards).toBe('all'); expect(call.request.pipeline).toBe('_none'); expect(call.request.refresh).toBe(false);
        }
        expect(memory.calls.some((call: any) => ['search', 'bulk', 'delete', 'count'].includes(call.method))).toBe(false);
    });

    it('requires every explicit transaction fragment and never treats absent excluded transactions as empty', async () => {
        const {memory, journal} = fixture(), {id} = await journal.preparePlan(plan());
        await dataError(journal.seal(id), 'incomplete', 'fragment-link');
        await journal.recordFragment(id, txA, [action()]);
        await journal.recordFragment(id, txB, []);
        await dataError(journal.seal(id), 'incomplete', 'fragment-link');
        await dataError(journal.readManifest(id), 'missing', 'seal');
        expect(recordIds(memory, journal.index, 'h45actionseal1:')).toEqual([]);
        await journal.recordFragment(id, txC, []);
        expect((await journal.seal(id)).manifest.fragments.length).toBe(3);
    });

    it('seals an explicitly empty source block without inventing transactions or relying on output rows', async () => {
        const {journal} = fixture(), source = plan(); (source as any).transactions = [];
        const {id} = await journal.preparePlan(source), sealed = await journal.seal(id);
        expect(sealed.manifest.fragments).toEqual([]); expect(await journal.readManifest(id)).toEqual(sealed);
    });

    it('stores references before stable links and repairs every referenced all-copy receipt when sealing', async () => {
        const {memory, journal, id, fragments} = await prepared(1), start = memory.calls.length;
        const sealed = await journal.seal(id), fresh = memory.calls.slice(start).filter((call: any) => call.method === 'index');
        const ids = fresh.map((call: any) => call.request.id);
        expect(ids).toContain(id); for (const fragment of fragments) expect(ids).toContain(fragment.id);
        for (const link of recordIds(memory, journal.index, 'h45actiontx1:')) {
            const record = stored(memory, journal.index, link);
            expect(ids.indexOf(record.fragmentId)).toBeLessThan(ids.indexOf(link));
        }
        const manifestWrite = writes(memory).findIndex((call: any) => call.request.id === sealed.id);
        const sealWrite = writes(memory).findIndex((call: any) => call.request.id.startsWith('h45actionseal1:'));
        expect(manifestWrite).toBeLessThan(sealWrite);
    });

    it.each(['plan', 'fragment', 'link'])('cannot bless a %s from GET while its fresh durable receipt remains partial', async kind => {
        const {memory, journal, id, fragments} = await prepared(1);
        const target = kind === 'plan' ? id : kind === 'fragment' ? fragments[0].id : recordIds(memory, journal.index, 'h45actiontx1:')[0];
        memory.faults.receipt = (value: any, request: any) => request.id === target ?
            {...value, _shards: {total: 2, successful: 1, failed: 1}} : value;
        expect(stored(memory, journal.index, target)).toBeDefined();
        await expect(journal.seal(id)).rejects.toThrow('durable write receipt');
        await dataError(journal.readManifest(id), 'missing', 'seal');
        delete memory.faults.receipt;
        expect((await journal.seal(id)).manifest.fragments.length).toBe(3);
        expect(memory.calls.some((call: any) => call.method === 'index' && call.request.id === target)).toBe(true);
    });

    it('retries unknown-outcome fragment and seal writes without allowing GET to replace a fresh receipt', async () => {
        const {memory, journal} = fixture(1), {id} = await journal.preparePlan(plan());
        const unknown = new Error('connection lost after write'); let targetPrefix = 'h45actionfragment1:', throws = true;
        memory.faults.receipt = (value: any, request: any) => {
            if (throws && request.id.startsWith(targetPrefix) && request.document.kind === 'manifest') {throws = false; throw unknown;}
            return value;
        };
        await expect(journal.recordFragment(id, txA, [action()])).rejects.toBe(unknown);
        await dataError(journal.seal(id), 'incomplete', 'fragment-link');
        const repaired = await journal.recordFragment(id, txA, [action()]);
        expect(memory.calls.some((call: any) => call.method === 'index' && call.request.id === repaired.id)).toBe(true);
        await journal.recordFragment(id, txB, []); await journal.recordFragment(id, txC, []);
        targetPrefix = 'h45actionseal1:'; throws = true;
        await expect(journal.seal(id)).rejects.toBe(unknown);
        const before = memory.calls.length, repairedSeal = await journal.seal(id);
        expect(await journal.readManifest(id)).toEqual(repairedSeal);
        expect(memory.calls.slice(before).some((call: any) => call.method === 'index' && call.request.id.startsWith('h45actionseal1:'))).toBe(true);
    });

    it('publishes one immutable transaction choice and refuses conflicting redelivery, including concurrent conflicts', async () => {
        const {memory, journal} = fixture(), {id} = await journal.preparePlan(plan());
        const original = action(), changed = action(); changed.act.data.ratio = 9.5;
        const settled = await Promise.allSettled([journal.recordFragment(id, txA, [original]), journal.recordFragment(id, txA, [changed])]);
        expect(settled.filter(value => value.status === 'fulfilled').length).toBe(1);
        expect(settled.filter(value => value.status === 'rejected').length).toBe(1);
        const winner = (settled.find(value => value.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
        await journal.recordFragment(id, txB, []); await journal.recordFragment(id, txC, []);
        const sealed = await journal.seal(id); expect(sealed.manifest.fragments[0]).toEqual(winner.fragment);
        expect(recordIds(memory, journal.index, 'h45actiontx1:').length).toBe(3);
    });

    it('refuses duplicate exact action IDs across distinct planned transactions before publishing a seal', async () => {
        const {memory, journal} = fixture(), source = plan(); (source.transactions[1] as any).disposition = 'process';
        const {id} = await journal.preparePlan(source);
        await journal.recordFragment(id, txA, [action()]);
        await journal.recordFragment(id, txB, [{...action(), trx_id: txB}]); await journal.recordFragment(id, txC, []);
        await expect(journal.seal(id)).rejects.toThrow('across transactions');
        expect(recordIds(memory, journal.index, 'h45actionseal1:')).toEqual([]);
    });

    it.each(['plan', 'fragment-link', 'fragment', 'manifest'])('keeps missing referenced %s explicit instead of synthesizing membership', async kind => {
        const {memory, journal, id, fragments} = await prepared(), sealed = await journal.seal(id);
        const target = kind === 'plan' ? id : kind === 'fragment' ? fragments[0].id : kind === 'manifest' ? sealed.id :
            recordIds(memory, journal.index, 'h45actiontx1:')[0];
        memory.documents.delete(memory.key(journal.index, target));
        await dataError(journal.readManifest(id), 'incomplete', kind);
    });

    it('detects missing or corrupt chunks, foreign-ID substitution and inconsistent link/manifests after restart', async () => {
        const {memory, journal, id, fragments} = await prepared(), sealed = await journal.seal(id);
        const physical = memory.documents.get(memory.key(journal.index, fragments[0].id))!, chunkKey = memory.key(journal.index, physical.document.chunk_ids[0]);
        const chunk = memory.documents.get(chunkKey)!; memory.documents.delete(chunkKey);
        await dataError(journal.readManifest(id), 'incomplete', 'fragment');
        memory.documents.set(chunkKey, chunk); chunk.document.payload = 'AA==';
        await dataError(journal.readManifest(id), 'invalid', 'fragment');
        chunk.document.payload = Buffer.from(protocolImmutableJson(fragments[0].fragment)).toString('base64');
        const changed = structuredClone(sealed.manifest); (changed.fragments[0].effects[0] as any).documentSha256 = hex('f');
        replaceRecord(memory, journal.index, sealed.id, changed);
        await dataError(journal.readManifest(id), 'invalid', 'manifest');
    });

    it('rejects digest-correct transaction and seal link substitutions', async () => {
        for (const kind of ['fragment-link', 'seal'] as const) {
            const {memory, journal, id} = await prepared(); await journal.seal(id);
            const target = recordIds(memory, journal.index, kind === 'seal' ? 'h45actionseal1:' : 'h45actiontx1:')[0];
            const value = stored(memory, journal.index, target); value.planId = 'h45actionplan1:' + hex('e');
            replaceRecord(memory, journal.index, target, value);
            await dataError(journal.readManifest(id), 'invalid', kind);
        }
    });

    it('rejects digest-correct plan or fragment bytes stored under a different semantic content identity', async () => {
        for (const kind of ['plan', 'fragment'] as const) {
            const {memory, journal, id, fragments} = await prepared(); await journal.seal(id);
            const target = kind === 'plan' ? id : fragments[0].id, value = stored(memory, journal.index, target);
            if (kind === 'plan') value.source.captureSha256 = hex('f'); else value.effects[0].metadataSha256 = hex('f');
            replaceRecord(memory, journal.index, target, value);
            await dataError(journal.readManifest(id), 'invalid', kind);
        }
    });

    it('rechecks index ownership, source retention, pipelines and durability after a successful operation', async () => {
        for (const mutate of [
            (memory: any, index: string) => {memory.mappings.get(index)._meta.hyperion_kind = 'foreign';},
            (memory: any, index: string) => {memory.mappings.get(index)._source = {excludes: ['payload']};},
            (memory: any, index: string) => {memory.settings.get(index)['index.default_pipeline'] = 'prune';},
            (memory: any, index: string) => {memory.settings.get(index)['index.translog.durability'] = 'async';},
            (memory: any, index: string) => {memory.settings.get(index)['index.number_of_replicas'] = '1';}
        ]) {
            const {memory, journal, id} = await prepared(); await journal.readPlan(id); mutate(memory, journal.index);
            expect(await failure(journal.readPlan(id))).not.toBeInstanceOf(ActionHistorySourceJournalReadError);
            await expect(journal.seal(id)).rejects.toThrow();
        }
    });

    it('does not manufacture missing data errors for infrastructure failures or malformed ES receipts', async () => {
        const {memory, journal, id} = await prepared(), outage = new Error('ES offline');
        memory.faults.beforeRead = () => {throw outage;}; await expect(journal.readPlan(id)).rejects.toBe(outage);
        delete memory.faults.beforeRead; memory.faults.read = (value: any) => ({...value, _index: 'foreign'});
        const error = await failure(journal.readPlan(id)); expect(error).not.toBeInstanceOf(ActionHistorySourceJournalReadError);
        expect(error.message).toContain('realtime read');
    });

    it('bounds concurrent public operations without retaining an unbounded queue', async () => {
        const {memory, journal, id} = await prepared(); let entered = 0, ready!: () => void, release!: () => void;
        const allEntered = new Promise<void>(resolve => {ready = resolve;}), barrier = new Promise<void>(resolve => {release = resolve;});
        memory.faults.beforeRead = async () => {if (++entered === 4) ready(); await barrier;};
        const pending = Array.from({length: 4}, () => journal.readPlan(id));
        await allEntered;
        await expect(journal.readPlan(id)).rejects.toThrow('concurrent operation budget');
        release(); expect((await Promise.all(pending)).length).toBe(4);
        delete memory.faults.beforeRead; expect((await journal.readPlan(id)).id).toBe(id);
    });
});

describe('journal action source association and caller isolation', () => {
    it('preserves original action order and exact values, including finite opaque numbers and special keys', async () => {
        const {journal} = fixture(), {id} = await journal.preparePlan(plan()), first = action('18446744073709551615'), second = action('9223372036854775808');
        first.block_id = plan().source.blockId; first.act.data = JSON.parse('{"__proto__":{"ratio":1.25},"constructor":1e100,"toString":"data"}');
        const before = actionHistoryImmutableJson([first, second]), result = await journal.recordFragment(id, txA, [first, second]);
        expect(result.fragment.effects).toEqual([fingerprintActionHistoryEffect(first), fingerprintActionHistoryEffect(second)]);
        expect(actionHistoryImmutableJson([first, second])).toBe(before);
        expect(result.fragment.effects.map(value => value.globalSequence)).toEqual(['18446744073709551615', '9223372036854775808']);
    });

    it.each([
        (value: any) => {value.trx_id = txB;},
        (value: any) => {value.trx_id = txA.toUpperCase();},
        (value: any) => {value.block_num = '42';},
        (value: any) => {value.block_num = 0;},
        (value: any) => {value.block_num = 0x100000000;},
        (value: any) => {delete value.block_num;},
        (value: any) => {value.block_id = null;},
        (value: any) => {value.block_id = hex('g');},
        (value: any) => {value.global_sequence = 9007199254740992;},
        (value: any) => {value.receipts[0].recv_sequence = '01';},
        (value: any) => {value.act.data = new Date();},
        (value: any) => {value.act.data = value;},
        (value: any) => {value.act.data = NaN;},
        (value: any) => {value.act.data = Infinity;}
    ])('rejects malformed caller actions before any I/O', async mutate => {
        const {memory, journal} = fixture(), value = action(); mutate(value);
        await expect(journal.recordFragment(actionHistoryPlanId(plan()), txA, [value])).rejects.toThrow(); expect(memory.calls.length).toBe(0);
    });

    it('rejects valid metadata from a different planned block/source without publishing effects', async () => {
        const {memory, journal} = fixture(), {id} = await journal.preparePlan(plan());
        for (const mutate of [(value: any) => {value.block_num++;}, (value: any) => {value.block_id = hex('e');}]) {
            const value = action(); mutate(value); const before = writes(memory).length;
            await expect(journal.recordFragment(id, txA, [value])).rejects.toThrow('planned source block');
            expect(writes(memory).length).toBe(before);
        }
        const before = writes(memory).length;
        await expect(journal.recordFragment(id, txB, [{...action(), trx_id: txB}])).rejects.toThrow('contains action effects');
        await expect(journal.recordFragment(id, hex('e'), [])).rejects.toThrow('Unplanned');
        await expect(journal.recordFragment(id, txA, [action(), action()])).rejects.toThrow('repeated');
        expect(writes(memory).length).toBe(before);
    });

    it('checks count bounds and all descriptors before child access or I/O', async () => {
        const {memory, journal} = fixture(), id = actionHistoryPlanId(plan()); let reads = 0;
        const overflow: unknown[] = Array(actionHistoryManifestBounds.maximumEffects + 1);
        Object.defineProperty(overflow, '0', {get() {reads++; throw new Error('oversize child visited');}, enumerable: true});
        await expect(journal.recordFragment(id, txA, overflow)).rejects.toThrow('bounded effect count');
        for (const values of [[action(), , action()], [Object.defineProperty(action(), 'act', {get() {reads++; throw new Error('getter ran');}, enumerable: true})],
            [{...action(), act: {data: {toJSON() {reads++; return {};}}}}]]) {
            await expect(journal.recordFragment(id, txA, values)).rejects.toThrow();
        }
        const invalid = {...plan(), transactions: overflow};
        await expect(journal.preparePlan(invalid as any)).rejects.toThrow('bounded transaction count');
        expect(reads).toBe(0); expect(memory.calls.length).toBe(0);
    });

    it('detaches the complete caller action batch and plan before the first await', async () => {
        const {memory, journal} = fixture(), source = plan(), originalId = actionHistoryPlanId(source);
        let first = true;
        memory.faults.beforeIndex = () => {if (first) {first = false; (source.source as any).blockNum = 999;}};
        expect((await journal.preparePlan(source)).id).toBe(originalId);
        delete memory.faults.beforeIndex;
        const value = action(), expected = fingerprintActionHistoryEffect(value); let mutate = true;
        memory.faults.beforeRead = () => {if (mutate) {mutate = false; value.block_num = 999; value.act.data.ratio = 9.75; value.receipts = [];}};
        const result = await journal.recordFragment(originalId, txA, [value]);
        expect(result.fragment.effects).toEqual([expected]); expect((await journal.readPlan(originalId)).plan.source.blockNum).toBe(42);
    });

    it('binds the target to the configured chain action namespace before writing or accepting a stored plan', async () => {
        const {memory, journal} = fixture(), foreign = plan(); (foreign.target as any).name = 'other-action-v3-000001';
        await expect(journal.preparePlan(foreign)).rejects.toThrow('configured chain action namespace'); expect(memory.calls.length).toBe(0);
        const good = await journal.preparePlan(plan());
        replaceRecord(memory, journal.index, good.id, foreign);
        await dataError(journal.readPlan(good.id), 'invalid', 'plan');
        for (const value of ['', 'h45actionplan1:' + hex('g'), good.id + 'x']) {
            const count = memory.calls.length;
            await expect(journal.readPlan(value)).rejects.toThrow('plan ID'); expect(memory.calls.length).toBe(count);
        }
    });

    it('allows read-only inspection without provisioning or granting any writer capability', async () => {
        const {memory, journal, id} = await prepared(); const sealed = await journal.seal(id), before = memory.calls.length;
        const options = {readOnly: true}, reader = new ActionHistorySourceJournal(memory.client as any, 'fixture', 0, options);
        options.readOnly = false;
        expect(await reader.readPlan(id)).toEqual(await journal.readPlan(id)); expect(await reader.readManifest(id)).toEqual(sealed);
        await expect(reader.preparePlan(plan())).rejects.toThrow('Read-only');
        await expect(reader.recordFragment(id, txA, [action()])).rejects.toThrow('Read-only'); await expect(reader.seal(id)).rejects.toThrow('Read-only');
        expect(memory.calls.slice(before).some((call: any) => ['createIndex', 'create', 'index'].includes(call.method))).toBe(false);
        const absent = fixture(), freshReader = new ActionHistorySourceJournal(absent.memory.client as any, 'fixture', 0, {readOnly: true});
        await expect(freshReader.readPlan(id)).rejects.toThrow('index not found'); expect(absent.memory.mappings.size).toBe(0);
    });
});

describe('journal cancellation through immutable preparation and repair', () => {
    it('checks already-aborted requests before all preflight or I/O work', async () => {
        const {memory, journal} = fixture(), controller = new AbortController(), reason = new Error('stop journal'); controller.abort(reason);
        const id = actionHistoryPlanId(plan());
        for (const work of [journal.preparePlan(plan(), controller.signal), journal.readPlan(id, controller.signal),
            journal.recordFragment(id, txA, [action()], controller.signal), journal.seal(id, controller.signal), journal.readManifest(id, controller.signal)]) {
            await expect(work).rejects.toBe(reason);
        }
        expect(memory.calls.length).toBe(0);
    });

    it.each(['createIndex', 'getMapping', 'getSettings', 'get', 'create', 'index'])('forwards cancellation to %s and prevents subsequent I/O after it completes', async target => {
        const {memory, journal} = fixture(); if (target === 'index' || target === 'get') await journal.preparePlan(plan());
        const controller = new AbortController(), reason = new Error('cancel after ' + target); let triggered = false;
        const calls = captureIo(memory, method => {if (!triggered && method === target) {triggered = true; controller.abort(reason);}});
        await expect(journal.preparePlan(plan(), controller.signal)).rejects.toBe(reason);
        expect(triggered).toBe(true); expect(calls.at(-1)?.method).toBe(target);
        expect(calls.every(call => call.signal === controller.signal)).toBe(true);
        expect(memory.calls.some((call: any) => call.method === 'delete')).toBe(false);
    });

    it('keeps partial chunk data after cancellation, then repairs it with a fresh all-copy retry', async () => {
        const {memory, journal} = fixture(1), source = plan();
        (source as any).transactions = Array.from({length: 4000}, (_, index) => ({transactionId: index.toString(16).padStart(64, '0'),
            traceOrdinal: index, traceSha256: hex('8'), disposition: 'no-effects'}));
        const id = actionHistoryPlanId(source), controller = new AbortController(), reason = new Error('cancel during chunks');
        captureIo(memory, (method, request) => {if (method === 'create' && request.document.kind === 'chunk') controller.abort(reason);});
        await expect(journal.preparePlan(source, controller.signal)).rejects.toBe(reason);
        expect(memory.documents.has(memory.key(journal.index, id))).toBe(false);
        expect(memory.documents.size).toBe(1);
        expect((await journal.preparePlan(source)).id).toBe(id);
        expect(await journal.readPlan(id)).toEqual({id, plan: source});
        expect(memory.calls.some((call: any) => call.method === 'index' && call.request.document.kind === 'chunk')).toBe(true);
    });

    it('releases the operation slot after cancellation and rejects transport errors that arrive after abort', async () => {
        const {memory, journal} = fixture(), controller = new AbortController(), reason = new Error('cancel failed I/O');
        memory.faults.beforeIndex = () => {controller.abort(reason); throw new Error('late transport failure');};
        await expect(journal.preparePlan(plan(), controller.signal)).rejects.toBe(reason);
        delete memory.faults.beforeIndex;
        expect((await journal.preparePlan(plan())).id).toBe(actionHistoryPlanId(plan()));
    });
});
