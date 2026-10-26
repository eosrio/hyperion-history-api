/** Native original run/root promises with controlled custody; no services or source/proof authority. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate as immediate} from 'node:timers/promises';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {installProjectionDiagnostics} from '../../scripts/qualification/portable-state-projection-diagnostics.mjs';
import {installWorkerFailureDiagnostics} from '../../scripts/qualification/worker-failure-diagnostics.mjs';

const mode = process.argv[2] ?? 'projection-and-fatal';
assert.ok(['projection-only', 'projection-and-fatal', 'sink-failure'].includes(mode));
const unhandled = []; process.on('unhandledRejection', error => {unhandled.push(error);});
const originalRun = WorkerAttemptClient.prototype.run, originals = new WeakMap();
WorkerAttemptClient.prototype.run = function(...args) {
    const promise = originalRun.apply(this, args); originals.set(this, {promise, args}); return promise;
};
function payload(kind, error, limit) {
    let reads = 0, calls = 0;
    const value = {get then() {
        reads++;
        if (kind === 'getter-throws' || kind === 'late-getter-throws' && reads > limit) throw error;
        if (['plain', 'late-getter-throws', 'native-value'].includes(kind)) return undefined;
        return (resolve, reject) => {calls++; kind === 'rejects' ? reject(error) : resolve(7);};
    }};
    return {value, counts: () => ({reads, calls})};
}
const kinds = ['resolves', 'rejects', 'getter-throws', 'plain', 'late-getter-throws', 'native-value', 'sync-throw'];
const paths = ['frame', 'initialization', 'omitted', 'foreign-handle', 'other-role'];
async function workerCase(path, kind) {
    const client = new WorkerAttemptClient({mode: 'controlled-local-only', role: path === 'other-role' ? 'ds_pool_worker' : 'projection'});
    const donor = path === 'foreign-handle' ? new WorkerAttemptClient({mode: 'controlled-local-only', role: 'projection'}) : undefined;
    const capture = () => (donor ?? client).capture({kind: path === 'initialization' ? 'projection-initialization'
        : path === 'other-role' ? 'ds-delivery' : 'projection-frame',
        receiptId: randomUUID(), payloadSha256: 'a'.repeat(64), headersSha256: 'b'.repeat(64),
        consumerId: null, publisherId: null, queue: null, deliveryTag: null});
    try {
        if (path === 'omitted') await client.run(capture(), () => 0);
        const handle = capture(), error = new Error('original operation failure'), p = payload(kind, error, 3), extra = Object.freeze({});
        let caught, result, calls = 0, receiver;
        const promise = client.run(handle, function() {
            calls++; receiver = this;
            if (kind === 'sync-throw') throw error;
            return kind === 'native-value' ? Promise.resolve(p.value) : p.value;
        }, extra);
        const original = originals.get(client);
        try {result = await promise;} catch (failure) {caught = failure;}
        return {path, kind, ...p.counts(), operationCalls: calls, receiverIsUndefined: receiver === undefined,
            samePromise: promise === original.promise, sameArguments: original.args[2] === extra,
            originalValue: result === p.value, scalar: result === 7, originalError: caught === error,
            errorAbsent: caught === undefined, foreignRejected: path === 'foreign-handle' && caught?.message === 'Unissued or foreign worker attempt handle',
            scope: (donor ?? client).describe(handle).scope.state};
    } finally {client.dispose(); donor?.dispose();}
}

let masterOriginal;
class Master {
    handleProtocolAbiCoordinatorRequest(_worker, message, ...args) {
        if (message.kind === 'sync-throw') throw message.error;
        const promise = (async () => {if (message.kind === 'native-reject') throw message.error; return message.value;})();
        masterOriginal = {promise, args}; return promise;
    }
}
const master = new Master(), worker = Object.freeze({process: {pid: 1}});
async function masterCase(operation, kind) {
    const error = new Error('original source failure'), p = payload(kind, error, 1), extra = Object.freeze({});
    let caught, result, promise, syncThrow = false;
    try {promise = master.handleProtocolAbiCoordinatorRequest(worker, {data: {operation}, kind, error, value: p.value}, extra);}
    catch (failure) {caught = failure; syncThrow = true;}
    const original = masterOriginal;
    if (!syncThrow) try {result = await promise;} catch (failure) {caught = failure;}
    return {operation, kind, ...p.counts(), syncThrow, samePromise: syncThrow || promise === original.promise,
        sameArguments: syncThrow || original.args[0] === extra, originalValue: result === p.value,
        originalError: caught === error, errorAbsent: caught === undefined};
}
const workerCases = paths.flatMap(path => kinds.map(kind => [path, kind]));
const masterKinds = ['late-getter-throws', 'plain', 'resolves', 'rejects', 'getter-throws', 'native-reject', 'sync-throw'];
const masterCases = ['open', 'other'].flatMap(operation => masterKinds.map(kind => [operation, kind]));
// The ninth open exercises the unselected parent-source path after the original eight observations.
masterCases.push(['open', 'plain'], ['open', 'late-getter-throws']);
const baselineWorker = [], baselineMaster = [];
for (const args of workerCases) baselineWorker.push(await workerCase(...args));
for (const args of masterCases) baselineMaster.push(await masterCase(...args));
const rows = [];
const diagnostics = installProjectionDiagnostics({WorkerClient: WorkerAttemptClient, Master, maximumAttempts: 1,
    record(event, value) {if (mode === 'sink-failure') throw new Error('controlled diagnostic sink'); rows.push({event, ...value});}});
let fatalFailures = 0;
if (mode !== 'projection-only') installWorkerFailureDiagnostics({WorkerClient: WorkerAttemptClient,
    emit(_event, snapshot) {snapshot();}, failed() {fatalFailures++;}});
const observedWorker = [], observedMaster = [];
for (const args of workerCases) observedWorker.push(await workerCase(...args));
for (const args of masterCases) observedMaster.push(await masterCase(...args));
await immediate(); await immediate();
assert.deepEqual(observedWorker, baselineWorker, 'Diagnostic layers must preserve original run/root result behavior');
assert.deepEqual(observedMaster, baselineMaster, 'Source diagnostics must preserve original return, promise and synchronous throw');
assert.deepEqual(unhandled, []);
// An intentionally foreign handle has no descriptor in the receiving client. The fatal observer
// must report that unavailable description; it must not borrow custody from the donor client.
const expectedForeignCaptureFailures = mode === 'projection-only' ? 0 : kinds.length;
assert.equal(fatalFailures, expectedForeignCaptureFailures);
assert.ok(baselineWorker.every(row => row.samePromise && row.sameArguments &&
    (row.path === 'foreign-handle' ? row.foreignRejected && row.scope === 'open' : row.scope === 'drained')));
assert.equal(baselineWorker.find(row => row.path === 'frame' && row.kind === 'plain').reads, 3);
assert.ok(diagnostics.snapshot().omittedAttempts > 0); assert.ok(diagnostics.snapshot().omittedSourceCalls > 0);
if (mode === 'sink-failure') assert.ok(diagnostics.snapshot().reportFailures > 0);
else {
    assert.equal(diagnostics.snapshot().reportFailures, 0);
    for (const event of ['projection_attempt_begin', 'projection_root_returned', 'projection_root_threw',
        'projection_attempt_fenced', 'projection_attempt_returned', 'projection_attempt_threw', 'projection_source_open_begin', 'projection_source_open_end'])
        assert.ok(rows.some(row => row.event === event), event);
}
console.log(JSON.stringify({passed: true, node: process.versions.node, mode, workerCases: workerCases.length,
    masterCases: masterCases.length, originalPromisesPreserved: true, baselinePlainGetterReads: 3, unhandledRejections: 0,
    expectedForeignCaptureFailures,
    controlledLocalOnly: true, productionAuthority: false, fullWorkerQualification: false}));
