import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateContextualWorkerJob} from '../../scripts/qualification/projection-contextual-worker.mjs';

const run = 'a'.repeat(32), backendId = `fixture-contextual-${run}`;
const definition = {schemaVersion: 2, id: 'fixture', mappingRevision: 'a'.repeat(64),
    source: {contract: 'token', table: 'items', abiDeployment: 'deployment', abiSha256: 'b'.repeat(64)},
    fields: [{name: 'created', type: 'string', source: {kind: 'context', field: 'blockNum', format: 'decimal'}}],
    initialization: {kind: 'genesis'}, preserveOnReplace: ['created'], onAbsent: 'incomplete'};
const binding = {chainId: 'c'.repeat(64), backendId, projectionId: definition.id, mappingRevision: definition.mappingRevision,
    abiDeployment: definition.source.abiDeployment, abiSha256: definition.source.abiSha256, generation: 'fixture-instance'};
const job = () => ({schemaVersion: 1, run, uri: 'mongodb://127.0.0.1:34567/?directConnection=true',
    databaseName: `hyp_context_${run}`, backendId, collectionPrefix: 'h45_contextual', definition, binding,
    request: {revision: 'd'.repeat(64), batch: {binding,
        previous: {blockNum: 0, blockId: '0'.repeat(64)}, block: {blockNum: 1, blockId: '1'.repeat(64), previousBlockId: '0'.repeat(64)},
        source: {contract: 'token', table: 'items', blockTimeMs: 1000},
        policy: {preserveOnReplace: ['created'], onAbsent: 'incomplete'},
        mutations: [{kind: 'put-preserving', key: 'one', value: {created: '1'}, preserveFields: ['created']}]}}});

test('the contextual crash worker accepts only a bounded pinned own-fixture job before any connection', () => {
    const input = job(); const captured = validateContextualWorkerJob(input);
    input.request.batch.mutations[0].value.created = 'changed'; assert.equal(captured.request.batch.mutations[0].value.created, '1');
    for (const mutate of [value => {value.uri = 'mongodb://example.com:34567/?directConnection=true';},
        value => {value.uri = 'mongodb://127.0.0.1:27017/?directConnection=true';},
        value => {value.uri += '&directConnection=true';}, value => {value.uri = value.uri.replace('127.0.0.1', 'user:password@127.0.0.1');},
        value => {value.databaseName = 'another-database';}, value => {value.collectionPrefix = 'live';},
        value => {value.run = '../escape';}, value => {value.backendId = 'live';},
        value => {delete value.request.revision;}, value => {delete value.request.batch.source.blockTimeMs;},
        value => {value.request.batch.policy.preserveOnReplace = [];}, value => {value.request.batch.source.contract = 'foreign';},
        value => {value.request.batch.mutations[0].kind = 'put';}, value => {value.hook = 'code';}]) {
        const value = structuredClone(job()); mutate(value); assert.throws(() => validateContextualWorkerJob(value));
    }
    const accessor = job(); let calls = 0;
    Object.defineProperty(accessor, 'uri', {enumerable: true, get() {calls++; return 'mongodb://127.0.0.1:34567/';}});
    assert.throws(() => validateContextualWorkerJob(accessor)); assert.equal(calls, 0);
});

function runReplyControl(scenario) {
    const temporary = mkdtempSync(join(tmpdir(), 'h45-contextual-reply-'));
    assert.equal(resolve(dirname(temporary)), resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith('h45-contextual-reply-'));
    try {
        const input = JSON.stringify(job()), filename = join(temporary, 'job.json');
        writeFileSync(filename, input);
        const result = spawnSync(process.execPath, ['--import',
            new URL('./fixtures/contextual-worker-driver.mjs', import.meta.url).href,
            fileURLToPath(new URL('../../scripts/qualification/projection-contextual-worker.mjs', import.meta.url))],
        {input, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
            env: {...process.env, H45_CONTEXTUAL_REPLY_JOB: filename, H45_CONTEXTUAL_REPLY_SCENARIO: scenario}});
        assert.ifError(result.error);
        assert.equal(result.signal, null, result.stderr);
        const lines = result.stderr.trim().split('\n').filter(Boolean);
        assert.ok(lines.every(line => line.startsWith('{')), result.stderr);
        return {status: result.status, stdout: result.stdout, stderr: lines.map(line => JSON.parse(line))};
    } finally {rmSync(temporary, {recursive: true, force: true});}
}

test('a write-concern error reaches the original worker error path and cleanup without a durable crash receipt', () => {
    const result = runReplyControl('write-concern-error');
    assert.equal(result.status, 1, JSON.stringify(result));
    assert.equal(result.stdout, '');
    assert.deepEqual(result.stderr, [{control: 'commandStarted'}, {control: 'commandSucceeded'},
        {control: 'connection-checked-in'},
        {control: {driverRejected: 'MongoWriteConcernError', code: 64, message: 'Fixture majority unavailable'}},
        {control: 'client-close'}, {error: 'Fixture majority unavailable', code: 64}]);
});

test('successful replies still crash before the original driver promise settles or cleanup runs', () => {
    for (const scenario of ['success', 'empty-write-errors']) {
        const result = runReplyControl(scenario);
        assert.equal(result.status, 86, JSON.stringify(result));
        const receipt = JSON.parse(result.stdout);
        assert.ok(Number.isSafeInteger(receipt.pid) && receipt.pid > 0);
        delete receipt.pid;
        assert.deepEqual(receipt, {boundary: 'durable-contextual-intent-before-transaction',
            revision: 'd'.repeat(64), block: job().request.batch.block,
            digest: 'c3e6fc11d82913764cf004f027f1113315c74a0296465f5c132ece6491aedb7f'});
        assert.deepEqual(result.stderr, [{control: 'commandStarted'}, {control: 'commandSucceeded'}]);
    }
});

test('writeErrors cannot issue a crash receipt even when monitoring reports commandSucceeded', () => {
    const result = runReplyControl('write-errors');
    assert.equal(result.status, 1, JSON.stringify(result));
    assert.equal(result.stdout, '');
    // FindAndModify does not classify writeErrors itself; this controlled reply must reach its caller.
    const message = 'Controlled database reply reached its caller without a crash receipt';
    assert.deepEqual(result.stderr, [{control: 'commandStarted'}, {control: 'commandSucceeded'},
        {control: 'connection-checked-in'}, {control: 'driver-command-fulfilled'},
        {control: {driverRejected: 'Error', code: null, message}}, {control: 'client-close'}, {error: message, code: null}]);
});

test('an original failed command retains its error and cleanup without any crash receipt', () => {
    const result = runReplyControl('command-error');
    assert.equal(result.status, 1, JSON.stringify(result));
    assert.equal(result.stdout, '');
    assert.deepEqual(result.stderr, [{control: 'commandStarted'}, {control: 'commandFailed'},
        {control: 'connection-checked-in'},
        {control: {driverRejected: 'MongoServerError', code: 121, message: 'Fixture command rejected'}},
        {control: 'client-close'}, {error: 'Fixture command rejected', code: 121}]);
});
