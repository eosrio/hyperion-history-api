import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {createWriteStream, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Long, Binary} from 'mongodb';
import {argumentsFor, PLAN} from './runner.mjs';
import {monitor, verifyReadTrace} from './trace.mjs';
import {terminalChild} from './ci.mjs';

const expected = {declarationDigest: 'a'.repeat(64), revision: 'b'.repeat(64), checkpoint: {blockNum: 1, blockId: 'c'.repeat(64)}};
const owner = {id: 'synthetic', generation: 'one'};
function events() {
    const client = new EventEmitter(), trace = [], phase = {name: 'one', expected, owner, ownerClaim: 'd'.repeat(64)};
    const detach = monitor(client, 'h45_kind_000000000001', 'bounded', () => phase, trace);
    const session = {lsid: {id: new Binary(Buffer.alloc(16, 1), 4)}, txnNumber: Long.fromNumber(3), autocommit: false};
    client.emit('commandStarted', {databaseName: 'h45_kind_000000000001', commandName: 'find', requestId: 1,
        command: {find: 'bounded_stateful_v2_metadata', ...session, startTransaction: true, readConcern: {level: 'snapshot'}}});
    client.emit('commandSucceeded', {requestId: 1, reply: {ok: 1, cursor: {id: Long.ZERO, firstBatch: [{...expected,
        owner: {identity: owner, claimDigest: 'd'.repeat(64)}, initialized: true, raw: null, pending: null, gap: null, rollback: null}]}}});
    client.emit('commandStarted', {databaseName: 'h45_kind_000000000001', commandName: 'find', requestId: 2,
        command: {find: 'bounded_stateful_v2_r_' + expected.declarationDigest, ...session, filter: {kind: 'collection'}, batchSize: 1,
            comment: {hyperion: 'stateful-complete-kind-v1', declaration: expected.declarationDigest, operation: 'kind', trace: 'synthetic'}}});
    client.emit('commandSucceeded', {requestId: 2, reply: {ok: 1, cursor: {id: Long.ZERO, firstBatch: []}}});
    return {trace, client, detach};
}
test('runner defaults to inert plan without URI, clients, files or failpoints', () => {
    assert.equal(argumentsFor([], {}), null); assert.equal(argumentsFor(['--validate-plan'], {}), null);
    assert.equal(PLAN.acceptance.publicHTTP, 'pending'); assert.equal(PLAN.acceptance.atomicParity, 'pending');
});
test('actual execution requires explicit run/failpoint authority and an owned loopback target', () => {
    const args = ['--run', '--allow-failpoints', '--database', 'h45_kind_000000000001', '--output', './new-evidence'];
    const environment = {HYPERION_COMPLETE_KIND_MONGO_URI: 'mongodb://127.0.0.1:29555/?directConnection=true&replicaSet=h45_owned'};
    assert.equal(argumentsFor(args, environment).database, args[3]);
    for (const uri of [undefined, 'mongodb://localhost:29555/?directConnection=true&replicaSet=h45_owned',
        'mongodb://127.0.0.1:27017/?directConnection=true&replicaSet=h45_owned',
        'mongodb://127.0.0.1:29555/production?directConnection=true&replicaSet=h45_owned',
        'mongodb://127.0.0.1:29555/?directConnection=true&replicaSet=h45_owned&retryReads=true'])
        assert.throws(() => argumentsFor(args, {HYPERION_COMPLETE_KIND_MONGO_URI: uri}));
    assert.throws(() => argumentsFor(args.filter(value => value !== '--allow-failpoints'), environment));
    assert.throws(() => argumentsFor(args.map(value => value === 'h45_kind_000000000001' ? 'production' : value), environment));
});
test('real-driver trace monitor links native metadata/data and estimates BSON separately', () => {
    const {trace, client, detach} = events(); const result = verifyReadTrace(trace, 'one', {attempts: 1, maximum: 1, success: true});
    assert.equal(result.dataAttempts, 1); assert.ok(result.replyBsonBytes > 0);
    assert.equal(JSON.stringify(trace).includes('firstBatch'), false);
    client.emit('commandStarted', {databaseName: 'unowned', commandName: 'find', requestId: 99, command: {find: 'secret'}});
    assert.equal(trace.length, 4); detach(); assert.equal(client.listenerCount('commandStarted'), 0);
});
test('outside bookends and a different session/transaction/client cannot authorize snapshot data', () => {
    for (const change of [row => {row.transactional = false;}, row => {row.txn = '4';},
        row => {row.lsid = 'foreign';}, row => {row.client = 'foreign';}]) {
        const {trace} = events(); change(trace[0]);
        assert.throws(() => verifyReadTrace(trace, 'one', {attempts: 1, maximum: 1, success: true}));
    }
});
test('stale metadata, ABA revision and owner rotation refuse trace acceptance', () => {
    for (const change of [meta => {meta.checkpoint.blockNum = 0;}, meta => {meta.revision = 'd'.repeat(64);},
        meta => {meta.owner.generation = 'two';}, meta => {meta.ownerClaim = 'f'.repeat(64);}, meta => {meta.gap = true;},
        meta => {meta.pending = true;}, meta => {meta.rollback = 'pending';}]) {
        const {trace} = events(); change(trace[1].metadata);
        assert.throws(() => verifyReadTrace(trace, 'one', {attempts: 1, maximum: 1, success: true}));
    }
});
test('short batch/live cursor, native limit, hidden data read and hidden retry fail independently', () => {
    for (const change of [trace => {trace[3].cursor = '9';}, trace => {trace[0].readConcern = 'majority';}, trace => {trace[2].limit = 1;},
        trace => {trace[2].tagged = false;}, trace => {trace.push({...trace[2], seq: 4, requestId: 3});}]) {
        const {trace} = events(); change(trace);
        assert.throws(() => verifyReadTrace(trace, 'one', {attempts: 1, maximum: 1, success: true}));
    }
});
test('each callback transaction requires its own native metadata check', () => {
    const {trace} = events(); trace.push({...trace[2], seq: 4, requestId: 3, txn: '4'});
    trace.push({...trace[3], seq: 5, requestId: 3});
    assert.throws(() => verifyReadTrace(trace, 'one', {attempts: 2, maximum: 2, success: true}));
});
test('CI success waits for actual child terminal and both retained log streams', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'complete-kind-terminal-'));
    try {
        const child = spawn(process.execPath, ['-e', 'process.stdout.write("native-terminal");process.stderr.write("retained-error-stream");'], {stdio: ['ignore', 'pipe', 'pipe']});
        const result = await terminalChild(child, createWriteStream(join(directory, 'stdout')), createWriteStream(join(directory, 'stderr')));
        assert.deepEqual(result, {code: 0, signal: null, timedOut: false, terminal: true, streamsClosed: true});
        assert.equal(readFileSync(join(directory, 'stdout'), 'utf8'), 'native-terminal');
        assert.equal(readFileSync(join(directory, 'stderr'), 'utf8'), 'retained-error-stream');
    } finally {rmSync(directory, {recursive: true, force: true});}
});
test('CI preserves a normal failing child terminal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'complete-kind-terminal-'));
    try {
        const child = spawn(process.execPath, ['-e', 'process.stderr.write("failed-trace");process.exitCode=7;'], {stdio: ['ignore', 'pipe', 'pipe']});
        const result = await terminalChild(child, createWriteStream(join(directory, 'stdout')), createWriteStream(join(directory, 'stderr')));
        assert.equal(result.code, 7); assert.equal(result.timedOut, false); assert.equal(result.streamsClosed, true);
        assert.equal(readFileSync(join(directory, 'stderr'), 'utf8'), 'failed-trace');
    } finally {rmSync(directory, {recursive: true, force: true});}
});
test('CI timeout and cleanup grace remain failed even when termination is orderly', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'complete-kind-terminal-'));
    try {
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);'], {stdio: ['ignore', 'pipe', 'pipe']});
        const result = await terminalChild(child, createWriteStream(join(directory, 'stdout')), createWriteStream(join(directory, 'stderr')),
            {deadlineMS: 100, graceMS: 100, terminalMS: 3000});
        assert.equal(result.timedOut, true); assert.equal(result.terminal, true); assert.equal(result.streamsClosed, true);
    } finally {rmSync(directory, {recursive: true, force: true});}
});
