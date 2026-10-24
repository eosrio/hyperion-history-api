/** Real emitted projection worker and native cluster IPC; Mongo/controller I/O is controlled. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerHooks} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {currentProofConsumerScope, ProofConsumerFencedError, ProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';

const scenario = process.argv[2] ?? 'retry';
const successful = ['retry', 'issued-abort', 'success', 'foreign-fence', 'held-child'].includes(scenario);
assert.ok(successful || ['retire', 'disconnect', 'stop', 'lost-end', 'stale-end', 'retire-after-end', 'ordinary-error',
    'undefined-error', 'code-shaped-error', 'forged-error', 'constructed-after-fence', 'foreign-after-fence', 'exhaustion'].includes(scenario));
const activeFence = !['success', 'foreign-fence', 'forged-error', 'retire', 'disconnect'].includes(scenario);
const gate = () => {let release; const promise = new Promise(resolve => {release = resolve;}); return {promise, release};};
const until = async (test, message, milliseconds = 5000) => {
    const end = performance.now() + milliseconds;
    while (!test()) {assert.ok(performance.now() < end, message); await delay(5);}
};

if (cluster.isWorker) {
    process.env.worker_id = String(cluster.worker.id);
    const held = Array.from({length: 4}, gate), childHeld = gate(), finish = gate(), events = [];
    const traceFile = join(dirname(process.env.CONFIG_JSON), 'trace.jsonl');
    let worker, connections = 0;
    const send = value => {if (process.connected) process.send(value, () => {});};
    const trace = value => {
        assert.ok(events.length < 128); events.push(value);
        const bytes = JSON.stringify(value) + '\n'; assert.ok(bytes.length < 512);
        appendFileSync(traceFile, bytes, {flag: events.length === 1 ? 'wx' : 'a'});
        send({event: 'fixture_stage', ...value});
    };
    const record = kind => {
        try {const scope = currentProofConsumerScope(true); scope.assertActive(); trace({kind, scopeId: scope.id}); return scope;}
        catch (error) {trace({kind, rejected: true}); throw error;}
    };
    const fixture = {
        backend() {record('backend'); return {};},
        async controller() {
            record('controller');
            return {async drain() {send({event: 'fixture_initialized'}); await finish.promise;}, async stop() {}};
        },
    };
    globalThis.__projectionStartupFixture = fixture;
    const workerUrl = new URL('../../build/indexer/workers/projection.js', import.meta.url).href;
    registerHooks({resolve(specifier, context, next) {
        if (context.parentURL === workerUrl && specifier === '../projection/backend.js')
            return {shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
                'export const createPortableStateBackend=()=>globalThis.__projectionStartupFixture.backend();')};
        if (context.parentURL === workerUrl && specifier === '../projection/controller.js')
            return {shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
                'export const PortableStateController={create:options=>globalThis.__projectionStartupFixture.controller(options)};')};
        return next(specifier, context);
    }});
    process.on('message', message => {
        if (message.event === 'fixture_release') held[message.index ?? 0].release();
        if (message.event === 'fixture_release_child') childHeld.release();
        if (message.event === 'fixture_stop') worker.onIpcMessage({event: 'stop'});
        if (message.event === 'fixture_finish') {worker.onIpcMessage({event: 'stop'}); finish.release();}
    });
    process.on('disconnect', () => held.forEach(value => value.release()));
    const {default: ProjectionWorker} = await import(workerUrl);
    const definition = {schemaVersion: 1, id: 'items', mappingRevision: 'a'.repeat(64),
        source: {contract: 'items', table: 'items', abiDeployment: 'constructed-startup-epoch', abiSha256: 'b'.repeat(64)},
        fields: [{name: 'owner', path: ['owner'], type: 'string'}], initialization: {kind: 'genesis'}};
    const client = {async connect() {
        const scope = record('connect'); connections++;
        if (connections === 1 || scenario === 'exhaustion') {
            const index = connections - 1;
            if (scenario === 'held-child') void scope.operation(() => childHeld.promise);
            scope.signal.addEventListener('abort', () => send({event: 'fixture_fenced', scopeId: scope.id}), {once: true});
            send({event: 'fixture_connect_held', scopeId: scope.id}); await held[index].promise;
            trace({kind: 'connect-settled', scopeId: scope.id, state: scope.snapshot().state});
            if (scenario === 'ordinary-error') throw new Error('controlled Mongo connection failure');
            if (scenario === 'undefined-error') throw undefined;
            if (scenario === 'code-shaped-error') throw {name: 'ProofConsumerFencedError', code: 'worker_attempt_fenced'};
            if (scenario === 'forged-error' || scenario === 'constructed-after-fence') throw new ProofConsumerFencedError();
            if (scenario === 'foreign-after-fence') {
                const foreign = new ProofConsumerScope('foreign-initialization'); foreign.fence(); throw foreign.signal.reason;
            }
            if (scenario === 'issued-abort') throw scope.signal.reason;
        }
        return client;
    }, async close() {send({event: 'fixture_client_closed'});}};
    worker = Object.create(ProjectionWorker.prototype);
    Object.assign(worker, {chainId: '1'.repeat(64), chain: 'projection-startup', conf: {
        settings: {chain: 'projection-startup'}, indexer: {live_reader: true},
        features: {portable_state: {backend: {kind: 'mongodb', id: 'controlled-backend', database: 'controlled'}, projections: [definition]}}},
        protocolId: 'controlled-startup-protocol', protocolComponents: [{id: 'owned-startup-fixture', runtime: 'node',
            version: '0.0.0-dev.1', sourceRevision: 'c'.repeat(40), sha256: 'd'.repeat(64)}], protocolReady: Promise.resolve(),
        protocol: {profileId: 'controlled-startup-v1', verifyNativeGenesis() {}}, client: {},
        manager: {conn: {mongodb: {}}, mongodbClient: client}, stopped: false, profiler: {stopReporting() {}}});
    const attempts = new WorkerAttemptClient({mode: 'managed', role: 'projection', transport: process,
        timeoutMs: 500, drainTimeoutMs: 1000, retries: 0});
    const capture = attempts.capture.bind(attempts), run = attempts.run.bind(attempts);
    let previousFailure;
    attempts.capture = descriptor => {
        if (previousFailure) assert.equal(attempts.consumeProjectionInitializationRetry(previousFailure.handle, previousFailure.error), false,
            'the original initialization retry claim is consumed before the next physical root');
        return capture(descriptor);
    };
    attempts.run = async (handle, operation) => {
        try {return await run(handle, operation);}
        catch (error) {
            assert.equal(attempts.consumeProjectionInitializationRetry(structuredClone(handle), error), false);
            assert.equal(attempts.consumeProjectionInitializationRetry(attempts.describe(handle), error), false);
            assert.equal(attempts.consumeProjectionInitializationRetry(handle, new ProofConsumerFencedError()), false);
            previousFailure = {handle, error}; throw error;
        }
    };
    worker.configureWorkerAttemptLifecycle(attempts);
    const original = worker.runProjectionAttempt;
    worker.runProjectionAttempt = function(kind, metadata, operation, retry) {
        return original.call(this, kind, metadata, async () => {
            try {return await operation();}
            catch (error) {send({event: 'fixture_root_threw'}); throw error;}
        }, retry);
    };
    await worker.run();
} else {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'hapi-projection-startup-'));
    const ends = [], messages = [], state = {exited: false, code: null, signal: null, stdout: '', stderr: ''};
    let worker;
    const supervisor = new WorkerAttemptSupervisor({onEnd: evidence => {
        ends.push(describeWorkerAttemptEnd(supervisor, evidence));
        if (scenario === 'retire-after-end') supervisor.retire(worker);
    }});
    try {
        mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'config/connections.json'), '{}');
        writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'projection-startup'}, features: {},
            indexer: {}, whitelists: {}, blacklists: {}}));
        cluster.setupPrimary({exec: fileURLToPath(import.meta.url), args: [scenario], cwd: directory, silent: true});
        worker = cluster.fork({CONFIG_JSON: join(directory, 'chain.json'), worker_role: 'projection'});
        const physicalSend = worker.send.bind(worker);
        worker.send = (message, ...args) => {
            if (scenario === 'lost-end' && message.result?.end) {
                args.find(value => typeof value === 'function')?.(null); return true;
            }
            if (scenario === 'stale-end' && message.result?.end) message = {...message,
                result: {...message.result, end: {...message.result.end, epoch: 'stale-parent'}}};
            return physicalSend(message, ...args);
        };
        supervisor.attach(worker, 'projection');
        worker.on('message', message => messages.push(message));
        worker.on('exit', (code, signal) => Object.assign(state, {exited: true, code, signal}));
        for (const kind of ['stdout', 'stderr']) worker.process[kind].on('data', bytes => {
            state[kind] += bytes.toString(); assert.ok(state[kind].length <= 64 * 1024);
        });
        await until(() => messages.some(m => m.event === 'fixture_connect_held') || state.exited, 'original initialization enters held Mongo connect');
        assert.equal(state.exited, false, state.stdout + state.stderr);
        const original = messages.find(m => m.event === 'fixture_connect_held').scopeId;
        for (let index = 0; index < (scenario === 'exhaustion' ? 4 : 1); index++) {
            await until(() => messages.filter(m => m.event === 'fixture_connect_held').length > index || state.exited, 'next initialization reaches its own held setup');
            assert.equal(state.exited, false);
            const scopeId = messages.filter(m => m.event === 'fixture_connect_held')[index].scopeId;
            if (scenario === 'retire') supervisor.retire(worker);
            else if (scenario === 'disconnect') worker.disconnect();
            else if (scenario === 'foreign-fence') worker.send({event: 'worker_attempt_fence_active', epoch: 'foreign', incarnation: 'foreign'});
            else if (activeFence) {
                if (scenario === 'stop') worker.send({event: 'fixture_stop'});
                supervisor.fenceActive();
            }
            if (activeFence || scenario === 'retire') await until(() => messages.some(m => m.event === 'fixture_fenced' && m.scopeId === scopeId)
                || state.exited, 'actual parent fence reaches original scope');
            assert.equal(state.exited, false);
            assert.equal(ends.length, index, 'held physical connect prevents an authentic drained end');
            assert.equal(messages.filter(m => m.kind === 'backend' || m.kind === 'controller').length, 0);
            if (scenario !== 'disconnect') worker.send({event: 'fixture_release', index});
            if (scenario === 'held-child') {
                await until(() => messages.some(m => m.event === 'fixture_root_threw') || state.exited, 'original root throws while its physical child remains pending');
                await delay(30);
                assert.equal(ends.length, 0); assert.equal(messages.filter(m => m.payload?.operation === 'register').length, 1);
                worker.send({event: 'fixture_release_child'});
            }
        }
        await until(() => messages.some(m => m.event === 'fixture_initialized') || state.exited, 'a fresh accepted initialization completes');
        if (successful) {
            assert.equal(state.exited, false, 'Projection initialization must recover after a source fence; actual child output: ' + state.stdout + state.stderr);
            worker.send({event: 'fixture_finish'}); await until(() => state.exited, 'original projection worker exits normally after stop');
            assert.equal(state.code, 0);
            assert.equal(ends.length, activeFence ? 2 : 1); assert.equal(ends.at(-1).rootResult, 'returned');
            assert.ok(ends.every(e => e.status === 'quiescent' && e.descriptor.kind === 'projection-initialization'));
            if (activeFence) {
                assert.equal(ends[0].rootResult, 'threw');
                assert.equal(ends[0].incarnation, ends[1].incarnation); assert.equal(ends[0].epoch, ends[1].epoch);
                assert.notEqual(ends[0].attemptId, ends[1].attemptId);
            }
        } else {
            assert.equal(state.exited, true, 'terminal or uncertain initialization must not be retried'); assert.equal(state.code, 1);
            assert.equal(messages.some(m => m.event === 'fixture_initialized'), false);
            assert.equal(messages.filter(m => m.payload?.operation === 'register').length, scenario === 'exhaustion' ? 4 : 1);
        }
        assert.equal(state.signal, null); assert.equal(state.stderr, '');
        const trace = readFileSync(join(directory, 'trace.jsonl'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
        const effects = trace.filter(e => ['backend', 'controller'].includes(e.kind));
        assert.equal(effects.length, successful ? 2 : 0);
        assert.ok(effects.every(e => !e.rejected && e.scopeId === ends.at(-1).attemptId));
        if (activeFence) assert.ok(effects.every(e => e.scopeId !== original));
        console.log(JSON.stringify({passed: true, scenario, originalWorkerRecovered: successful && activeFence, physicalWorkers: 1,
            freshAcceptedInitialization: successful, postFenceOldBackendCalls: 0, capacityAuthority: false, fullWorkerQualification: false}));
    } finally {
        if (worker && !state.exited) {worker.kill('SIGKILL'); await until(() => state.exited, 'owned fixture child cleanup');}
        supervisor.stop();
        const owned = realpathSync(directory); assert.equal(dirname(owned), realpathSync(tmpdir()));
        assert.ok(basename(owned).startsWith('hapi-projection-startup-')); rmSync(owned, {recursive: true, force: true});
    }
}
