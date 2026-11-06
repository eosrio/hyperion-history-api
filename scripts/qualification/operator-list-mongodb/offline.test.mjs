import assert from 'node:assert/strict';
import test from 'node:test';
import {argumentsFor, PLAN, verifyReadTrace, assertNativeCompletion, afterReadiness} from './contract.mjs';
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
test('native CI verdict retains timeout/failed terminal/open-stream and incomplete original workload failures', () => {
    const expected = 'b'.repeat(64), make = () => ({terminal: {timedOut: false, code: 0, signal: null, terminal: true, streamsClosed: true},
        native: {status: 'passed-native-only', source: {profile: PLAN.profile, compiledSha256: expected},
            cases: PLAN.cases.filter(name => name !== 'original-session-client-cleanup').map(name => ({name, status: 'passed'})),
            cleanup: {ownedDatabaseDropped: true, failpointDisabled: true, sessionsEnded: true, boundedClosed: true, adminClosed: true, noHiddenTransactionControls: true}}});
    const success = make(); assertNativeCompletion(success.terminal, success.native, expected);
    for (const mutate of [v => {v.terminal.timedOut = true;}, v => {v.terminal.code = 1;}, v => {v.terminal.signal = 'SIGKILL';},
        v => {v.terminal.terminal = false;}, v => {v.terminal.streamsClosed = false;}, v => {v.native.status = 'failed';},
        v => {v.native.source.profile = 'old-profile';}, v => {v.native.source.compiledSha256 = '0'.repeat(64);},
        v => {v.native.cases.pop();}, v => {v.native.cases[0].status = 'failed';}, v => {v.native.cleanup.failpointDisabled = false;},
        v => {v.native.cleanup.sessionsEnded = false;}, v => {v.native.cleanup.noHiddenTransactionControls = false;}]) {
        const value = make(); mutate(value); assert.throws(() => assertNativeCompletion(value.terminal, value.native, expected));
    }
});
test('recorded interruptions during either readiness wait refuse initialization/spawn while cleanup still runs', async () => {
    for (const stoppedAt of ['before', 'first', 'second', 'inspection', 'none']) {
        const events = [], original = new Error('original controller interruption'); let interrupted = stoppedAt === 'before';
        const check = () => {if (interrupted) throw original;};
        const ready = async stage => {events.push('ready-' + stage); await Promise.resolve();
            if (stoppedAt === stage) interrupted = true; events.push('closed-' + stage);};
        const run = async () => {
            try {
                await afterReadiness(check, () => ready('first'), () => events.push('initialize'));
                await afterReadiness(check, () => ready('second'), () => {
                    events.push('inspect'); if (stoppedAt === 'inspection') interrupted = true; check(); events.push('spawn'); return 'terminal';
                });
                check(); return 'passed';
            } finally {events.push('cleanup');}
        };
        if (stoppedAt === 'none') {assert.equal(await run(), 'passed'); assert.ok(events.includes('initialize') && events.includes('spawn'));}
        else {await assert.rejects(run(), error => error === original); assert.equal(events.includes('spawn'), false);
            if (stoppedAt === 'before' || stoppedAt === 'first') assert.equal(events.includes('initialize'), false);}
        assert.equal(events.at(-1), 'cleanup');
        if (stoppedAt === 'first' || stoppedAt === 'second') assert.ok(events.includes('closed-' + stoppedAt));
    }
});
