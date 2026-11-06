/** Native projection/reader IPC and original controller/source bridge; storage is controlled. */
import assert from 'node:assert/strict';
import {createProjectionManagerFixture} from './projection-manager-fixture.mjs';
import cluster from 'node:cluster';
import {registerHooks} from 'node:module';
import {mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {currentProofConsumerScope, ProofConsumerFencedError} from '../../build/indexer/protocol/proof-consumer-scope.js';
import {ProtocolAbiCoordinatorRpc} from '../../build/indexer/protocol/abi-coordinator-rpc.js';
import {installProjectionDiagnostics} from '../../scripts/qualification/portable-state-projection-diagnostics.mjs';

const stage = process.argv[2] ?? 'frame-read';
const terminalFrameLifecycle = ['frame-stop', 'frame-retire', 'frame-lost-end', 'frame-stale-end',
    'frame-retire-after-end', 'frame-drain-timeout'].includes(stage);
assert.ok(['connect', 'initialize', 'initialize-retained', 'initialize-error', 'initialize-foreign', 'initialize-mutating',
    'frame-read', 'frame-ordinary', 'frame-foreign', 'frame-copied',
    'frame-register', 'frame-reply', 'frame-control', 'diagnostic-failure', 'bounded'].includes(stage) || terminalFrameLifecycle);
const preEntry = ['frame-register', 'frame-reply'].includes(stage);
const heldStage = stage.startsWith('initialize') ? 'initialize' : stage === 'connect' ? 'connect' : 'frame-read';
const fatal = ['initialize-error', 'initialize-foreign', 'frame-ordinary', 'frame-foreign', 'frame-copied'].includes(stage);
const gate = () => {let release; const promise = new Promise(yes => {release = yes;}); return {promise, release};};
const until = async (test, message) => {
    const end = performance.now() + 5000;
    while (!test()) {assert.ok(performance.now() < end, message); await delay(5);}
};
const send = value => {if (process.connected) process.send(value, () => {});};

if (cluster.isWorker && process.env.worker_role === 'continuous_reader') {
    const rpc = new ProtocolAbiCoordinatorRpc((value, callback) => process.send(value, callback), 1000);
    process.on('message', async message => {
        if (rpc.onMessage(message)) return;
        if (message.event === 'fixture_open_source') {
            const result = await rpc.open('h45srcctx1:' + 'c'.repeat(64), 'controlled-reader-session');
            send({event: 'fixture_source_opened', result});
        }
        if (message.event === 'fixture_finish') {rpc.cancel(); process.exit(0);}
    });
    send({event: 'fixture_reader_ready'});
} else if (cluster.isWorker) {
    process.env.worker_id = String(cluster.worker.id);
    const held = gate(), retained = gate(), finish = gate(), records = [], zero = '0'.repeat(64);
    let worker, heldOnce = false, connectionCalls = 0, failedFrameScope;
    const record = kind => {
        const scope = currentProofConsumerScope(true);
        const value = {kind, scope: scope.snapshot(), pid: process.pid, parentPid: process.ppid};
        records.push(value); send({event: 'fixture_stage', ...value}); return scope;
    };
    const pause = async selected => {
        const scope = record(selected);
        if (heldStage !== selected || heldOnce) return;
        heldOnce = true;
        if (stage === 'frame-drain-timeout') void scope.operation(() => retained.promise);
        const late = stage === 'initialize-retained' ? scope.bindCallback(() => record('late-setup-effect')) : undefined;
        if (late) void scope.operation(() => retained.promise);
        scope.signal.addEventListener('abort', () => send({event: 'fixture_fenced', scope: scope.snapshot()}), {once: true});
        send({event: 'fixture_held', stage: selected, scope: scope.snapshot()});
        await held.promise;
        send({event: 'fixture_settled', stage: selected, scope: scope.snapshot()});
        if (late) {
            assert.throws(late, error => scope.ownsFenceError(error));
            send({event: 'fixture_late_setup_rejected', scope: scope.snapshot()});
        }
    };
    globalThis.__projectionControllerFixture = {async registry(options) {
        record('backend');
        await pause('initialize');
        if (stage === 'initialize-error') throw new Error('Controlled ordinary initialization failure');
        if (stage === 'initialize-foreign') throw new ProofConsumerFencedError();
        // Source reads run inside the frame attempt. As in the owner step, a failure after the attempt
        // is fenced propagates, and any other unavailable source is reported and retried.
        return {entries: new Map(), async initializeMissing() {
            const scope = currentProofConsumerScope(true);
            try {await options.source.head();}
            catch (error) {if (scope.signal.aborted) throw error; options.onError?.('items', error);}
        }};
    }};
    const workerUrl = new URL('../../build/indexer/workers/projection.js', import.meta.url).href;
    registerHooks({resolve(specifier, context, next) {
        if (context.parentURL === workerUrl && specifier === '../projection/stateful-registry.js')
            return {shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
                'export const StatefulProjectionRegistryV2={create:options=>globalThis.__projectionControllerFixture.registry(options)};')};
        return next(specifier, context);
    }});
    process.on('message', message => {
        if (message.event === 'fixture_release') held.release();
        if (message.event === 'fixture_release_retained') retained.release();
        if (message.event === 'fixture_stop') worker.onIpcMessage({event: 'stop'});
        if (message.event === 'fixture_finish') {worker.onIpcMessage({event: 'stop'}); finish.release();}
    });
    const {default: ProjectionWorker} = await import(workerUrl);
    const mongo = {async connect() {connectionCalls++; await pause('connect'); return mongo;}, async close() {send({event: 'fixture_closed'});}};
    const elastic = {indices: {
        // Assemble one controlled metadata response while preserving the original held callbacks.
        async get(request, options) {
            const mapping = await this.getMapping(request); options?.signal?.throwIfAborted();
            const settings = await this.getSettings(request); options?.signal?.throwIfAborted();
            return {[request.index]: {...mapping[request.index], ...settings[request.index]}};
        }, async getMapping({index}) {
        const scope = currentProofConsumerScope(true);
        if (['frame-ordinary', 'frame-foreign', 'frame-copied'].includes(stage)) {
            if (failedFrameScope && failedFrameScope !== scope.id) {
                send({event: 'fixture_unexpected_retry'}); await finish.promise;
            }
            failedFrameScope ??= scope.id;
        }
        await pause('frame-read');
        if (stage === 'frame-ordinary') throw new Error('Controlled database read failure during source transition');
        if (stage === 'frame-foreign') throw new ProofConsumerFencedError();
        if (stage === 'frame-copied') throw structuredClone(scope.signal.reason);
        // The original read remains physically retained. It returns before the controller may retry or exit.
        return {[index]: {mappings: {_meta: {hyperion_kind: 'protocol-abi-frontier', schema_version: 1}, dynamic: 'strict',
            properties: {schemaVersion: {type: 'integer'}, kind: {type: 'keyword'}, digest: {type: 'keyword'}, payload: {type: 'binary'}}}}};
    }, async getSettings() {record('settings'); await finish.promise; throw new Error('Controlled source has no coverage');}}};
    worker = Object.create(ProjectionWorker.prototype);
    Object.assign(worker, {chainId: '1'.repeat(64), chain: 'projection-controller-startup', conf: {
        settings: {chain: 'projection-controller-startup'}, indexer: {live_reader: true},
        features: {stateful_owner_v2: {interfaceVersion: 2, sourceInputVersion: 2, backend: {kind: 'mongodb', id: 'controlled-backend', database: 'controlled'},
            recovery: {bytes: 1024 * 1024}, api: {timeoutMs: 1000, maximumPendingProbes: 8}}}},
        protocolId: 'controlled-startup-protocol', protocolComponents: [{id: 'controlled-protocol', runtime: 'node',
            version: '0.0.0-dev.1', sourceRevision: 'c'.repeat(40), sha256: 'd'.repeat(64)}], protocolReady: Promise.resolve(),
        protocol: {profileId: 'controlled-startup-v1', verifyNativeGenesis() {}}, client: elastic,
        manager: createProjectionManagerFixture(mongo), stopped: false, statefulControllers: new Map(), probes: new Set(), profiler: {stopReporting() {}}});
    const attempts = new WorkerAttemptClient({mode: 'managed', role: 'projection', transport: process,
        timeoutMs: 500, drainTimeoutMs: 1000, retries: 0});
    if (preEntry) {
        const activeFence = attempts.fenceActiveAttempts;
        attempts.fenceActiveAttempts = function(...args) {
            const result = activeFence.apply(this, args);
            send({event: 'fixture_fenced_pre_entry', scopes: [...this.scopes.values()].map(value => ({
                attemptId: value.id, kind: value.descriptor.kind, scope: value.scope.snapshot()}))});
            return result;
        };
    }
    const diagnostics = installProjectionDiagnostics({WorkerClient: WorkerAttemptClient, maximumAttempts: stage === 'bounded' ? 1 : 16,
        record: (event, value) => {
        if (stage === 'diagnostic-failure') throw new Error('Controlled diagnostic sink failure');
        send({event: 'fixture_diagnostic', diagnostic: event, ...value});
        if (stage === 'initialize-mutating' && event === 'projection_attempt_threw')
            value.attempt.masterEnd.freshWrites.push({diagnosticOnly: true});
    }});
    process.once('exit', () => send({event: 'fixture_diagnostic_metrics', metrics: diagnostics.snapshot()}));
    const originalRun = attempts.run.bind(attempts);
    attempts.run = async (handle, operation) => {
        let operationEntered = false;
        const runOperation = preEntry ? function(...args) {operationEntered = true; return operation.apply(this, args);} : operation;
        try {return await originalRun(handle, runOperation);}
        catch (error) {
            send({event: 'fixture_failure', original: attempts.describe(handle), name: error?.name, code: error?.code,
                stack: error?.stack, connectionCalls, diagnosticMetrics: diagnostics.snapshot(),
                ...(preEntry ? {operationEntered, originalScopeFence: attempts.attempts.get(handle).scope.ownsFenceError(error)} : {})}); throw error;
        }
    };
    worker.configureWorkerAttemptLifecycle(attempts);
    await worker.run();
} else {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'hapi-projection-controller-'));
    const ends = [], messages = [], children = [], bridgeCalls = [];
    const supervisor = new WorkerAttemptSupervisor({onEnd: evidence => {
        const end = describeWorkerAttemptEnd(supervisor, evidence); ends.push(end);
        if (stage === 'frame-retire-after-end' && end.descriptor.kind === 'projection-frame') supervisor.retire(projection.child);
    }});
    let projection, reader;
    try {
        mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'config/connections.json'), '{}');
        writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'projection-controller-startup'},
            features: {}, indexer: {}, whitelists: {}, blacklists: {}}));
        process.env.CONFIG_JSON = join(directory, 'chain.json');
        const {HyperionMaster} = await import('../../build/indexer/modules/master.js');
        cluster.setupPrimary({exec: fileURLToPath(import.meta.url), args: [stage], cwd: directory, silent: true});
        const spawn = role => {
            const child = cluster.fork({CONFIG_JSON: join(directory, 'chain.json'), worker_role: role});
            const state = {child, role, exited: false, code: null, stdout: '', stderr: ''}; children.push(state);
            child.on('message', value => {assert.ok(messages.length < 256); messages.push({role, ...value});});
            child.on('exit', code => {state.exited = true; state.code = code;});
            for (const output of ['stdout', 'stderr']) child.process[output].on('data', bytes => {
                state[output] += bytes.toString(); assert.ok(state[output].length < 64 * 1024);
            });
            return state;
        };
        reader = spawn('continuous_reader'); projection = spawn('projection');
        const master = Object.create(HyperionMaster.prototype);
        Object.assign(master, {workerAttemptSupervisor: supervisor, liveReader: {wref: reader.child},
            workerMap: [{wref: reader.child, worker_role: 'continuous_reader'}],
            protocolAbiCoordinator: {async openSource(contextId, readerSessionId) {
                bridgeCalls.push({operation: 'open', contextId, readerSessionId});
                return {generation: 'controlled-generation-2', resumeFromBlock: null};
            }, async drain() {}, async revokeSource() {assert.fail('Unexpected source revocation');}}});
        reader.child.on('message', message => {
            if (message.event === 'protocol_abi_coordinator_request')
                void master.handleProtocolAbiCoordinatorRequest(reader.child, message);
        });
        const parentDiagnostics = installProjectionDiagnostics({WorkerClient: WorkerAttemptClient, Supervisor: WorkerAttemptSupervisor,
            Master: HyperionMaster, record: (diagnostic, value) => {
                assert.ok(messages.length < 256); messages.push({event: 'fixture_diagnostic', diagnostic, ...value});
            }});
        let heldRequest, heldReply, releaseOriginalFrame;
        if (preEntry) {
            const originalHandle = supervisor.handle, originalSend = projection.child.send;
            supervisor.handle = function(worker, message) {
                if (worker === projection.child && message?.event === 'worker_attempt_request'
                    && message.payload?.operation === 'register' && message.payload.descriptor?.kind === 'projection-frame' && !heldRequest) {
                    heldRequest = {worker, message};
                    if (stage === 'frame-register') return true;
                }
                return originalHandle.call(this, worker, message);
            };
            projection.child.send = function(...args) {
                const message = args[0];
                if (stage === 'frame-reply' && message?.event === 'worker_attempt_reply'
                    && message.requestId === heldRequest?.message.requestId && !heldReply) {
                    assert.equal(message.result.ok, true);
                    heldReply = {args, message}; return true;
                }
                return originalSend.apply(this, args);
            };
            releaseOriginalFrame = () => stage === 'frame-register'
                ? originalHandle.call(supervisor, heldRequest.worker, heldRequest.message)
                : originalSend.apply(projection.child, heldReply.args);
        }
        if (stage === 'frame-lost-end' || stage === 'frame-stale-end') {
            const physicalSend = projection.child.send;
            projection.child.send = function(message, ...args) {
                if (message.result?.end?.descriptor.kind === 'projection-frame') {
                    if (stage === 'frame-lost-end') {args.find(value => typeof value === 'function')?.(null); return true;}
                    message = {...message, result: {...message.result, end: {...message.result.end, epoch: 'stale-parent'}}};
                }
                return physicalSend.call(this, message, ...args);
            };
        }
        supervisor.attach(projection.child, 'projection');
        {
        await until(() => (preEntry ? stage === 'frame-register' ? !!heldRequest : !!heldReply : messages.some(value => value.event === 'fixture_held'))
            && messages.some(value => value.event === 'fixture_reader_ready'), 'real controller reaches held setup/source/registration boundary');
        const held = preEntry ? {stage, requestId: heldRequest.message.requestId, attemptId: heldRequest.message.payload.attemptId}
            : messages.find(value => value.event === 'fixture_held');
        const before = supervisor.snapshot();
        if (preEntry) assert.equal(before.active, stage === 'frame-register' ? 0 : 1);
        if (stage === 'frame-stop') projection.child.send({event: 'fixture_stop'});
        if (stage !== 'frame-control') {
            reader.child.send({event: 'fixture_open_source'});
            await until(() => messages.some(value => value.event === (preEntry ? 'fixture_fenced_pre_entry' : 'fixture_fenced'))
                && messages.some(value => value.event === 'fixture_source_opened'), 'original source-open bridge fences the held physical scope');
        }
        if (stage === 'frame-retire') supervisor.retire(projection.child);
        assert.equal(ends.length, heldStage === 'frame-read' ? 1 : 0, 'no end for the still-held original operation');
        if (preEntry) {
            const fenced = messages.find(value => value.event === 'fixture_fenced_pre_entry');
            assert.equal(fenced.scopes.length, 1);
            assert.equal(fenced.scopes[0].attemptId, held.attemptId);
            assert.equal(fenced.scopes[0].scope.state, 'fenced');
            assert.equal(fenced.scopes[0].scope.pendingOperations, 0);
            assert.equal(messages.some(value => ['recovery', 'frame-read', 'settings'].includes(value.kind)), false);
            releaseOriginalFrame();
            await until(() => messages.some(value => value.event === 'fixture_held') || projection.exited,
                'a fresh frame reaches the original source callback after pre-entry cancellation');
            assert.equal(projection.exited, false, projection.stdout + projection.stderr);
            projection.child.send({event: 'fixture_release'});
        } else projection.child.send({event: 'fixture_release'});
        if (stage === 'initialize-retained') {
            await until(() => messages.some(value => value.diagnostic === 'projection_root_threw'), 'root fails while actual retained setup remains pending');
            await delay(20);
            assert.equal(ends.length, 0); assert.equal(messages.filter(value => value.payload?.operation === 'register').length, 1);
            projection.child.send({event: 'fixture_release_retained'});
        }
        if (terminalFrameLifecycle) {
            await until(() => projection.exited, 'stopped, retired, uncertain or undrained frame must remain terminal');
            assert.equal(projection.code, 1, projection.stdout + projection.stderr); assert.equal(projection.stderr, '');
            assert.equal(messages.filter(value => value.payload?.operation === 'register').length, 2,
                'only the initialization and original frame may register');
            assert.ok(messages.filter(value => ['recovery', 'frame-read', 'settings'].includes(value.kind))
                .every(value => value.scope.id === held.scope.id));
            assert.equal(messages.some(value => ['apply', 'markIncomplete', 'settings'].includes(value.kind)), false);
            assert.equal(ends.length, 2);
            assert.equal(ends[1].status, stage === 'frame-drain-timeout' ? 'process-exited-unresolved' : 'quiescent');
            const failure = messages.find(value => value.event === 'fixture_failure'); assert.ok(failure);
            assert.equal(failure.original.masterEnd === null, ['frame-lost-end', 'frame-stale-end', 'frame-drain-timeout'].includes(stage));
            console.log(JSON.stringify({passed: true, stage, native: process.version, projectionExit: projection.code,
                originalControllerAndSource: true, originalSourceOpenBridge: true, noPostFenceEffects: true,
                rejectedFrameDeferral: true, noAdditionalFrameAttempt: true,
                controlledStorageAndCanonicalAuthority: true, fullWorkerQualification: false}));
        } else {
        await until(() => projection.exited || messages.some(value => value.kind === 'settings' || value.event === 'fixture_unexpected_retry'),
            'fenced operation settles and actual controller decides');
        assert.equal(messages.some(value => value.event === 'fixture_unexpected_retry'), false,
            'ordinary, copied and foreign errors must not authorize frame deferral');
        if (!projection.exited) {
            projection.child.send({event: 'fixture_finish'});
            await until(() => projection.exited, 'controlled successful worker stops');
        }
        const failure = messages.find(value => value.event === 'fixture_failure');
        const diagnostics = messages.filter(value => value.event === 'fixture_diagnostic');
        const observation = {stage, projectionExit: projection.code, held, before, failure,
            ends, bridgeCalls, diagnostics, parentDiagnosticMetrics: parentDiagnostics.snapshot(),
            effects: messages.filter(value => ['apply', 'markIncomplete', 'late-setup-effect'].includes(value.kind)),
            originalWorkerOutput: projection.stdout, controlledStorageAndCanonicalAuthority: true,
            fullWorkerQualification: false};
        if (process.env.HAPI_PROJECTION_REPRO_OUT) writeFileSync(process.env.HAPI_PROJECTION_REPRO_OUT, JSON.stringify(observation, null, 2), {flag: 'wx'});
        assert.equal(projection.code, fatal ? 1 : 0, 'actual projection result differs: ' + JSON.stringify(observation));
        assert.equal(observation.effects.length, 0); assert.equal(projection.stderr, '');
        assert.ok(ends.every(value => value.status === 'quiescent' && !value.acknowledgementAttempted && !value.freshWrites.length));
        assert.equal(ends.at(-1).rootResult, fatal ? 'threw' : 'returned');
        assert.equal(ends.at(-1).descriptor.kind, heldStage === 'frame-read' || !fatal ? 'projection-frame' : 'projection-initialization');
        assert.equal(new Set(ends.map(value => value.epoch)).size, 1);
        assert.equal(new Set(ends.map(value => value.incarnation)).size, 1);
        assert.equal(new Set(ends.map(value => value.attemptId)).size, ends.length);
        if (heldStage === 'frame-read') {
            assert.equal(ends[0].descriptor.kind, 'projection-initialization'); assert.equal(ends[0].rootResult, 'returned');
            if (stage === 'frame-ordinary') assert.match(failure.stack, /Controlled database read failure during source transition/);
            if (stage === 'frame-foreign') assert.equal(failure.name, 'ProofConsumerFencedError');
            if (stage === 'frame-copied') assert.equal(failure.name, 'Error');
        }
        if (preEntry) {
            assert.equal(ends.length, 3);
            assert.equal(ends[1].attemptId, held.attemptId);
            assert.deepEqual(ends[1].binding, {});
            assert.equal(failure.operationEntered, false);
            assert.equal(failure.originalScopeFence, true);
            assert.equal(failure.name, 'ProofConsumerFencedError');
            assert.match(failure.stack, /WorkerAttemptClient\.run/);
            const freshScope = ends[2].attemptId;
            assert.ok(messages.filter(value => ['recovery', 'frame-read', 'settings'].includes(value.kind))
                .every(value => value.scope.id === freshScope));
            assert.equal(diagnostics.some(value => value.diagnostic === 'projection_initialization_retry'), false);
            assert.ok(diagnostics.filter(value => value.diagnostic.startsWith('projection_root_')
                && value.attempt.descriptor.kind === 'projection-frame').every(value => value.attempt.attemptId === freshScope));
        }
        if (!fatal && stage !== 'frame-control' && heldStage !== 'frame-read') {
            assert.equal(ends.length, 3); assert.equal(ends[0].rootResult, 'threw');
            assert.equal(diagnostics.filter(value => value.diagnostic === 'projection_initialization_retry' && value.accepted).length, 1);
        }
        if (stage !== 'diagnostic-failure' && stage !== 'bounded') {
            const observedFailures = diagnostics.filter(value => value.diagnostic === 'projection_attempt_threw');
            assert.equal(observedFailures.length, stage === 'frame-control' ? 0 : 1);
            if (fatal) assert.equal(observedFailures[0].attempt.attemptId, failure.original.attemptId);
            assert.ok(observedFailures.every(value => (preEntry ? value.attempt.scope : value.scope).state === 'drained'
                && (preEntry ? value.attempt.scope : value.scope).pendingOperations === 0));
            assert.ok(observedFailures.every(value => value.lifecycle.activeFence === true && value.lifecycle.stopped === false
                && value.lifecycle.parentEpoch === value.attempt.masterEnd.epoch
                && value.lifecycle.parentIncarnation === value.attempt.masterEnd.incarnation));
            if (preEntry) assert.equal(observedFailures[0].scope, undefined);
            if (stage === 'initialize-error' || stage === 'initialize-foreign' || stage === 'frame-ordinary'
                || stage === 'frame-foreign' || stage === 'frame-copied' || preEntry) assert.equal(observedFailures[0].originalScopeFence, false);
            else if (stage !== 'frame-control') assert.equal(observedFailures[0].originalScopeFence, true);
            assert.equal(parentDiagnostics.snapshot().reportFailures, 0);
        }
        if (stage === 'initialize-retained') assert.ok(diagnostics.some(value => value.diagnostic === 'projection_root_threw' && value.scope.pendingOperations === 1));
        if (stage === 'diagnostic-failure') assert.ok(failure.diagnosticMetrics.reportFailures > 0, 'sink failure remains explicit without replacing the original fenced failure');
        if (stage === 'bounded') {
            assert.equal(failure.diagnosticMetrics.attempts, 1); assert.equal(failure.diagnosticMetrics.omittedAttempts, 1);
            assert.equal(diagnostics.some(value => value.attempt?.descriptor.kind === 'projection-frame'), false);
        }
        console.log(JSON.stringify({passed: true, stage, native: process.version, projectionExit: projection.code,
            originalControllerAndSource: true, originalSourceOpenBridge: stage !== 'frame-control',
            originalInitializationRetried: !fatal && stage !== 'frame-control' && heldStage !== 'frame-read',
            fencedFrameRecovered: !fatal && stage !== 'frame-control' && heldStage === 'frame-read',
            fencedFrameExitObserved: fatal && heldStage === 'frame-read',
            ...(preEntry ? {frameOperationEntered: failure.operationEntered, parentActiveAtFence: before.active,
                authenticFrameEndObserved: ends[1].attemptId === held.attemptId} : {}),
            noPostFenceEffects: true, controlledStorageAndCanonicalAuthority: true, fullWorkerQualification: false}));
        }
        }
    } finally {
        for (const state of children) if (!state.exited && state.child.isConnected()) state.child.send({event: 'fixture_finish'});
        for (const state of children) if (!state.exited) {
            try {await until(() => state.exited, 'owned physical child cleanup');} catch {state.child.kill('SIGKILL'); await until(() => state.exited, 'owned child exit after kill');}
        }
        supervisor.stop();
        const owned = realpathSync(directory); assert.equal(dirname(owned), realpathSync(tmpdir()));
        assert.ok(basename(owned).startsWith('hapi-projection-controller-')); rmSync(owned, {recursive: true, force: true});
    }
}
