import assert from 'node:assert/strict';
import test from 'node:test';
import {argumentsFor, PLAN, verifyReadTrace} from './contract.mjs';
import {installPublicationBarrier} from './cas-barrier.mjs';
const argv = () => ['--run', '--allow-failpoints', '--database', 'h45_lists_012345abcdef', '--output', '/owned/new', '--source', 'a'.repeat(40), '--compiled-sha256', 'b'.repeat(64)];
const environment = () => ({HYPERION_OPERATOR_LIST_MONGO_URI: 'mongodb://127.0.0.1:37017/?directConnection=true&replicaSet=h45_operator_lists'});
test('native operator-list run requires explicit exact source/artifact and dedicated loopback replica admission', () => {
    const parsed = argumentsFor(argv(), environment()); assert.equal(parsed.replicaSet, 'h45_operator_lists');
    for (const value of [[], ['--validate-plan'], argv().slice(0, -2), [...argv(), '--extra']]) assert.throws(() => argumentsFor(value, environment()));
    for (const uri of ['mongodb://127.0.0.1:27017/?directConnection=true&replicaSet=h45_operator_lists',
        'mongodb://example.com:37017/?directConnection=true&replicaSet=h45_operator_lists',
        'mongodb://user:secret@127.0.0.1:37017/?directConnection=true&replicaSet=h45_operator_lists',
        'mongodb://127.0.0.1:37017/db?directConnection=true&replicaSet=h45_operator_lists',
        'mongodb://127.0.0.1:37017/?directConnection=true&replicaSet=production',
        'mongodb://127.0.0.1:37017/?directConnection=true&replicaSet=h45_operator_lists&tls=false'])
        assert.throws(() => argumentsFor(argv(), {HYPERION_OPERATOR_LIST_MONGO_URI: uri}));
});
const trace = () => [{seq: 0, client: 'bounded', phase: 'read', requestId: 1, event: 'started', command: 'find', tagged: true, lsid: 'session',
    transactional: false, txn: null, traceId: 'read-one', readConcern: 'snapshot', atClusterTime: null, batchSize: PLAN.pageSize, maxTimeMS: PLAN.operationMS},
{seq: 1, client: 'bounded', phase: 'read', requestId: 1, event: 'succeeded', cursor: '90', snapshotTime: 'timestamp', batch: 0, replyBsonBytes: 64},
{seq: 2, client: 'bounded', phase: 'read', requestId: 2, event: 'started', command: 'getMore', tagged: true, lsid: 'session',
    transactional: false, txn: null, traceId: 'read-one', readConcern: 'snapshot', atClusterTime: 'timestamp', batchSize: PLAN.pageSize, maxTimeMS: null, cursor: '90'},
{seq: 3, client: 'bounded', phase: 'read', requestId: 2, event: 'succeeded', cursor: '0', batch: 1, replyBsonBytes: 100}];
test('actual trace checker charges empty pages/exhaustion and rejects partial or false attempt receipts', () => {
    assert.equal(verifyReadTrace(trace(), 'read', {attempts: 2, maximum: 2, success: true}).attempts, 2);
    assert.throws(() => verifyReadTrace(trace(), 'read', {attempts: 1, maximum: 2, success: true}));
    assert.throws(() => verifyReadTrace(trace(), 'read', {attempts: 2, maximum: 1, success: true}));
    for (const mutate of [rows => {rows[3].cursor = '90';}, rows => {rows[2].maxTimeMS = 100;}, rows => {rows[0].readConcern = 'majority';},
        rows => {rows[2].atClusterTime = 'other';}, rows => {rows[2].lsid = 'other';}, rows => {rows[3].batch = PLAN.pageSize + 1;}, rows => {rows.splice(1, 1);},
        rows => {rows.push({seq: 4, phase: 'read', event: 'started', command: 'commitTransaction'});}]) {
        const rows = trace(); mutate(rows); assert.throws(() => verifyReadTrace(rows, 'read', {maximum: 2, success: true}));
    }
});
test('qualification CAS scheduling retains original commands/signals and restores only owned wrappers', async () => {
    const commands = [], client = {}, server = {async command(operation) {commands.push(operation.command); return {ok: 1};}};
    const topology = client.topology = {async selectServer() {return server;}}; server.topology = topology;
    const select = topology.selectServer, original = server.command, barrier = installPublicationBarrier(client, 'owned', 'two', ['left', 'right']);
    const selected = await topology.selectServer();
    const operation = (revision, signal = new AbortController().signal) => ({commandName: 'runCommand', ns: {db: 'owned'}, session: {client}, options: {signal},
        command: {update: 'bounded_ol_v1_source', updates: [{q: {revision: 'two'}, u: {revision}}]}});
    const left = operation('left'), right = operation('right'), waiting = selected.command(left);
    assert.equal(commands.length, 0); await selected.command(right); await waiting;
    assert.deepEqual(commands, [left.command, right.command]); assert.equal(barrier.arrived.size, 2);
    barrier.close(); assert.equal(topology.selectServer, select); assert.equal(server.command, original);
    const blocked = installPublicationBarrier(client, 'owned', 'two', ['left', 'right']), abort = new AbortController();
    const again = await topology.selectServer(), pending = again.command(operation('left', abort.signal)); abort.abort(new Error('original deadline'));
    await assert.rejects(pending, /original deadline/); blocked.close(); assert.equal(commands.length, 2);
});
