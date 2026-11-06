import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {refreshPortableActionCopies} from '../../scripts/qualification/portable-action-refresh.ts';
import {assertNativeQualificationRuntime} from '../../scripts/qualification/native-node-runtime.mjs';
assertNativeQualificationRuntime();

const complete = () => ({_shards: {total: 8, successful: 8, failed: 0}});
const healthy = () => ({timed_out: false, status: 'green', number_of_data_nodes: 2});
function fixture() {
    const calls = [], observations = []; let now = 0;
    const budget = Object.freeze({deadline: 60000});
    const timeout = maximum => {const remaining = Math.floor(budget.deadline - now); assert.ok(remaining > 0, 'original phase expired');
        return Math.min(maximum, remaining);};
    const client = {cluster: {health: async (request, options) => {calls.push({kind: 'health', request, options}); return healthy();}},
        indices: {refresh: async (request, options) => {calls.push({kind: 'refresh', request, options}); return complete();}}};
    const options = {client, index: 'owned-action-*', timeout, wait: work => work(),
        observe: async (kind, request, work) => {try {const response = await work(); observations.push({kind, request, response}); return response;}
            catch (error) {observations.push({kind, request, error}); throw error;}}};
    return {client, calls, observations, options, budget, advance: milliseconds => {now += milliseconds;}};
}
const assertCopies = response => {assert.ok(response._shards.total > 0); assert.equal(response._shards.failed, 0);
    assert.equal(response._shards.successful, response._shards.total);};

test('the actual driver callback forwards the original phase and records readiness before refresh', async () => {
    const source = await readFile(new URL('../../scripts/qualification/portable-state-worker.ts', import.meta.url), 'utf8');
    const start = source.indexOf('    const refreshActions = async '), end = source.indexOf('    const wait = async ', start);
    assert.ok(start > 0 && end > start);
    const callback = stripTypeScriptTypes(source.slice(start, end), {mode: 'strip'}) + '\nreturn refreshActions;';
    const f = fixture(), records = [], block = {blockNum: 1}, recovery = {checkpoint: 1};
    const driver = Function('refreshPortableActionCopies', 'es', 'chain', 'readTimeout', 'wait', 'historyDiagnostics',
        'source', 'replay', 'lastQueues', 'report', callback)(refreshPortableActionCopies, f.client, 'owned',
        (maximum, budget) => {assert.equal(budget, f.budget); return f.options.timeout(maximum);},
        async (name, work, milliseconds, budget) => {assert.equal(name, 'physical action replicas for 1');
            assert.equal(milliseconds, 60000); assert.equal(budget, f.budget); return work();},
        {observe: async (kind, context, work) => {records.push({kind, context}); return work();}},
        {records: [block]}, undefined, undefined, {lastRecovery: recovery});
    assertCopies(await driver(1, 'native-hold', f.budget));
    assert.deepEqual(records.map(value => value.kind), ['action-replica-health', 'action-refresh']);
    for (const {context} of records) {assert.equal(context.source, block); assert.equal(context.recovery, recovery);
        assert.equal(context.through, 1); assert.equal(context.phase, 'native-hold');
        assert.deepEqual(context.phaseBudget, {clock: 'performance.now', deadline: f.budget.deadline});}
});

test('actual refresh waits for replica readiness and preserves the single full-copy response', async () => {
    const f = fixture(); let ready = false, attempts = 0;
    f.options.wait = async work => {for (;;) {try {attempts++; await work(); return;} catch (error) {assert.equal(attempts, 1);
        assert.equal(f.calls.filter(value => value.kind === 'refresh').length, 0); ready = true;}}};
    f.client.cluster.health = async (request, options) => {f.calls.push({kind: 'health', request, options});
        return ready ? healthy() : {...healthy(), status: 'yellow'};};
    const original = complete(); f.client.indices.refresh = async (request, options) => {f.calls.push({kind: 'refresh', request, options});
        return ready ? original : {_shards: {total: 8, successful: 4, failed: 0}};};
    const result = await refreshPortableActionCopies(f.options); assert.equal(result, original); assertCopies(result);
    assert.equal(attempts, 2); assert.deepEqual(f.calls.map(value => value.kind), ['health', 'health', 'refresh']);
    assert.deepEqual(f.calls[0].request, {index: 'owned-action-*', wait_for_status: 'green', timeout: '5000ms'});
    assert.equal(f.calls[0].options.requestTimeout, 5000); assert.equal(f.calls[2].options.requestTimeout, 10000);
    assert.equal(f.observations[0].response.status, 'yellow'); assert.equal(f.observations[1].response.status, 'green');
    assert.equal(f.observations[2].response, original);
});

for (const [name, response] of [['timed-out', {...healthy(), timed_out: true}], ['yellow', {...healthy(), status: 'yellow'}],
    ['red', {...healthy(), status: 'red'}], ['wrong-data-count', {...healthy(), number_of_data_nodes: 1}]])
test(`invalid health refuses before refresh: ${name}`, async () => {
    const f = fixture(); f.client.cluster.health = async () => response;
    await assert.rejects(refreshPortableActionCopies(f.options));
    assert.equal(f.calls.filter(value => value.kind === 'refresh').length, 0);
    assert.equal(f.observations[0].response, response);
});

test('the original budget clamps both server and client waits without granting a new phase', async () => {
    const f = fixture(); f.advance(59000);
    f.client.cluster.health = async (request, options) => {f.calls.push({kind: 'health', request, options}); f.advance(300); return healthy();};
    await refreshPortableActionCopies(f.options);
    assert.equal(f.calls[0].request.timeout, '1000ms'); assert.equal(f.calls[0].options.requestTimeout, 1000);
    assert.equal(f.calls[1].options.requestTimeout, 700); assert.equal(f.budget.deadline, 60000);
});

for (const boundary of ['before-health', 'health-pending', 'after-wait', 'refresh-pending'])
test(`the original expired phase cannot accept late success: ${boundary}`, async () => {
    const f = fixture();
    if (boundary === 'before-health') f.advance(60000);
    if (boundary === 'health-pending') f.client.cluster.health = async () => {f.advance(60000); return healthy();};
    if (boundary === 'after-wait') f.options.wait = async work => {await work(); f.advance(60000);};
    if (boundary === 'refresh-pending') f.client.indices.refresh = async () => {f.advance(60000); return complete();};
    await assert.rejects(refreshPortableActionCopies(f.options), /original phase expired/);
    if (boundary !== 'refresh-pending') assert.equal(f.calls.filter(value => value.kind === 'refresh').length, 0);
});

for (const operation of ['health', 'wait', 'refresh'])
test(`original ${operation} rejection keeps its identity and is never retried by refresh`, async () => {
    const f = fixture(), original = new Error(`original ${operation} failure`); let attempts = 0;
    if (operation === 'wait') f.options.wait = async () => {attempts++; throw original;};
    else f.client[operation === 'health' ? 'cluster' : 'indices'][operation] = async () => {attempts++; throw original;};
    await assert.rejects(refreshPortableActionCopies(f.options), error => error === original); assert.equal(attempts, 1);
    if (operation !== 'refresh') assert.equal(f.calls.filter(value => value.kind === 'refresh').length, 0);
});

for (const [name, response] of [['partial', {_shards: {total: 8, successful: 4, failed: 0}}],
    ['failed', {_shards: {total: 8, successful: 7, failed: 1}}], ['empty', {_shards: {total: 0, successful: 0, failed: 0}}]])
test(`green health cannot replace or retry a rejected full-copy receipt: ${name}`, async () => {
    const f = fixture(); let refreshes = 0;
    f.client.indices.refresh = async () => {refreshes++; return response;};
    const result = await refreshPortableActionCopies(f.options);
    assert.equal(result, response); assert.throws(() => assertCopies(result)); assert.equal(refreshes, 1);
    assert.equal(f.observations.at(-1).response, response);
});
