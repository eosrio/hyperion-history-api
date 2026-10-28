/** Actual normal emission with the existing controlled ES transport; no engine or Wire acceptance. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

const root = process.env.HYPERION_SEAL_BUILD_ROOT ?? fileURLToPath(new URL('../..', import.meta.url));
const [{ActionSourceAdmissionStore}, {ProofConsumerScope}] = await Promise.all([
    import(pathToFileURL(resolve(root, 'build/indexer/history/action-source-admission.js')).href),
    import(pathToFileURL(resolve(root, 'build/indexer/protocol/proof-consumer-scope.js')).href)]);
const hex = value => value.repeat(64), hash = value => createHash('sha256').update(value).digest('hex');
const empty = hex('a'), transactionId = hex('b');
const source = {chainId: hex('1'), blockNum: 12, blockId: hex('2'), producer: 'producer', timestamp: '2026-10-20T00:00:00.000'};
const action = () => ({'@timestamp': source.timestamp, block_num: 12, block_id: source.blockId, producer: source.producer,
    trx_id: transactionId, action_ordinal: 1, creator_action_ordinal: 0, global_sequence: '101', act_digest: hex('e'),
    code_sequence: 1, abi_sequence: 21, cpu_usage_us: 15, net_usage_words: 2,
    act: {account: 'token', name: 'transfer', authorization: [{actor: 'alice', permission: 'active'}], data: {amount: 1.25}},
    receipts: [{receiver: 'token', global_sequence: '101', recv_sequence: '1', auth_sequence: []}]});
function inventoryInput() {
    const trace = id => ({id, status: 0, scheduled: false, failed_dtrx_trace: null, except: null, error_code: null,
        cpu_usage_us: 15, net_usage_words: 2, partial: null, action_traces: []});
    const populated = trace(transactionId);
    populated.action_traces.push(['action_trace_v0', {action_ordinal: 1, creator_action_ordinal: 0, receiver: 'token',
        receipt: ['action_receipt_v0', {receiver: 'token', act_digest: hex('e'), global_sequence: '101', recv_sequence: '1',
            auth_sequence: [], code_sequence: 1, abi_sequence: 21}],
        act: {account: 'token', name: 'transfer', authorization: [{actor: 'alice', permission: 'active'}], data: '0102'},
        context_free: false, except: null, error_code: null, elapsed: '0', console: ''}]);
    return {profileId: 'antelope-default-v1', source,
        policy: {schemaVersion: 1, parserVersion: '3.2', actionBlacklist: [], actionWhitelist: [], rootOnly: false,
            maxDepth: 0, maxInline: 0, eosioAlias: 'eosio'},
        traces: [['transaction_trace_v0', trace(empty)], ['transaction_trace_v0', populated]]};
}
function ids(fixture, prefix) {
    return [...fixture.memory.documents.values()].map(value => value.document)
        .filter(value => value.kind === 'manifest' && value.bundle_id.startsWith(prefix)).map(value => value.bundle_id);
}
const writes = calls => calls.filter(call => ['create', 'index'].includes(call.method));
function chunk(fixture, id) {
    const value = fixture.memory.documents.get(fixture.memory.key(fixture.store.journal.index, id));
    assert.equal(value.document.chunk_ids.length, 1); return value.document.chunk_ids[0];
}
async function fixture(complete = false) {
    const memory = frontierMemoryClient(1), store = new ActionSourceAdmissionStore(memory.client, 'fixture', 1);
    const frameHex = '010203', schemaJson = '{}', captureSha256 = hash(Buffer.from(frameHex, 'hex'));
    const ingressId = await store.retainIngress({schemaVersion: 1, chainId: source.chainId, protocolId: 'antelope',
        profileId: 'antelope-default-v1', readerSessionId: 'two-pass-controlled', components: [], frameHex, schemaJson, captureSha256});
    const sourceId = await store.retainSource({schemaVersion: 2, frameHex, schemaJson, captureSha256, ingressId, previousBlockId: hex('3'),
        producer: {protocolId: 'antelope', profileId: 'antelope-default-v1', codeRevision: 'f'.repeat(40), configurationSha256: hex('4'), pluginsSha256: hex('5')},
        executableSha256: hex('6'), inventoryInput: inventoryInput()});
    const admission = await store.admit(sourceId, {name: 'fixture-action-v1-000001', uuid: 'controlled-target-uuid'});
    assert.equal(admission.incomplete, null);
    const value = {memory, store, admission, prefixFragment: undefined, lastFragment: undefined};
    [value.prefixFragment] = ids(value, 'h45actionfragment1:'); assert.ok(value.prefixFragment);
    value.complete = async () => {
        const dispatch = admission.inventory.transactions[1].dispatch;
        const prepared = await store.prepareTransaction(admission, 1, Buffer.from(dispatch.canonicalJson), [action()]);
        value.lastFragment = prepared.fragmentId;
    };
    if (complete) await value.complete(); return value;
}

for (const fault of ['partial', 'unknown']) test(`incomplete admission defers ${fault} prefix repair until complete membership`, async () => {
    const f = await fixture(), unknown = new Error('unknown write outcome'); let attempts = 0;
    f.memory.faults.receipt = (receipt, request) => {
        if (request.id !== f.prefixFragment) return receipt;
        attempts++;
        if (fault === 'unknown') throw unknown;
        return {...receipt, _shards: {total: 2, successful: 1, failed: 1}};
    };
    const before = f.memory.calls.length;
    assert.equal(await f.store.trySeal(f.admission), false);
    assert.equal(attempts, 0); assert.equal(writes(f.memory.calls.slice(before)).length, 0);
    assert.deepEqual(ids(f, 'h45actionseal1:'), []);
    await f.complete();
    await assert.rejects(f.store.trySeal(f.admission), fault === 'unknown' ? error => error === unknown : /durable write receipt/);
    assert.ok(attempts > 0); assert.deepEqual(ids(f, 'h45actionseal1:'), []);
    delete f.memory.faults.receipt;
    assert.equal(await f.store.trySeal(f.admission), true);
    const manifest = await f.store.journal.readManifest(f.admission.planId);
    assert.deepEqual(manifest.manifest.fragments.map(value => value.effects.length), [0, 1]);
});

test('complete sealing refreshes every reference before publishing manifest then seal', async () => {
    const f = await fixture(true), before = f.memory.calls.length;
    const links = ids(f, 'h45actiontx1:'), fragments = ids(f, 'h45actionfragment1:');
    assert.equal(await f.store.trySeal(f.admission), true);
    const calls = writes(f.memory.calls.slice(before)), refreshed = calls.filter(call => call.method === 'index').map(call => call.request.id);
    for (const id of [f.admission.planId, ...fragments, ...links]) assert.ok(refreshed.includes(id), `Missing fresh reference ${id}`);
    for (const link of links) {
        const payload = f.memory.documents.get(f.memory.key(f.store.journal.index, chunk(f, link))).document.payload;
        const record = JSON.parse(Buffer.from(payload, 'base64').toString());
        assert.ok(refreshed.indexOf(record.fragmentId) < refreshed.indexOf(link));
    }
    const manifest = calls.findIndex(call => call.request.id.startsWith('h45actionmanifest1:'));
    const seal = calls.findIndex(call => call.request.id.startsWith('h45actionseal1:'));
    assert.ok(manifest >= 0 && manifest < seal);
    assert.ok(calls.every(call => call.request.wait_for_active_shards === 'all' && call.request.pipeline === '_none'));
});

for (const mutation of ['corrupt', 'delete']) test(`fresh prepare handles ${mutation} between complete read and publication`, async () => {
    const f = await fixture(true), last = chunk(f, f.lastFragment), target = chunk(f, f.prefixFragment);
    let readComplete = false, changed = false;
    f.memory.faults.read = (receipt, request) => {if (request.id === last) readComplete = true; return receipt;};
    f.memory.faults.beforeWrite = () => {
        if (changed) return;
        assert.ok(readComplete, 'A candidate must be complete before fresh sealing writes'); changed = true;
        if (mutation === 'delete') f.memory.documents.delete(f.memory.key(f.store.journal.index, target));
        else f.memory.documents.get(f.memory.key(f.store.journal.index, target)).document.payload = 'AA==';
    };
    if (mutation === 'corrupt') {
        await assert.rejects(f.store.trySeal(f.admission), /conflict/);
        assert.deepEqual(ids(f, 'h45actionseal1:'), []);
    } else {
        assert.equal(await f.store.trySeal(f.admission), true);
        assert.deepEqual((await f.store.journal.readManifest(f.admission.planId)).manifest.fragments.map(value => value.effects.length), [0, 1]);
    }
    assert.ok(changed);
});

for (const mode of ['abort', 'owner-fence']) test(`${mode} after complete read prevents writes and releases the journal slot`, async () => {
    const f = await fixture(true), last = chunk(f, f.lastFragment), controller = new AbortController();
    const scope = new ProofConsumerScope('two-pass-owner'), reason = new Error('cancel before fresh prepare');
    let readComplete = false, triggered = false;
    f.memory.faults.read = (receipt, request) => {if (request.id === last) readComplete = true; return receipt;};
    const original = f.memory.client.indices.get;
    f.memory.client.indices.get = async function (...args) {
        const result = await Reflect.apply(original, this, args);
        if (readComplete && !triggered) {triggered = true; if (mode === 'abort') controller.abort(reason); else scope.fence();}
        return result;
    };
    const before = f.memory.calls.length;
    const pending = mode === 'abort' ? f.store.journal.seal(f.admission.planId, controller.signal)
        : scope.run(() => f.store.journal.seal(f.admission.planId, scope.signal));
    await assert.rejects(pending, mode === 'abort' ? error => error === reason : /worker attempt/i);
    assert.ok(triggered); assert.equal(writes(f.memory.calls.slice(before)).length, 0);
    f.memory.client.indices.get = original; delete f.memory.faults.read;
    await scope.closeAndDrain();
    assert.equal(await f.store.trySeal(f.admission), true);
});
