/** Actual emitted source and managed frame lifecycle; original Wire bytes, in-memory ES transport. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeApiWireSource} from './protocol-native-api-source.mjs';
import {PortableProjectionSource} from '../../build/indexer/projection/source.js';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {currentProofConsumerScope, ProofConsumerFencedError} from '../../build/indexer/protocol/proof-consumer-scope.js';

const scenario = process.argv[2] ?? 'owned';
assert.ok(['owned', 'ordinary', 'foreign', 'copied'].includes(scenario));
const gate = () => {let release; const promise = new Promise(yes => {release = yes;}); return {promise, release};};
const until = async (test, message) => {
    const end = performance.now() + 10000;
    while (!test()) {assert.ok(performance.now() < end, message); await delay(5);}
};
if (cluster.isWorker) {
    const input = gate(), retained = gate();
    const send = value => {if (process.connected) process.send(value, () => {});};
    process.on('message', message => {
        if (message.event === 'release-input') input.release();
        if (message.event === 'release-retained') retained.release();
    });
    const prepared = await nativeApiWireSource({nativeMarker: false});
    const attempts = new WorkerAttemptClient({mode: 'managed', role: 'projection', transport: process,
        timeoutMs: 500, drainTimeoutMs: 2000, retries: 0});
    try {
        await prepared.appendUntil(2);
        const source = new PortableProjectionSource({client: prepared.client, chain: prepared.chain, chainId: prepared.chainId,
            profile: prepared.profile, provider: prepared.installed.provider, requireAttemptScope: true});
        const revalidate = source.revalidate.bind(source);
        let scope, thrown, callsAtFence;
        source.revalidate = async proof => {
            await revalidate(proof); // Preserve the original retained source/proof callback and its real validation.
            scope = currentProofConsumerScope(true);
            void scope.operation(() => retained.promise);
            scope.signal.addEventListener('abort', () => {
                callsAtFence = prepared.memory.calls.length;
                send({event: 'fenced', scope: scope.snapshot()});
            }, {once: true});
            send({event: 'held', scope: scope.snapshot(), blockNum: proof.source.blockNum});
            await input.promise;
            if (scenario === 'ordinary') thrown = new Error('Original revalidation callback database failure');
            else if (scenario === 'foreign') thrown = new ProofConsumerFencedError();
            else if (scenario === 'copied') thrown = structuredClone(scope.signal.reason);
            else thrown = scope.signal.reason;
            throw thrown;
        };
        const {HyperionWorker} = await import('../../build/indexer/workers/hyperionWorker.js');
        const worker = Object.create(HyperionWorker.prototype); worker.configureWorkerAttemptLifecycle(attempts);
        const definition = {schemaVersion: 1, id: 'future-items', mappingRevision: 'a'.repeat(64),
            source: {contract: 'items', table: 'items', abiDeployment: 'future-deployment', abiSha256: 'b'.repeat(64)},
            fields: [{name: 'owner', path: ['owner'], type: 'string'}], initialization: {kind: 'genesis'}};
        let error, result;
        try {
            result = await worker.runProjectionFrameAttempt({projectionId: definition.id}, async () => {
                const value = await source.frame(2, definition);
                assert.fail('A fenced source must not return a decoded/certified frame: ' + value.frame.block.blockNum);
            }, () => true);
        } catch (value) {error = value;}
        assert.equal(prepared.memory.calls.length, callsAtFence, 'no source I/O may follow the fenced callback');
        assert.equal(scope.snapshot().state, 'drained'); assert.equal(scope.snapshot().pendingOperations, 0);
        if (scenario === 'owned') {assert.equal(error, undefined); assert.equal(result, false);}
        else {assert.equal(error, thrown, 'ordinary, copied and foreign errors retain exact identity and cannot defer');}
        send({event: 'outcome', scenario, deferred: scenario === 'owned', originalErrorPreserved: scenario !== 'owned',
            noPostFenceSourceIO: true, fullWorkerQualification: false});
    } finally {attempts.dispose(); await prepared.dispose();}
    process.exit(0);
} else {
    const ends = [], messages = [];
    const supervisor = new WorkerAttemptSupervisor({onEnd: evidence => ends.push(describeWorkerAttemptEnd(supervisor, evidence))});
    cluster.setupPrimary({exec: fileURLToPath(import.meta.url), args: [scenario], silent: true});
    const worker = cluster.fork({worker_role: 'projection'}), state = {exited: false, code: null, stdout: '', stderr: ''};
    worker.on('message', value => {assert.ok(messages.length < 32); messages.push(value);});
    worker.on('exit', code => {state.exited = true; state.code = code;});
    for (const name of ['stdout', 'stderr']) worker.process[name].on('data', bytes => {
        state[name] += bytes.toString(); assert.ok(state[name].length < 64 * 1024);
    });
    supervisor.attach(worker, 'projection');
    try {
        await until(() => messages.some(value => value.event === 'held') || state.exited, 'original final source revalidation callback is held');
        assert.equal(state.exited, false, state.stdout + state.stderr);
        assert.equal(messages.find(value => value.event === 'held').blockNum, 2);
        supervisor.fenceActive(); await until(() => messages.some(value => value.event === 'fenced'), 'original parent fences the held source scope');
        worker.send({event: 'release-input'}); await delay(40);
        assert.equal(ends.length, 0, 'neither a callback rejection nor a deadline proves retained-operation drainage');
        assert.equal(messages.some(value => value.event === 'outcome'), false);
        worker.send({event: 'release-retained'});
        await until(() => state.exited, 'source error is decided only after its authentic end');
        assert.equal(state.code, 0, state.stdout + state.stderr); assert.equal(state.stderr, '');
        assert.equal(ends.length, 1); assert.equal(ends[0].status, 'quiescent'); assert.equal(ends[0].rootResult, 'threw');
        assert.equal(ends[0].descriptor.kind, 'projection-frame');
        assert.equal(ends[0].acknowledgementAttempted, false); assert.deepEqual(ends[0].freshWrites, []);
        assert.ok(messages.some(value => value.event === 'outcome'));
        console.log(JSON.stringify({passed: true, scenario, native: process.version, originalSourceAndManagedFrame: true,
            originalRevalidationCallback: true, originalWireSource: true, controlledElasticsearchTransport: true,
            authenticDrainedEnd: true, noPostFenceSourceIO: true, fullWorkerQualification: false}));
    } finally {
        if (!state.exited) {worker.kill('SIGKILL'); await until(() => state.exited, 'owned source fixture child cleanup');}
        supervisor.stop();
    }
}
