/** Actual emitted source and managed frame lifecycle; original Wire bytes, in-memory ES transport. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeApiWireSource, STATEFUL_COMPLETE_KIND_CODEC_API_SOURCE_PROFILE} from './protocol-native-api-source.mjs';
import {PortableProjectionSource} from '../../build/indexer/projection/source.js';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {currentProofConsumerScope, ProofConsumerFencedError} from '../../build/indexer/protocol/proof-consumer-scope.js';
import {PortableStateController} from '../../build/indexer/projection/controller.js';
import {resolvePortableStateConfiguration} from '../../build/indexer/projection/config.js';
import {PROJECTION_CAPABILITIES, ProjectionContractError} from '@eosrio/hyperion-sdk/projection';

const scenario = process.argv[2] ?? 'owned';
const fallback = /^fallback-(recovery|mark)-(ordinary|foreign)-(success|owned|ordinary|foreign)(-active)?$/.exec(scenario);
assert.ok(['owned', 'ordinary', 'foreign', 'copied'].includes(scenario) || fallback);
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
    const prepared = await nativeApiWireSource({nativeMarker: false, engineeringSourceProfile: STATEFUL_COMPLETE_KIND_CODEC_API_SOURCE_PROFILE});
    const attempts = new WorkerAttemptClient({mode: 'managed', role: 'projection', transport: process,
        timeoutMs: 500, drainTimeoutMs: 2000, retries: 0});
    try {
        await prepared.appendUntil(2);
        if (fallback) {
            const [, boundary, primaryKind, completion, active] = fallback;
            let primaryError, scope, checkpoint, heldOnce = false, callsAtFence;
            const effects = [], progress = [];
            const cause = () => primaryKind === 'foreign' ? new ProofConsumerFencedError() : new Error('Original primary source callback failure');
            const hold = async () => {
                scope = currentProofConsumerScope(true);
                assert.equal(scope.signal.aborted, false); assert.ok(primaryError);
                assert.equal(scope.ownsFenceError(primaryError), false);
                void scope.operation(() => retained.promise);
                scope.signal.addEventListener('abort', () => {
                    callsAtFence = {source: prepared.memory.calls.length, adapter: effects.length};
                    send({event: 'fenced', scope: scope.snapshot()});
                }, {once: true});
                send({event: 'held', scope: scope.snapshot(), blockNum: 2});
                await input.promise;
                if (completion === 'owned') throw scope.signal.reason;
                if (completion === 'ordinary') throw new Error('Original fallback callback failure');
                if (completion === 'foreign') throw new ProofConsumerFencedError();
            };
            const installed = prepared.installed.provider;
            const provider = boundary !== 'mark' ? installed : {...installed, createShipSession(schema) {
                const session = installed.createShipSession(schema);
                return {...session, decodeDeltas(bytes) {
                    session.decodeDeltas(bytes); // Original ABI-correct decode precedes the controlled primary rejection.
                    assert.equal(currentProofConsumerScope(true).signal.aborted, false); throw cause();
                }};
            }};
            if (boundary === 'recovery') {
                const original = prepared.client.indices.get.bind(prepared.client.indices);
                prepared.client.indices.get = async request => {
                    await original(request);
                    assert.equal(currentProofConsumerScope(true).signal.aborted, false); throw cause();
                };
            }
            const source = new PortableProjectionSource({client: prepared.client, chain: prepared.chain, chainId: prepared.chainId,
                profile: prepared.profile, provider, requireAttemptScope: true});
            const observedSource = {frame(...args) {
                const result = source.frame(...args);
                void result.then(() => {}, error => {primaryError = error;});
                return result; // The real controller receives the original source promise and error object.
            }, revalidate: source.revalidate.bind(source)};
            const adapter = {
                capabilities: {interfaceVersion: 1, supported: [...PROJECTION_CAPABILITIES]},
                async initialize(_definition, binding) {
                    checkpoint = {binding, initialized: true, checkpoint: {blockNum: 1, blockId: prepared.retained.get(1).source.blockId}, pending: null, gap: null};
                    return {binding, checkpoint: checkpoint.checkpoint};
                },
                async recovery() {
                    effects.push('recovery');
                    if (boundary === 'recovery' && primaryError && !heldOnce) {heldOnce = true; await hold();}
                    return structuredClone(checkpoint);
                },
                async markIncomplete() {
                    effects.push('markIncomplete');
                    if (boundary === 'mark' && primaryError && !heldOnce) {heldOnce = true; await hold();}
                },
                async apply() {assert.fail('A primary source failure cannot apply');},
                async open() {throw new ProjectionContractError('projection.incomplete', 'No qualified source coverage');},
                async query() {assert.fail('A failed source cannot serve');},
            };
            const {HyperionWorker} = await import('../../build/indexer/workers/hyperionWorker.js');
            const worker = Object.create(HyperionWorker.prototype); worker.configureWorkerAttemptLifecycle(attempts);
            const definition = {schemaVersion: 1, id: 'future-items', mappingRevision: 'a'.repeat(64),
                source: {contract: 'items', table: 'items', abiDeployment: 'future-deployment', abiSha256: 'b'.repeat(64)},
                fields: [{name: 'owner', path: ['owner'], type: 'string'}], initialization: {kind: 'genesis'}};
            const configuration = resolvePortableStateConfiguration({backend: {kind: 'mongodb', id: 'controlled', database: 'controlled'}, projections: [definition]}, prepared.chainId);
            const controller = await worker.runProjectionAttempt('projection-initialization', {}, () => PortableStateController.create({
                chainId: prepared.chainId, configuration, adapter, source: observedSource, onProgress: value => progress.push(value),
                attempts: {run: (metadata, operation) => worker.runProjectionFrameAttempt(metadata, operation, () => true),
                    bind: fields => worker.bindWorkerAttempt(fields)}}));
            let error;
            try {await controller.drain();} catch (value) {error = value;}
            assert.equal(scope.snapshot().state, 'drained'); assert.equal(scope.snapshot().pendingOperations, 0);
            assert.deepEqual({source: prepared.memory.calls.length, adapter: effects.length}, callsAtFence,
                'cancelled fallback handling cannot issue fresh source/adapter I/O');
            if (!active) {
                assert.equal(error, primaryError, 'cancellation during fallback must preserve the original primary error object');
                assert.equal(progress.length, 0, 'cancelled error handling cannot publish progress or readiness');
            } else {
                assert.equal(error, undefined); assert.equal(progress.length, 1);
                if (boundary === 'mark' && completion === 'ordinary') {
                    assert.equal(progress[0].status, 'incomplete');
                    assert.equal(progress[0].reason, 'Durable projection failure marking requires retry: Original fallback callback failure');
                } else {assert.equal(progress[0].status, 'waiting'); assert.equal(progress[0].reason, primaryError.message);}
            }
            await controller.stop();
            send({event: 'outcome', scenario, originalController: true, primaryErrorPreserved: !active,
                activeFallbackSemanticsPreserved: !!active, noPostFenceSourceIO: true, fullWorkerQualification: false});
        } else {
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
        }
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
        if (!fallback?.[4]) {
            supervisor.fenceActive(); await until(() => messages.some(value => value.event === 'fenced'), 'original parent fences the held source scope');
        }
        const initialization = fallback ? 1 : 0;
        worker.send({event: 'release-input'}); await delay(40);
        assert.equal(ends.length, initialization, 'neither a callback rejection nor a deadline proves retained-operation drainage');
        assert.equal(messages.some(value => value.event === 'outcome'), false);
        worker.send({event: 'release-retained'});
        await until(() => state.exited, 'source error is decided only after its authentic end');
        assert.equal(state.code, 0, state.stdout + state.stderr); assert.equal(state.stderr, '');
        assert.equal(ends.length, initialization + 1);
        const end = ends.at(-1); assert.equal(end.status, 'quiescent'); assert.equal(end.rootResult, fallback?.[4] ? 'returned' : 'threw');
        assert.equal(end.descriptor.kind, 'projection-frame');
        assert.equal(end.acknowledgementAttempted, false); assert.deepEqual(end.freshWrites, []);
        assert.ok(messages.some(value => value.event === 'outcome'));
        console.log(JSON.stringify({passed: true, scenario, native: process.version, originalSourceAndManagedFrame: true,
            originalRevalidationCallback: !fallback, originalFallbackCallback: !!fallback,
            originalWireSource: true, controlledElasticsearchTransport: true,
            authenticDrainedEnd: true, noPostFenceSourceIO: true, ...(fallback ? {originalController: true,
                primaryErrorPreserved: !fallback[4], activeFallbackSemanticsPreserved: !!fallback[4]} : {}), fullWorkerQualification: false}));
    } finally {
        if (!state.exited) {worker.kill('SIGKILL'); await until(() => state.exited, 'owned source fixture child cleanup');}
        supervisor.stop();
    }
}
