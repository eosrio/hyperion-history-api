import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFileSync, writeFileSync} from 'node:fs';
import {release} from 'node:os';
import {MongoClient} from 'mongodb';
import {OwnedMongoFixture, MONGODB_IMAGE, MONGODB_VERSION, waitForMongo} from './projection-fixture.mjs';

const require = createRequire(import.meta.url);
const output = process.argv[2];
if (process.argv.length > 3 || output?.startsWith('mongodb:')) throw new Error('Usage: node check-projection-mongodb.mjs [output.json]');
const fixture = new OwnedMongoFixture();
const report = {schemaVersion: 1, status: 'running', createdAt: new Date().toISOString(), run: fixture.run,
    image: MONGODB_IMAGE, platform: 'linux/amd64', kernel: release(), client: require('mongodb/package.json').version,
    qualification: false, scope: 'SDK v1 genesis fixed-ABI declarative table projection; no fork rollback, live activation, Wire or launch qualification',
    checks: [], cleanup: fixture.cleanupResult};
const clients = new Set();
const trace = [];
let client;
const databaseName = `hyp_projection_${fixture.run}`;
const prefix = 'h45_fixture';
const backendId = `fixture-mongodb-${fixture.run}`;
const chainId = 'a'.repeat(64);
const genesis = {blockNum: 0, blockId: '0'.repeat(64)};
const block = number => ({blockNum: number, blockId: number.toString(16).padStart(64, '0'),
    previousBlockId: (number - 1).toString(16).padStart(64, '0')});
const definition = {
    schemaVersion: 1, id: 'fixture-portable-table', mappingRevision: 'c'.repeat(64),
    source: {contract: 'fixture.token', table: 'balances', abiDeployment: 'fixture:deployment:1', abiSha256: 'd'.repeat(64)},
    fields: [{name: 'owner', path: ['metadata', 'owner'], type: 'string'},
        {name: 'amount', path: ['balance'], type: 'integer'}, {name: 'enabled', path: ['enabled'], type: 'boolean'},
        {name: 'note', path: ['note'], type: 'null'}], initialization: {kind: 'genesis'},
};
const bindingFor = projectionId => ({chainId, backendId, projectionId, mappingRevision: definition.mappingRevision,
    abiDeployment: definition.source.abiDeployment, abiSha256: definition.source.abiSha256, generation: 'fixture-generation-1'});
const binding = bindingFor(definition.id);
const sourceRow = (owner, amount, enabled) => ({metadata: {owner}, balance: amount, enabled, note: null});
const row = (primaryKey, owner, amount, enabled) => ({contract: definition.source.contract, table: definition.source.table,
    scope: 'scope', primaryKey, abiDeployment: definition.source.abiDeployment, abiSha256: definition.source.abiSha256,
    present: true, value: sourceRow(owner, amount, enabled)});
const frame = (number, changes) => ({chainId, block: block(number), changes});
const all = {filter: [], limit: 100};
const expected = (key, owner, amount, enabled) => ({key, value: {owner, amount, enabled, note: null}});
const expectedFirst = [
    expected('["scope","10"]', 'alice', 1, true), expected('["scope","2"]', 'alice', 2, true),
    expected('["scope","a"]', 'bob', 3, false), expected('["scope","é"]', 'alice', 4, true),
    expected('["scope","\uE000"]', 'alice', 5, false), expected('["scope","😀"]', 'bob', 6, true),
];
const firstFrame = frame(1, [row('😀', 'bob', 6, true), row('\uE000', 'alice', 5, false), row('é', 'alice', 4, true),
    row('a', 'bob', 3, false), row('2', 'alice', 2, true), row('10', 'alice', 1, true)]);
const secondFrame = frame(2, [row('10', 'alice', 11, false), {...row('a', 'bob', 3, false), present: false, value: undefined}]);
// Omit absent data entirely: fixture source changes are ordinary JSON, not an undefined coercion test.
delete secondFrame.changes[1].value;
const expectedSecond = [expected('["scope","10"]', 'alice', 11, false), expectedFirst[1], ...expectedFirst.slice(3)];
const thirdFrame = frame(3, [row('2', 'carol', 33, false)]);
const fourthFrame = frame(4, [row('é', 'dora', 44, true)]);

function makeClient(uri) {
    const result = new MongoClient(uri, {appName: `h45-projection-${fixture.run}`, monitorCommands: true,
        directConnection: true, retryWrites: false, maxPoolSize: 8, serverSelectionTimeoutMS: 1500,
        connectTimeoutMS: 1500, timeoutMS: 5000});
    const outstanding = new Map();
    result.on('commandStarted', event => {
        if (!['findAndModify', 'update', 'delete', 'commitTransaction', 'abortTransaction'].includes(event.commandName)) return;
        const item = {command: event.commandName, requestId: event.requestId, phase: 'started',
            database: event.databaseName, transaction: event.command.txnNumber?.toString() ?? null};
        trace.push(item); outstanding.set(event.requestId, item);
    });
    result.on('commandSucceeded', event => {
        if (outstanding.has(event.requestId)) trace.push({command: event.commandName, requestId: event.requestId, phase: 'succeeded',
            writeErrorCodes: Array.isArray(event.reply?.writeErrors) ? event.reply.writeErrors.map(error => error.code) : []});
    });
    result.on('commandFailed', event => {
        if (outstanding.has(event.requestId)) trace.push({command: event.commandName, requestId: event.requestId,
            phase: 'failed', code: event.failure?.code ?? null});
    });
    return result;
}

async function ready(uri, options) {
    const result = await waitForMongo(() => makeClient(uri), options);
    clients.add(result);
    return result;
}

async function close(value) {
    if (!value) return;
    await value.close(); clients.delete(value);
}

async function errorCode(operation, code) {
    await assert.rejects(operation, error => error?.code === code, `Expected ${code}`);
}

function check(name, details) {
    report.checks.push({name, ...(details === undefined ? {} : {details})});
}

try {
    assert.equal(report.client, '7.2.0');
    report.source = {head: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8', cwd: new URL('../../', import.meta.url)}).trim(),
        artifacts: Object.fromEntries(['src/indexer/projection/runtime.ts', 'build/indexer/projection/runtime.js',
            'packages/backend-mongodb/src/index.ts', 'packages/backend-mongodb/dist/index.js', 'package-lock.json',
            'scripts/qualification/check-projection-mongodb.mjs', 'scripts/qualification/projection-fixture.mjs']
            .map(path => [path, createHash('sha256').update(readFileSync(new URL(`../../${path}`, import.meta.url))).digest('hex')]))};
    report.source.sdkProjectionSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.resolve('@eosrio/hyperion-sdk/projection')))).digest('hex');
    const {createMongoDbProjectionAdapter} = await import('../../packages/backend-mongodb/dist/index.js');
    const {DeclarativeProjectionRuntime} = await import('../../build/indexer/projection/runtime.js');
    const adapterFor = value => createMongoDbProjectionAdapter({client: value, databaseName, backendId,
        collectionPrefix: prefix, receiptRetention: 3, operationTimeoutMS: 5000, transactionTimeoutMS: 15_000});
    const runtimeFor = (adapter, selectedDefinition = definition, selectedBinding = binding) =>
        DeclarativeProjectionRuntime.create({adapter, definition: selectedDefinition, binding: selectedBinding, genesis});

    report.dockerKernel = fixture.command(['info', '--format', '{{.KernelVersion}}']);
    const kernel = /^(\d+)\.(\d+)\.(\d+)/.exec(report.dockerKernel);
    if (kernel && ((Number(kernel[1]) === 6 && Number(kernel[2]) >= 19) ||
        (Number(kernel[1]) === 7 && Number(kernel[2]) === 0 && Number(kernel[3]) < 14))) {
        throw new Error('MongoDB 8.0.34 refuses kernels 6.19 through 7.0.13; select a supported fixture host: https://www.mongodb.com/docs/v8.0/release-notes/8.0/');
    }
    fixture.prepare();
    const standaloneUri = fixture.start('standalone');
    let standalone = await ready(standaloneUri);
    const standaloneBuild = await standalone.db('admin').command({buildInfo: 1});
    assert.equal(standaloneBuild.version, MONGODB_VERSION);
    await errorCode(adapterFor(standalone).initialize(definition, binding, genesis), 'projection.capability-unavailable');
    assert.deepEqual(await standalone.db(databaseName).listCollections({}, {nameOnly: true}).toArray(), []);
    check('standalone refuses transaction capability before creating projection storage');
    await close(standalone); standalone = undefined;
    fixture.removeContainer('standalone');

    const replicaUri = fixture.start('replica');
    client = await ready(replicaUri);
    await close(client);
    fixture.initializeReplica();
    client = await ready(replicaUri, {primary: true, replicaSet: fixture.replicaSet});
    const buildInfo = await client.db('admin').command({buildInfo: 1});
    assert.equal(buildInfo.version, MONGODB_VERSION);
    const image = fixture.inspect('image', MONGODB_IMAGE);
    assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, 'amd64');
    report.server = {version: buildInfo.version, gitVersion: buildInfo.gitVersion, replicaSet: fixture.replicaSet,
        containerId: fixture.ownedContainer('replica').Id, imageId: image.Id, volume: fixture.volume.name};
    let adapter = adapterFor(client), runtime = await runtimeFor(adapter);
    const genesisView = await runtime.open();
    assert.deepEqual(genesisView.checkpoint, genesis);
    assert.deepEqual((await runtime.query({...all, count: {upTo: 1}})).rows, []);
    assert.deepEqual((await runtime.query({...all, count: {upTo: 1}})).count, {value: 0, exact: true});
    check('replica set initializes an empty genesis through actual runtime and native adapter');

    assert.equal((await runtime.process(firstFrame)).status, 'applied');
    const firstView = await runtime.open();
    assert.deepEqual(firstView.checkpoint, {blockNum: 1, blockId: block(1).blockId});
    assert.deepEqual((await runtime.query(all)).rows, expectedFirst);
    const firstPage = await runtime.query({filter: [], limit: 2, count: {upTo: 6}});
    assert.deepEqual(firstPage.rows, expectedFirst.slice(0, 2)); assert.equal(firstPage.nextAfterKey, '["scope","2"]');
    assert.deepEqual(firstPage.count, {value: 6, exact: true});
    const secondPage = await runtime.query({filter: [], limit: 2, afterKey: firstPage.nextAfterKey, count: {upTo: 6}});
    assert.deepEqual(secondPage.rows, expectedFirst.slice(2, 4)); assert.equal(secondPage.nextAfterKey, '["scope","é"]');
    assert.deepEqual(secondPage.count, {value: 6, exact: true});
    const lastPage = await runtime.query({filter: [], limit: 2, afterKey: secondPage.nextAfterKey});
    assert.deepEqual(lastPage.rows, expectedFirst.slice(4)); assert.equal(lastPage.nextAfterKey, undefined);
    assert.deepEqual((await runtime.query({...all, count: {upTo: 5}})).count, {value: 5, exact: false});
    assert.deepEqual((await runtime.query({filter: [{field: 'owner', op: 'eq', value: 'alice'},
        {field: 'enabled', op: 'eq', value: false}, {field: 'note', op: 'eq', value: null}], limit: 10})).rows, [expectedFirst[4]]);
    check('insert, typed equality, explicit null, binary UTF-8 keyset pages, count at cap and cap+1');

    assert.equal((await runtime.process(secondFrame)).status, 'applied');
    assert.deepEqual((await runtime.query(all)).rows, expectedSecond);
    assert.deepEqual((await runtime.query({...all, count: {upTo: 5}})).count, {value: 5, exact: true});
    assert.equal((await runtime.process(secondFrame)).status, 'duplicate');
    const oldDuplicate = await runtime.process(firstFrame);
    assert.equal(oldDuplicate.status, 'duplicate'); assert.equal(oldDuplicate.view.checkpoint.blockNum, 2);
    assert.deepEqual((await runtime.query(all)).rows, expectedSecond);
    await errorCode(runtime.query(all, firstView), 'projection.stale-view');
    const conflict = structuredClone(firstFrame); conflict.changes[0].value.balance = 999;
    await errorCode(runtime.process(conflict), 'projection.conflicting-replay');
    check('update/delete, current and old duplicate no-op, conflicting replay and stale read view');

    const otherDefinition = {...definition, id: 'fixture-unrelated-table'};
    const otherBinding = bindingFor(otherDefinition.id);
    let otherRuntime = await runtimeFor(adapter, otherDefinition, otherBinding);
    await otherRuntime.process(frame(1, [row('independent', 'operator', 777, true)]));
    const otherExpected = [expected('["scope","independent"]', 'operator', 777, true)];
    const gapDefinition = {...definition, id: 'fixture-gap-table'};
    const gapBinding = bindingFor(gapDefinition.id);
    let gapRuntime = await runtimeFor(adapter, gapDefinition, gapBinding);
    const gapFirst = frame(1, [row('gap', 'gap-owner', 1, true)]);
    const gapSecond = frame(2, [row('gap', 'gap-owner', 2, true)]);
    const gapThird = frame(3, [row('gap', 'gap-owner', 3, true)]);
    await gapRuntime.process(gapFirst);
    const gapFirstView = await gapRuntime.open();
    await errorCode(gapRuntime.process(gapThird), 'projection.source-gap');
    await errorCode(gapRuntime.open(), 'projection.incomplete');
    await errorCode(gapRuntime.query(all), 'projection.incomplete');
    await errorCode(gapRuntime.query(all, gapFirstView), 'projection.incomplete');
    assert.deepEqual((await runtime.query(all)).rows, expectedSecond);
    assert.deepEqual((await otherRuntime.query(all)).rows, otherExpected);
    check('future source gap durably fences only its own projection before any missing source is filled');
    const beforeFailure = trace.length;
    fixture.ownedContainer('replica');
    await client.db('admin').command({configureFailPoint: 'failCommand', mode: {times: 1},
        data: {failCommands: ['update'], errorCode: 121}});
    try { await errorCode(runtime.process(thirdFrame), 'projection.apply-unavailable'); }
    finally { await client.db('admin').command({configureFailPoint: 'failCommand', mode: 'off'}); }
    const failureTrace = trace.slice(beforeFailure);
    report.writeFailureTrace = failureTrace;
    const preparedAt = failureTrace.findIndex(event => event.command === 'findAndModify' && event.phase === 'succeeded');
    // MongoDB can return an acknowledged command containing a failed write; the driver then rejects the operation.
    const failedAt = failureTrace.findIndex(event => event.command === 'update' &&
        ((event.phase === 'failed' && event.code === 121) || event.writeErrorCodes?.includes(121)));
    assert.ok(preparedAt >= 0 && failedAt > preparedAt, 'Effect failure must follow successful durable intent');
    const pending = await client.db(databaseName).collection(`${prefix}_metadata`).findOne({'binding.projectionId': definition.id});
    assert.equal(pending.checkpoint.blockNum, 2); assert.equal(pending.pending.block.blockNum, 3);
    assert.match(pending.pending.digest, /^[0-9a-f]{64}$/);
    await errorCode(runtime.open(), 'projection.incomplete');
    await errorCode(runtime.query(all), 'projection.incomplete');
    await errorCode(runtime.process(firstFrame), 'projection.incomplete');
    assert.deepEqual((await otherRuntime.query(all)).rows, otherExpected);
    check('real non-transient effect failure after durable intent fences reads/replay and isolates unrelated projection', {commands: failureTrace});

    await close(client); client = undefined;
    report.restart = fixture.restart();
    client = await ready(fixture.endpoint('replica'), {primary: true, replicaSet: fixture.replicaSet});
    adapter = adapterFor(client);
    gapRuntime = await runtimeFor(adapter, gapDefinition, gapBinding);
    await errorCode(gapRuntime.open(), 'projection.incomplete');
    await errorCode(gapRuntime.query(all), 'projection.incomplete');
    const wrongPredecessor = structuredClone(gapSecond); wrongPredecessor.block.blockId = 'e'.repeat(64);
    await errorCode(gapRuntime.process(wrongPredecessor), 'projection.conflicting-replay');
    const gapCatchup = await gapRuntime.process(gapSecond);
    assert.equal(gapCatchup.status, 'applied'); assert.equal(gapCatchup.view.checkpoint.blockNum, 2);
    await errorCode(gapRuntime.query(all), 'projection.incomplete');
    const changedGap = structuredClone(gapThird); changedGap.changes[0].value.balance = 999;
    await errorCode(gapRuntime.process(changedGap), 'projection.conflicting-replay');
    const changedGapId = structuredClone(gapThird); changedGapId.block.blockId = 'f'.repeat(64);
    await errorCode(gapRuntime.process(changedGapId), 'projection.conflicting-replay');
    await errorCode(gapRuntime.query(all), 'projection.incomplete');
    assert.equal((await gapRuntime.process(gapThird)).status, 'applied');
    assert.deepEqual((await gapRuntime.query(all)).rows, [expected('["scope","gap"]', 'gap-owner', 3, true)]);
    await errorCode(gapRuntime.query(all, gapFirstView), 'projection.stale-view');
    check('server restart retains a source gap; missing input checkpoints while fenced and exact known target alone restores serving');
    await errorCode(adapter.open(binding), 'projection.incomplete');
    runtime = await runtimeFor(adapter);
    await errorCode(runtime.open(), 'projection.incomplete');
    await errorCode(runtime.query(all), 'projection.incomplete');
    await errorCode(runtime.process(firstFrame), 'projection.incomplete');
    assert.equal((await runtime.process(thirdFrame)).status, 'applied');
    const expectedThird = [expectedSecond[0], expected('["scope","2"]', 'carol', 33, false), ...expectedSecond.slice(2)];
    assert.deepEqual((await runtime.query(all)).rows, expectedThird);
    assert.equal((await runtime.process(thirdFrame)).status, 'duplicate');
    otherRuntime = await runtimeFor(adapter, otherDefinition, otherBinding);
    assert.deepEqual((await otherRuntime.query(all)).rows, otherExpected);
    check('actual server restart retains intent/data; fresh non-serving runtime resumes the exact source without duplicate effects');

    const invalid = structuredClone(fourthFrame); delete invalid.changes[0].value.metadata;
    await errorCode(runtime.process(invalid), 'projection.invalid-contract');
    const marked = await client.db(databaseName).collection(`${prefix}_metadata`).findOne({'binding.projectionId': definition.id});
    assert.equal(marked.checkpoint.blockNum, 3); assert.equal(marked.pending.block.blockNum, 4);
    assert.equal(marked.pending.digest, null); assert.equal(typeof marked.pending.reason, 'string');
    await errorCode(adapter.open(binding), 'projection.incomplete');
    assert.deepEqual((await otherRuntime.query(all)).rows, otherExpected);
    await close(client); client = undefined;
    const secondRestart = fixture.restart();
    client = await ready(fixture.endpoint('replica'), {primary: true, replicaSet: fixture.replicaSet});
    adapter = adapterFor(client);
    await errorCode(adapter.open(binding), 'projection.incomplete');
    runtime = await runtimeFor(adapter);
    await errorCode(runtime.query(all), 'projection.incomplete');
    const repaired = await runtime.process(fourthFrame);
    assert.equal(repaired.status, 'applied');
    const expectedFourth = [expectedThird[0], expectedThird[1], expected('["scope","é"]', 'dora', 44, true), ...expectedThird.slice(3)];
    assert.deepEqual((await runtime.query(all)).rows, expectedFourth);
    assert.equal((await runtime.process(fourthFrame)).status, 'duplicate');
    await errorCode(runtime.process(firstFrame), 'projection.replay-unavailable');
    otherRuntime = await runtimeFor(adapter, otherDefinition, otherBinding);
    assert.deepEqual((await otherRuntime.query(all)).rows, otherExpected);
    gapRuntime = await runtimeFor(adapter, gapDefinition, gapBinding);
    assert.deepEqual((await gapRuntime.query(all)).rows, [expected('["scope","gap"]', 'gap-owner', 3, true)]);
    check('contract failure marker survives another server restart and only matching source repair restores readiness', {restart: secondRestart});
    check('bounded replay receipt retention rejects uncovered older sources without advancing checkpoint');

    const payload = 'x'.repeat(60_000);
    const largeRows = Array.from({length: 80}, (_, index) => row(`bulk-${String(index).padStart(3, '0')}`, payload, index, true));
    await runtime.process(frame(5, largeRows.slice(0, 40)));
    await runtime.process(frame(6, largeRows.slice(40)));
    const largeExpected = largeRows.map((_, index) => expected(`["scope","bulk-${String(index).padStart(3, '0')}"]`, payload, index, true));
    const expectedLarge = [...expectedFourth.slice(0, 2), ...largeExpected, ...expectedFourth.slice(2)];
    const boundedPage = await runtime.query({filter: [], limit: 1000, count: {upTo: 85}});
    assert.ok(Buffer.byteLength(JSON.stringify(boundedPage)) <= 4 * 1024 * 1024);
    assert.ok(boundedPage.rows.length > 0 && boundedPage.rows.length < expectedLarge.length);
    assert.equal(typeof boundedPage.nextAfterKey, 'string');
    assert.deepEqual(boundedPage.count, {value: 85, exact: true});
    const continuation = await runtime.query({filter: [], limit: 1000, afterKey: boundedPage.nextAfterKey});
    assert.ok(Buffer.byteLength(JSON.stringify(continuation)) <= 4 * 1024 * 1024);
    assert.equal(continuation.nextAfterKey, undefined);
    assert.deepEqual([...boundedPage.rows, ...continuation.rows], expectedLarge);
    check('actual adapter shortens a large page at 4 MiB and resumes without omitted or repeated rows');
    report.status = 'passed';
} catch (error) {
    report.status = 'failed';
    report.error = {name: error.name, message: error.message, stack: error.stack};
    report.recentCommands = trace.slice(-128);
    report.fixtureFailure = fixture.diagnostics();
    process.exitCode = 1;
} finally {
    for (const value of clients) {
        try { await close(value); } catch (error) { report.status = 'failed'; report.clientCleanupError = error.message; process.exitCode = 1; }
    }
    try { await fixture.cleanup(); }
    catch (error) {
        report.status = 'failed'; report.cleanupError = error.message;
        report.cleanupErrors = error.errors?.map(item => item.message); process.exitCode = 1;
    }
    report.completedAt = new Date().toISOString();
    const serialized = JSON.stringify(report, null, 2) + '\n';
    if (output) writeFileSync(output, serialized);
    process.stdout.write(serialized);
}
