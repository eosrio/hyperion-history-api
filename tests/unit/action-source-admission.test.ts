import {describe, expect, it} from 'bun:test';
import {createHash} from 'node:crypto';
import {ActionSourceAdmissionStore, type RetainedActionSource} from '../../src/indexer/history/action-source-admission.js';
import {deriveActionSourceInventory, type ActionSourceInventoryInput} from '../../src/indexer/history/action-source-inventory.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

// ES receipts/faults are simulated transport behavior. These are component tests, not native-copy or source-capture qualification.

const hex = (value: string) => value.repeat(64), txid = hex('a'), emptyTx = hex('b');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const target = {name: 'fixture-action-v1-000001', uuid: 'owned-target-uuid'};
function gate() {let release!: () => void; const promise = new Promise<void>(done => {release = done;}); return {promise, release};}
function occurrence(ordinal: number, creator = 0, receiver = 'token'): any {
    return ['action_trace_v0', {action_ordinal: ordinal, creator_action_ordinal: creator, receiver,
        receipt: ['action_receipt_v0', {receiver, act_digest: hex('e'), global_sequence: String(100 + ordinal),
            recv_sequence: String(ordinal), auth_sequence: [{account: 'alice', sequence: String(10 + ordinal)}],
            code_sequence: ordinal, abi_sequence: 20 + ordinal}],
        act: {account: 'token', name: 'transfer', authorization: [{actor: 'alice', permission: 'active'}], data: '0102'},
        context_free: false, except: null, error_code: null, elapsed: '0', console: ''}];
}
function input(): ActionSourceInventoryInput {
    return {profileId: 'antelope-default-v1', source: {chainId: hex('1'), blockNum: 12, blockId: hex('2'),
        producer: 'producer', timestamp: '2026-10-20T00:00:00.000'}, policy: {schemaVersion: 1, parserVersion: '3.2',
        actionBlacklist: [], actionWhitelist: [], rootOnly: false, maxDepth: 0, maxInline: 0, eosioAlias: 'eosio'},
        traces: [['transaction_trace_v0', {id: txid, status: 0, scheduled: false, failed_dtrx_trace: null,
            except: null, error_code: null, cpu_usage_us: 15, net_usage_words: 2, partial: null,
            action_traces: [occurrence(1), occurrence(2, 1, 'alice'), occurrence(3)]}]]};
}
/** Explicit component outputs: one root plus notification, then a separate identical inline/root action.
 * These are constructed parser-boundary fixtures, not a captured chain or a contract ABI oracle. */
function outputs(): any[] {
    const receipt = (ordinal: number, receiver = 'token') => ({receiver, global_sequence: String(100 + ordinal),
        recv_sequence: String(ordinal), auth_sequence: [{account: 'alice', sequence: String(10 + ordinal)}]});
    const action = (ordinal: number) => ({'@timestamp': '2026-10-20T00:00:00.000', block_num: 12, block_id: hex('2'),
        producer: 'producer', trx_id: txid, action_ordinal: ordinal, creator_action_ordinal: 0,
        global_sequence: String(100 + ordinal), act_digest: hex('e'), code_sequence: ordinal, abi_sequence: 20 + ordinal,
        act: {account: 'token', name: 'transfer', authorization: [{actor: 'alice', permission: 'active'}],
            data: {ratio: 1.25, global_sequence: '0004'}}, receipts: [receipt(ordinal)]});
    return [{...action(1), code_sequence: 2, abi_sequence: 22, cpu_usage_us: 15, net_usage_words: 2,
        inline_count: 2, inline_filtered: false, receipts: [receipt(1), receipt(2, 'alice')]}, action(3)];
}
function fixture(replicas = 1) {
    const memory = frontierMemoryClient(replicas), store = new ActionSourceAdmissionStore(memory.client as any, 'fixture', replicas);
    return {memory, store};
}
async function retained(value = input(), replicas = 1) {
    const result = fixture(replicas), frameHex = '010203', schemaJson = '{}', captureSha256 = hash(Buffer.from(frameHex, 'hex'));
    const ingressId = await result.store.retainIngress({schemaVersion: 1, chainId: hex('1'), protocolId: 'antelope',
        profileId: 'antelope-default-v1', readerSessionId: 'reader-session-1', components: [], schemaJson, frameHex, captureSha256});
    const source: RetainedActionSource = {schemaVersion: 1, frameHex, schemaJson, captureSha256, ingressId,
        previousBlockId: hex('3'), producer: {protocolId: 'antelope', profileId: 'antelope-default-v1',
            codeRevision: 'f'.repeat(40), configurationSha256: hex('4'), pluginsSha256: hex('5')},
        executableSha256: hex('6'), inventoryInput: value};
    const sourceId = await result.store.retainSource(source);
    return {...result, source, sourceId, ingressId};
}
async function admitted(value = input()) {
    const result = await retained(value), admission = await result.store.admit(result.sourceId, target);
    const inventory = deriveActionSourceInventory(value), dispatch = inventory.transactions[0]?.dispatch;
    return {...result, admission, inventory, payload: dispatch ? Buffer.from(dispatch.canonicalJson) : undefined};
}
function manifests(memory: ReturnType<typeof frontierMemoryClient>, index: string, prefix: string) {
    return [...memory.documents.values()].map((value: any) => value.document)
        .filter((value: any) => value.kind === 'manifest' && value.bundle_id.startsWith(prefix));
}
function writes(memory: ReturnType<typeof frontierMemoryClient>) {
    return memory.calls.filter((value: any) => ['create', 'index'].includes(value.method));
}
function searchResponse(ids: string[]): any {
    return {timed_out: false, _shards: {total: 1, successful: 1, failed: 0},
        hits: {hits: ids.map(id => ({_source: {bundle_id: id}, sort: [id]}))}};
}

describe('source admission and complete grouped transaction preparation', () => {
    it('scopes schema-2 history plans to each retained input context while preserving legacy plans', async () => {
        const {store, source, sourceId} = await retained();
        const legacy = await store.admit(sourceId, target);
        const legacyPlan = await store.journal.readPlan(legacy.planId!);
        expect(Object.hasOwn(legacyPlan.plan.source, 'retainedSourceId')).toBe(false);
        const first: RetainedActionSource = {...source, schemaVersion: 2};
        const firstId = await store.retainSource(first), admittedFirst = await store.admit(firstId, target);
        const nextIngress = await store.retainIngress({schemaVersion: 1, chainId: hex('1'), protocolId: 'antelope',
            profileId: 'antelope-default-v1', readerSessionId: 'reader-session-2', components: [], schemaJson: source.schemaJson,
            frameHex: source.frameHex, captureSha256: source.captureSha256});
        const secondId = await store.retainSource({...first, ingressId: nextIngress});
        const admittedSecond = await store.admit(secondId, target);
        expect(admittedFirst.planId).not.toBe(admittedSecond.planId);
        expect((await store.journal.readPlan(admittedFirst.planId!)).plan.source).toMatchObject({retainedSourceId: firstId});
        expect((await store.journal.readPlan(admittedSecond.planId!)).plan.source).toMatchObject({retainedSourceId: secondId});
        expect((await store.resolve(legacy.id)).planId).toBe(legacy.planId);
        expect((await store.admit(sourceId, target)).planId).toBe(legacy.planId);
        expect((await store.resolve(admittedFirst.id)).planId).toBe(admittedFirst.planId);
        expect((await store.resolve(admittedSecond.id)).planId).toBe(admittedSecond.planId);
    });
    it('re-derives actual source inventory, persists both groups and seals after restart', async () => {
        const {memory, store, sourceId, admission, inventory, payload} = await admitted();
        expect(inventory.transactions[0].groups.map(value => value.actionOrdinals)).toEqual([[1, 2], [3]]);
        expect(await store.trySeal(admission)).toBe(false);
        const prepared = await store.prepareTransaction(admission, 0, payload!, outputs());
        expect(prepared.actions.map((value: any) => value.global_sequence)).toEqual(['101', '103']);
        expect(Object.isFrozen(prepared.actions)).toBe(true);
        expect(Object.isFrozen((prepared.actions[0] as any).act.data)).toBe(true);
        const restarted = new ActionSourceAdmissionStore(memory.client as any, 'fixture', 1);
        const reopened = await restarted.admit(sourceId, target); expect(reopened.id).toBe(admission.id);
        expect(await restarted.trySeal(reopened)).toBe(true);
        const sealed = await restarted.journal.readManifest(reopened.planId!);
        expect(sealed.manifest.fragments.map(value => value.effects.map(effect => effect.globalSequence))).toEqual([['101', '103']]);
        for (const call of writes(memory)) {
            expect(call.request.wait_for_active_shards).toBe('all'); expect(call.request.pipeline).toBe('_none');
        }
        expect(memory.calls.some((call: any) => call.method === 'index')).toBe(true);
    });
    it('rejects missing/subset/duplicated/wrong metadata and dispatch bytes before any fragment', async () => {
        const {memory, store, admission, payload} = await admitted();
        const invalid: any[][] = [[], outputs().slice(0, 1), [outputs()[0], outputs()[0]], outputs().reverse()];
        for (const mutate of [(value: any[]) => {value[1].block_id = hex('7');}, (value: any[]) => {value[1].trx_id = emptyTx;},
            (value: any[]) => {value[0].receipts.pop();}, (value: any[]) => {value[0].act.name = 'wrong';},
            (value: any[]) => {value[0].global_sequence = 101;}]) {const value = outputs(); mutate(value); invalid.push(value);}
        for (const value of invalid) {
            await expect(store.prepareTransaction(admission, 0, payload!, value)).rejects.toThrow();
            expect(manifests(memory, store.journal.index, 'h45actionfragment1:')).toEqual([]);
        }
        await expect(store.prepareTransaction(admission, 0, Buffer.from('{}'), outputs())).rejects.toThrow('dispatch/source');
        await expect(store.prepareTransaction(admission, 99, payload!, outputs())).rejects.toThrow('dispatch/source');
        expect(manifests(memory, store.journal.index, 'h45actionfragment1:')).toEqual([]);
        expect(await store.trySeal(admission)).toBe(false);
    });
    it('keeps malformed/missing/failed source incomplete and explicit source emptiness distinct', async () => {
        for (const change of [(value: any) => {value.traces = null;}, (value: any) => {delete value.traces;},
            (value: any) => {value.traces[0][1].status = 1;}, (value: any) => {value.traces[0][1].action_traces = null;}]) {
            const value = clone(input()); change(value); const {memory, store, sourceId} = await retained(value);
            const admission = await store.admit(sourceId, target);
            expect(admission.planId).toBeNull(); expect(admission.incomplete).toBeTruthy();
            expect(await store.trySeal(admission)).toBe(false);
            expect(manifests(memory, store.journal.index, 'h45actionplan1:')).toEqual([]);
            expect((await store.resolve(admission.id)).incomplete).toBe(admission.incomplete);
        }
        const value = {...input(), traces: []}, {store, sourceId} = await retained(value);
        const empty = await store.admit(sourceId, target); expect(empty.planId).toBeTruthy(); expect(empty.incomplete).toBeNull();
        expect(await store.trySeal(empty)).toBe(true);
        expect((await store.journal.readManifest(empty.planId!)).manifest.fragments).toEqual([]);
    });
    it('cannot turn an incomplete source into an empty seal by substituting another admission plan', async () => {
        const value: any = input(); value.traces = null;
        const {store, source, sourceId} = await retained(value), incomplete = await store.admit(sourceId, target);
        const emptySource = clone(source); (emptySource.inventoryInput as any).traces = [];
        const emptyId = await store.retainSource(emptySource), empty = await store.admit(emptyId, target);
        expect(empty.planId).toBeTruthy();
        expect(await store.trySeal({...incomplete, planId: empty.planId})).toBe(false);
        await expect(store.journal.readManifest(empty.planId!)).rejects.toThrow();
    });
    it('auto-records explicit empty/excluded transactions while process membership remains missing', async () => {
        const value: any = input(), empty = clone(value.traces[0]); empty[1].id = emptyTx; empty[1].action_traces = [];
        value.traces.push(empty); const {store, admission, payload} = await admitted(value);
        expect(admission.inventory!.transactions.map(tx => tx.disposition)).toEqual(['process', 'no-effects']);
        expect(await store.trySeal(admission)).toBe(false);
        await store.prepareTransaction(admission, 0, payload!, outputs()); expect(await store.trySeal(admission)).toBe(true);
        expect((await store.journal.readManifest(admission.planId!)).manifest.fragments.map(value => value.effects.length)).toEqual([2, 0]);
        const excludedInput: any = input(); excludedInput.policy.actionBlacklist = ['token::*'];
        const excluded = await admitted(excludedInput); expect(excluded.admission.inventory!.transactions[0].disposition).toBe('excluded');
        expect(await excluded.store.trySeal(excluded.admission)).toBe(true);
    });
    it('retains a missing-predecessor source as incomplete without creating an empty plan', async () => {
        const {memory, store, source} = await retained(); const missing = {...source, previousBlockId: null};
        const sourceId = await store.retainSource(missing), admission = await store.admit(sourceId, target);
        expect(admission.planId).toBeNull(); expect(admission.incomplete).toContain('predecessor');
        expect(await store.trySeal(admission)).toBe(false);
        expect(manifests(memory, store.journal.index, 'h45actionplan1:')).toEqual([]);
    });
    it('fails source I/O as I/O rather than certifying an empty-incomplete plan', async () => {
        const {memory, store, sourceId} = await retained(); const outage = new Error('retained source unavailable');
        memory.faults.beforeRead = () => {throw outage;}; await expect(store.admit(sourceId, target)).rejects.toBe(outage);
        expect(manifests(memory, store.index, 'h45actionadmission1:')).toEqual([]);
    });
    it('repairs unknown and partial source receipts with fresh identical CAS writes after reopen', async () => {
        const {memory, store, source} = await retained();
        for (const mode of ['lost', 'partial']) {
            const next = clone(source); (next.inventoryInput.source as any).blockId = hash(mode);
            let failedId: string | undefined;
            memory.faults.receipt = (receipt: any, request: any) => {
                if (request.document.kind === 'manifest' && request.document.bundle_id.startsWith('h45actionsource1:')) {
                    failedId = request.document.bundle_id;
                    if (mode === 'lost') throw new Error('simulated lost source receipt after write');
                    return {...receipt, _shards: {total: 2, successful: 1, failed: 0}};
                } return receipt;
            };
            await expect(store.retainSource(next)).rejects.toThrow(); expect(failedId).toBeTruthy();
            delete memory.faults.receipt; const before = writes(memory).length;
            const restarted = new ActionSourceAdmissionStore(memory.client as any, 'fixture', 1);
            expect(await restarted.retainSource(next)).toBe(failedId);
            expect(writes(memory).slice(before).some((value: any) => value.method === 'index' && value.request.id === failedId)).toBe(true);
        }
    });
    it('does not downgrade a partial plan receipt to source-incomplete or let GET stand in for fresh durability', async () => {
        const {memory, store, sourceId} = await retained(); let planId: string | undefined;
        memory.faults.receipt = (receipt: any, request: any) => {
            if (request.document.kind === 'manifest' && request.document.bundle_id.startsWith('h45actionplan1:')) {
                planId = request.document.bundle_id; return {...receipt, _shards: {total: 2, successful: 1, failed: 0}};
            } return receipt;
        };
        await expect(store.admit(sourceId, target)).rejects.toThrow('receipt'); expect(planId).toBeTruthy();
        expect(manifests(memory, store.index, 'h45actionadmission1:')).toEqual([]);
        delete memory.faults.receipt; const beforeRead = writes(memory).length;
        expect((await store.journal.readPlan(planId!)).id).toBe(planId); expect(writes(memory)).toHaveLength(beforeRead);
        const reopened = new ActionSourceAdmissionStore(memory.client as any, 'fixture', 1);
        expect((await reopened.admit(sourceId, target)).planId).toBe(planId);
        expect(writes(memory).slice(beforeRead).some((value: any) => value.method === 'index' && value.request.id === planId)).toBe(true);
    });
    it('detaches retained inputs and resolved views from caller mutation', async () => {
        const {memory, store, source, sourceId, ingressId} = await retained();
        (source.inventoryInput.source as any).blockNum = 999;
        const admission = await store.admit(sourceId, target); expect(admission.inventory!.source.blockNum).toBe(12);
        (admission.source.inventoryInput.source as any).blockNum = 888; (admission.target as any).uuid = 'changed';
        const reread = await store.resolve(admission.id); expect(reread.inventory!.source.blockNum).toBe(12); expect(reread.target.uuid).toBe(target.uuid);
        const ingress = await store.resolveIngress(ingressId); ingress.frameHex = 'ffff';
        expect((await store.resolveIngress(ingressId)).frameHex).toBe('010203');
        expect(memory.documents.size).toBeGreaterThan(0);
    });
    it('snapshots payload and all final outputs before the first awaited source read', async () => {
        const {memory, store, admission, payload} = await admitted(), entered = gate(), release = gate();
        let held = false; memory.faults.beforeRead = async () => {if (!held) {held = true; entered.release(); await release.promise;}};
        const documents = outputs(), bytes = Buffer.from(payload!), pending = store.prepareTransaction(admission, 0, bytes, documents);
        await entered.promise; bytes.fill(0); documents[0].global_sequence = '999'; documents[1].receipts.length = 0;
        release.release(); delete memory.faults.beforeRead;
        const prepared = await pending; expect(prepared.actions.map((value: any) => value.global_sequence)).toEqual(['101', '103']);
    });
    it('cancels a prepared transaction after source reads without releasing a fragment', async () => {
        const {memory, store, admission, payload} = await admitted(), controller = new AbortController(), reason = new Error('cancel source read');
        let first = true; memory.faults.beforeRead = () => {if (first) {first = false; controller.abort(reason);}};
        await expect(store.prepareTransaction(admission, 0, payload!, outputs(), controller.signal)).rejects.toBe(reason);
        expect(manifests(memory, store.journal.index, 'h45actionfragment1:')).toEqual([]);
        delete memory.faults.beforeRead;
        expect((await store.prepareTransaction(admission, 0, payload!, outputs())).actions).toHaveLength(2);
    });
    it('limits concurrent retained-source work and releases the budget after rejection', async () => {
        const {memory, store, admission} = await admitted(), entered = gate(), release = gate(); let calls = 0;
        memory.faults.beforeRead = async () => {if (++calls === 4) entered.release(); await release.promise;};
        const pending = Array.from({length: 4}, () => store.resolve(admission.id));
        await entered.promise; await expect(store.resolve(admission.id)).rejects.toThrow('budget');
        delete memory.faults.beforeRead; release.release(); await Promise.all(pending);
        expect((await store.resolve(admission.id)).id).toBe(admission.id);
    });
    it('discovers retained sources before/after incomplete admission with a bounded resumable query', async () => {
        const value: any = input(); value.traces = null; const {memory, store, sourceId} = await retained(value);
        const requests: any[] = [];
        (memory.client as any).search = async (request: any, options: any) => {
            requests.push({request, signal: options.signal});
            const ids = manifests(memory, store.index, 'h45actionsource1:').map((value: any) => value.bundle_id).sort();
            return searchResponse(ids.filter(id => !request.search_after || id > request.search_after[0]).slice(0, request.size));
        };
        const signal = new AbortController().signal;
        expect((await store.discoverSources(undefined, signal)).ids).toEqual([sourceId]);
        expect(manifests(memory, store.index, 'h45actionadmission1:')).toEqual([]);
        await store.admit(sourceId, target); expect((await store.discoverSources()).ids).toEqual([sourceId]);
        expect(requests[0].request).toEqual({index: store.index, size: 100, track_total_hits: false,
            query: {bool: {filter: [{term: {kind: 'manifest'}}, {prefix: {bundle_id: 'h45actionsource1:'}}]}},
            sort: [{bundle_id: 'asc'}], _source: ['bundle_id']}); expect(requests[0].signal).toBe(signal);
        expect((await store.discoverSources(sourceId)).ids).toEqual([]);
        const ids = Array.from({length: 100}, (_, index) => 'h45actionsource1:' + index.toString(16).padStart(64, '0'));
        (memory.client as any).search = async () => searchResponse(ids);
        expect(await store.discoverSources()).toEqual({ids, after: ids.at(-1)});
    });
    it('fences discovery cancellation before dispatch and after a delayed response', async () => {
        const {memory, store} = fixture(); let calls = 0;
        const controller = new AbortController(), reason = new Error('cancel discovery'); controller.abort(reason);
        (memory.client as any).search = async () => {calls++; return searchResponse([]);};
        await expect(store.discoverSources(undefined, controller.signal)).rejects.toBe(reason); expect(calls).toBe(0);
        const during = new AbortController(); (memory.client as any).search = async () => {calls++; during.abort(reason); return searchResponse([]);};
        await expect(store.discoverSources(undefined, during.signal)).rejects.toBe(reason); expect(calls).toBe(1);
    });
    it('rejects incomplete, unordered, repeated, foreign and oversized discovery responses', async () => {
        const {memory, store} = fixture();
        const ids = ['h45actionsource1:' + hex('1'), 'h45actionsource1:' + hex('2')];
        for (const mutate of [(value: any) => {value.timed_out = true;}, (value: any) => {value.terminated_early = true;},
            (value: any) => {value._shards.failed = 1;}, (value: any) => {value._shards.successful = 0;},
            (value: any) => {value.hits.hits.reverse();}, (value: any) => {value.hits.hits[1] = value.hits.hits[0];},
            (value: any) => {value.hits.hits[0]._source.bundle_id = 'foreign';}]) {
            const response = searchResponse(ids); mutate(response); (memory.client as any).search = async () => response;
            await expect(store.discoverSources()).rejects.toThrow();
        }
        (memory.client as any).search = async () => searchResponse(ids);
        await expect(store.discoverSources(ids[0])).rejects.toThrow('discovery response');
        (memory.client as any).search = async () => searchResponse(Array.from({length: 101}, (_, index) =>
            'h45actionsource1:' + index.toString(16).padStart(64, '0')));
        await expect(store.discoverSources()).rejects.toThrow();
    });
});
