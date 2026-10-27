/** Native child: actual emitted methods, no unhandled-rejection interception in the fatal case. */
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, basename} from 'node:path';
import {setImmediate as turn} from 'node:timers/promises';
import {EventEmitter} from 'node:events';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {ProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';

const [enabled, operation, mode] = process.argv.slice(2);
assert.ok(['on', 'off'].includes(enabled));
assert.ok(['run', 'bind', 'shared-root', 'shared-admission'].includes(operation));
assert.ok(['handled', 'unhandled-event', 'unhandled-fatal', 'late-handled', 'internally-handled'].includes(mode));
const previousDirectory = process.cwd(), directory = realpathSync(mkdtempSync(join(tmpdir(), 'hyperion-stage-rejection-')));
mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'config/connections.json'), '{}');
writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'stage-rejection-fixture'}, indexer: {}, features: {streaming: {enable: false}}}));
process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
process.once('exit', () => {
    process.chdir(previousDirectory);
    assert.equal(dirname(directory), realpathSync(tmpdir())); assert.ok(basename(directory).startsWith('hyperion-stage-rejection-'));
    rmSync(directory, {recursive: true, force: true});
});
const {installNativeWorkerStageTimings} = await import('../../scripts/qualification/portable-native-stage-timing.mjs');
const timing = installNativeWorkerStageTimings({enabled: enabled === 'on'});
const primary = new Error('original emitted ' + operation + ' rejection');
const descriptor = {kind: 'ds-delivery', receiptId: '11111111-1111-1111-1111-111111111111', payloadSha256: 'a'.repeat(64),
    headersSha256: 'b'.repeat(64), consumerId: '22222222-2222-2222-2222-222222222222', publisherId: null, queue: 'owned-queue', deliveryTag: 1};
let client, promise, unhandled = 0, rejectionHandled = 0, handled = 0;
const emit = extra => console.log(JSON.stringify({kind: 'qualification_rejection_control', operation, mode,
    unhandled, rejectionHandled, handled, ...extra}));
const handle = error => {assert.equal(error, primary); handled++;};
if (mode === 'unhandled-fatal') process.once('uncaughtExceptionMonitor', (error, origin) => {
    assert.equal(error, primary); assert.equal(origin, 'unhandledRejection');
    emit({fatalMonitor: true, exactError: true, snapshot: timing.snapshot()});
});
else {
    process.on('unhandledRejection', (error, observed) => {
        assert.equal(error, primary); assert.equal(observed, promise); unhandled++;
        if (mode === 'late-handled') setImmediate(() => {void promise.catch(handle);});
    });
    process.on('rejectionHandled', observed => {assert.equal(observed, promise); rejectionHandled++;});
}
if (operation === 'shared-root') {
    assert.equal(mode, 'internally-handled');
    const scope = new ProofConsumerScope('shared-root-control');
    promise = scope.run(() => {throw primary;}); assert.equal(promise, scope.root);
} else if (operation === 'shared-admission') {
    assert.equal(mode, 'internally-handled');
    const transport = new EventEmitter();
    transport.send = (_message, callback) => {callback(primary);};
    client = new WorkerAttemptClient({mode: 'managed', role: 'ds_pool_worker', transport, retries: 0});
    client.capture(descriptor); // The original accepted promise has its own handler; do not await it here.
} else {
    client = new WorkerAttemptClient({mode: 'controlled-local-only', role: 'ds_pool_worker'});
    const captured = client.capture(descriptor);
    promise = operation === 'run' ? client.run(captured, () => {throw primary;})
        : client.bind(captured, Object.defineProperty({}, 'blockNum', {enumerable: true, get() {throw primary;}}));
    if (mode === 'handled') await promise.catch(handle);
}
for (let n = 0; n < 6; n++) await turn();
const expectedUnhandled = mode === 'unhandled-event' || mode === 'late-handled' ? 1 : 0;
assert.equal(unhandled, expectedUnhandled);
assert.equal(rejectionHandled, mode === 'late-handled' ? 1 : 0);
assert.equal(handled, mode === 'handled' || mode === 'late-handled' ? 1 : 0);
emit({survived: true, snapshot: timing.snapshot()});
client?.dispose(); timing.restore();
