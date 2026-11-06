/** Original emitted callers with controlled local collaborators; no broker, database or sockets. */
import assert from 'node:assert/strict';
import {test, after} from 'node:test';
import {EventEmitter} from 'node:events';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';

const originalDirectory = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'hapi-action-service-'));
const config = join(directory, 'config.json');
writeFileSync(config, JSON.stringify({settings: {chain: 'hyp-p191-0123456789ab', debug: false}, indexer: {abi_scan_mode: false}}));
mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'config/connections.json'), '{}');
process.chdir(directory); process.env.CONFIG_JSON = config;
const [{default: Pool}, {WorkerProfiler}, {currentProofConsumerScope}] = await Promise.all([
    import('../../build/indexer/workers/ds-pool.js'), import('../../build/indexer/helpers/profiler.js'),
    import('../../build/indexer/protocol/proof-consumer-scope.js')]);
after(() => {
    process.chdir(originalDirectory);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('hapi-action-service-'));
    rmSync(directory, {recursive: true});
});
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
function fixture({admission = true, bindings = true, extension = true, lifecycle = true, profiling = true} = {}) {
    const events = [], worker = Object.create(Pool.prototype), consumer = new EventEmitter(), publisher = new EventEmitter();
    Object.defineProperties(worker, {actionSourceAdmissionEnabled: {value: admission}, usesProtocolSourceBindings: {value: bindings}, usesExtensionProtocol: {value: extension}});
    Object.assign(worker, {chain: 'hyp-p191-0123456789ab', conf: {prefetch: {block: 8}}, poolAbiCache: new Map(), poolTypeCache: new Map(),
        protocolCacheViews: new Set(), protocolNativeCacheEntries: new Set(), protocolDeliveryOwners: new WeakMap(),
        actionAdmissionOwners: new WeakMap(), ch: consumer, cch: publisher, ch_ready: true, cch_ready: true, ioRedisClient: null,
        profiler: new WorkerProfiler('ds_pool_worker', 1, profiling)});
    consumer.ack = function (message) {assert.equal(this, consumer); assert.equal(message, data); events.push('ack');};
    const data = {content: Buffer.from('[]'), properties: {headers: {block_num: 1270}}, fields: {deliveryTag: 1}};
    if (lifecycle) {
        worker.installControlledAttemptLifecycle('ds_pool_worker');
        worker.captureActionAdmissionDelivery(data, consumer);
        if (bindings) worker.captureProtocolActionDelivery(data, consumer);
    }
    const receipt = Object.freeze({controlledLocalReceipt: true});
    const store = {async trySeal(admissionValue) {assert.equal(admissionValue, worker.activeActionAdmission.admission); events.push('seal'); return false;}};
    worker.getActionAdmissionStore = () => store;
    worker.beginActionAdmission = async function (message) {
        assert.equal(this, worker); assert.equal(message, data); events.push('begin');
        await this.bindWorkerAttempt({blockNum: 1270, blockId: 'a'.repeat(64)});
        this.activeActionAdmission = {admission: {id: 'controlled-local'}, owner: this.actionPublicationOwner(data),
            payload: data.content, headers: data.properties.headers, traceOrdinal: 0, configuration: {}, handoff: undefined};
    };
    worker.processTraces = async function (value, headers) {assert.equal(this, worker); assert.deepEqual(value, []); assert.equal(headers, data.properties.headers); events.push('traces');};
    worker.revalidateProtocolDeliveryNativeOutputs = async function () {assert.equal(this, worker); events.push('native-current');};
    const run = () => worker.processMessages([data]);
    const metrics = () => worker.profiler.metrics;
    const dispose = () => worker.workerAttemptClient?.dispose();
    return {worker, consumer, publisher, data, store, receipt, events, run, metrics, dispose};
}

test('original native delivery keeps admission/seal/ACK order while exposing completed service spans', async () => {
    const f = fixture();
    try {
        assert.equal(await f.run(), undefined);
        assert.deepEqual(f.events, ['begin', 'traces', 'native-current', 'seal', 'native-current', 'ack']);
        assert.equal(f.worker.activeActionAdmission, undefined);
        assert.equal(f.worker.activeProtocolDelivery, undefined);
        assert.equal(f.metrics().action_service_delivery?.count, 1);
        assert.equal(f.metrics().action_service_callback?.count, 1);
        assert.equal(f.metrics().action_service_admission_begin?.count, 1);
        assert.equal(f.metrics().action_service_try_seal?.count, 1);
        assert.equal(f.metrics().action_service_ack?.count, 1);
        assert.equal(f.metrics().action_service_native_revalidate?.count, 2);
    } finally {f.dispose();}
});

function configureHandoff(f, {rawIncomplete = false, gate} = {}) {
    const begin = f.worker.beginActionAdmission, publications = [{}], evidence = Object.freeze({controlledLocalEvidence: true});
    f.worker.beginActionAdmission = async function (data) {
        await begin.call(this, data);
        this.activeActionAdmission.handoff = {publications, entries: [], rawIncomplete};
    };
    f.worker.assertActionHandoffCurrent = async function (scope) {assert.equal(scope, this.activeActionAdmission); assert.equal(scope.owner.current(), true); f.events.push('handoff-current');};
    f.worker.assertActionAdmissionOwner = function (scope) {assert.equal(scope, this.activeActionAdmission); f.events.push('owner-assert');};
    f.store.prepareRawIncompleteAttemptDisposition = async function (input) {assert.equal(input.publications, publications); f.events.push('prepare-raw'); return evidence;};
    const record = async function (input) {
        assert.equal(this, f.store);
        if (rawIncomplete) assert.equal(input.evidence, evidence);
        else {assert.equal(input.publications, publications); assert.equal(input.dispatchPayload, f.data.content); assert.equal(input.owner, f.worker.activeActionAdmission.owner);}
        f.events.push(rawIncomplete ? 'record-raw' : 'record-handoff');
        if (gate) await gate.promise;
        return f.receipt;
    };
    f.store.recordConfirmedHandoff = record; f.store.recordAttemptDisposition = record;
    f.worker.observeFreshActionWrite = async function (receipt) {assert.equal(this, f.worker); assert.equal(receipt, f.receipt); f.events.push('observe-fresh'); return false;};
}

test('original handoff await stays pending with original inputs before fresh-write observation and ACK', async () => {
    const f = fixture(), gate = deferred(); configureHandoff(f, {gate});
    try {
        const running = f.run();
        for (let i = 0; i < 10 && !f.events.includes('record-handoff'); i++) await nextTurn();
        assert.deepEqual(f.events, ['begin', 'traces', 'native-current', 'seal', 'native-current', 'handoff-current', 'record-handoff']);
        assert.equal(f.metrics().action_service_record_handoff, undefined);
        gate.resolve(); await running;
        assert.deepEqual(f.events.slice(-4), ['observe-fresh', 'handoff-current', 'owner-assert', 'ack']);
        assert.equal(f.metrics().action_service_handoff_current?.count, 2);
        assert.equal(f.metrics().action_service_record_handoff?.count, 1);
        assert.equal(f.metrics().action_service_observe_fresh?.count, 1);
    } finally {gate.resolve(); f.dispose();}
});

test('original stale Redis guard skips execution and clears the old pipeline before completion', async () => {
    const f = fixture(); let executed = 0;
    try {
        f.worker.redisBatchPipeline = {exec() {executed++; throw new Error('stale pipeline must not execute');}};
        f.worker.redisBatchHasOps = true;
        f.worker.protocolCacheIsCurrent = async function () {assert.equal(this, f.worker); f.events.push('redis-current'); return false;};
        assert.equal(await f.worker.flushRedisBatch(), undefined);
        assert.deepEqual(f.events, ['redis-current']); assert.equal(executed, 0);
        assert.equal(f.worker.redisBatchPipeline, null); assert.equal(f.worker.redisBatchHasOps, false);
        assert.equal(f.metrics().action_service_redis_current?.count, 1);
        assert.equal(f.metrics().redis_batch_exec, undefined);
    } finally {f.dispose();}
});

test('original raw-incomplete handoff preserves prepare/current/record/current order', async () => {
    const f = fixture(); configureHandoff(f, {rawIncomplete: true});
    try {
        await f.run();
        assert.deepEqual(f.events.slice(5), ['handoff-current', 'prepare-raw', 'handoff-current', 'record-raw', 'observe-fresh', 'handoff-current', 'owner-assert', 'ack']);
        assert.equal(f.metrics().action_service_prepare_raw_disposition?.count, 1);
        assert.equal(f.metrics().action_service_record_raw_disposition?.count, 1);
        assert.equal(f.metrics().action_service_handoff_current?.count, 3);
        assert.equal(f.metrics().action_service_observe_fresh?.count, 1);
    } finally {f.dispose();}
});

for (const kind of ['contract', 'transaction', 'empty-transaction']) {
    test(`original ${kind} disposition retains its branch, receipt and current-attempt checks`, async () => {
        const f = fixture(), evidence = Object.freeze({controlledLocalEvidence: kind}), failure = new Error('original contract-output marker');
        const begin = f.worker.beginActionAdmission;
        f.worker.beginActionAdmission = async function (message) {
            await begin.call(this, message);
            if (kind === 'contract') this.activeActionAdmission.contractFailure = failure;
            else this.activeActionAdmission.attemptEligible = true;
        };
        f.worker.assertActionAttemptCurrent = async function (scope) {assert.equal(this, f.worker); assert.equal(scope, this.activeActionAdmission); assert.equal(scope.owner.current(), true); f.events.push('attempt-current');};
        f.store.prepareContractAttemptDisposition = async function (input) {assert.equal(input.failure, failure); f.events.push('prepare-contract'); return evidence;};
        f.store.prepareTransactionAttemptDisposition = async function (input) {assert.equal(input.owner, f.worker.activeActionAdmission.owner); f.events.push('prepare-transaction'); return kind === 'empty-transaction' ? null : evidence;};
        f.store.recordAttemptDisposition = async function (input) {assert.equal(input.evidence, evidence); assert.equal(input.owner, f.worker.activeActionAdmission.owner); f.events.push('record-disposition'); return f.receipt;};
        f.worker.observeFreshActionWrite = async function (receipt) {assert.equal(receipt, f.receipt); f.events.push('observe-fresh'); return false;};
        try {
            await f.run();
            const branch = kind === 'contract' ? 'contract' : 'transaction';
            assert.deepEqual(f.events.slice(5), ['attempt-current', 'prepare-' + branch, 'attempt-current',
                ...(kind === 'empty-transaction' ? [] : ['record-disposition', 'observe-fresh']), 'attempt-current', 'ack']);
            assert.equal(f.metrics()['action_service_prepare_' + branch + '_disposition']?.count, 1);
            assert.equal(f.metrics()['action_service_record_' + branch + '_disposition']?.count ?? 0, kind === 'empty-transaction' ? 0 : 1);
            assert.equal(f.metrics().action_service_attempt_current?.count, 3);
        } finally {f.dispose();}
    });
}

test('original rejected handoff keeps the identical exception, stops spans and never observes or ACKs', async () => {
    const f = fixture(), sentinel = new Error('original rejected handoff'), gate = deferred(); configureHandoff(f, {gate});
    try {
        const running = f.run(), rejected = assert.rejects(running, error => error === sentinel);
        for (let i = 0; i < 10 && !f.events.includes('record-handoff'); i++) await nextTurn();
        gate.reject(sentinel); await rejected;
        assert.deepEqual(f.events.slice(-2), ['handoff-current', 'record-handoff']);
        assert.equal(f.metrics().action_service_record_handoff?.count, 1);
        assert.equal(f.metrics().action_service_delivery?.count, 1); assert.equal(f.metrics().action_service_callback?.count, 1);
        assert.equal(f.metrics().action_service_observe_fresh, undefined); assert.equal(f.metrics().action_service_ack, undefined);
        assert.equal(f.worker.activeActionAdmission, undefined); assert.equal(f.worker.activeProtocolDelivery, undefined);
    } finally {gate.resolve(); f.dispose();}
});

test('original seal rejection propagates unchanged with no second revalidation or ACK', async () => {
    const f = fixture(), sentinel = new Error('original seal failure');
    f.store.trySeal = async () => {f.events.push('seal'); throw sentinel;};
    try {
        await assert.rejects(f.run(), error => error === sentinel);
        assert.deepEqual(f.events, ['begin', 'traces', 'native-current', 'seal']);
        assert.equal(f.metrics().action_service_try_seal?.count, 1);
        assert.equal(f.metrics().action_service_native_revalidate?.count, 1); assert.equal(f.metrics().action_service_ack, undefined);
    } finally {f.dispose();}
});

test('actual local attempt cancellation retains its AbortSignal reason and completes the failed spans', async () => {
    const f = fixture(); let originalReason;
    f.worker.beginActionAdmission = async function (data) {
        assert.equal(data, f.data); f.events.push('cancel');
        const scope = currentProofConsumerScope(true); scope.fence(); originalReason = scope.signal.reason;
        scope.signal.throwIfAborted();
    };
    try {
        await assert.rejects(f.run(), error => error === originalReason);
        assert.deepEqual(f.events, ['cancel']);
        for (const name of ['action_service_admission_begin', 'action_service_callback', 'action_service_delivery']) assert.equal(f.metrics()[name]?.count, 1);
        assert.equal(f.metrics().action_service_ack, undefined);
    } finally {f.dispose();}
});

test('actual local scope keeps delivery pending beyond callback/ACK until its original physical operation drains', async () => {
    const f = fixture(), physical = deferred(), traces = f.worker.processTraces;
    f.worker.processTraces = async function (...args) {await traces.apply(this, args); currentProofConsumerScope(true).operation(() => physical.promise);};
    try {
        const running = f.run();
        for (let i = 0; i < 10 && !f.events.includes('ack'); i++) await nextTurn();
        assert.equal(f.events.at(-1), 'ack');
        assert.equal(f.metrics().action_service_callback?.count, 1);
        assert.equal(f.metrics().action_service_delivery, undefined, 'callback completion cannot finish physical delivery timing');
        physical.resolve(); await running;
        assert.equal(f.metrics().action_service_delivery?.count, 1);
        assert.ok(f.metrics().action_service_delivery.totalTimeMs >= f.metrics().action_service_callback.totalTimeMs);
    } finally {physical.resolve(); f.dispose();}
});

test('original admitted publication still requires confirm AND drain before original ACK and delivery completion', async () => {
    const f = fixture(); let send;
    f.publisher.sendToQueue = function (...args) {assert.equal(this, f.publisher); send = args; return false;};
    f.worker.processTraces = async function () {
        f.events.push('traces');
        await this.publishAdmitted(this.activeActionAdmission.owner, this.chain + ':index_actions:1', Buffer.from('original controlled bytes'), f.data.properties.headers);
    };
    try {
        const running = f.run();
        for (let i = 0; i < 10 && !send; i++) await nextTurn();
        assert.ok(send); assert.equal(send[2].persistent, true); assert.equal(send[2].mandatory, true);
        send[3](null); await nextTurn();
        assert.deepEqual(f.events, ['begin', 'traces']); assert.equal(f.metrics().action_service_delivery, undefined);
        f.publisher.emit('drain'); await running;
        assert.equal(f.events.at(-1), 'ack'); assert.equal(f.metrics().action_service_ack?.count, 1);
        assert.equal(f.metrics().action_service_delivery?.count, 1);
    } finally {f.publisher.emit('drain'); f.dispose();}
});

for (const duringSeal of [false, true]) {
    test(`original owner fence ${duringSeal ? 'during' : 'before'} seal still refuses ACK without an extra recheck`, async () => {
        const f = fixture(), traces = f.worker.processTraces, seal = f.store.trySeal;
        if (duringSeal) f.store.trySeal = async function (...args) {const value = await seal.apply(this, args); f.worker.cch_ready = false; return value;};
        else f.worker.processTraces = async function (...args) {await traces.apply(this, args); this.cch_ready = false;};
        try {
            await assert.rejects(f.run(), {message: duringSeal ? 'Action admission consumer changed during seal' : 'Action admission consumer changed before ACK'});
            assert.equal(f.events.includes('ack'), false);
            assert.equal(f.metrics().action_service_owner_current?.count, duringSeal ? 2 : 1);
            assert.equal(f.metrics().action_service_ack, undefined);
        } finally {f.dispose();}
    });
}

test('original extension-only branch retains its protocol owner and ACK sequence', async () => {
    const f = fixture({admission: false});
    try {
        await f.run(); assert.deepEqual(f.events, ['traces', 'native-current', 'ack']);
        assert.equal(f.metrics().action_service_protocol_owner?.count, 1);
        assert.equal(f.metrics().action_service_ack?.count, 1); assert.equal(f.metrics().action_service_admission_begin, undefined);
    } finally {f.dispose();}
});

test('original non-native delivery remains untracked and ACKs without native admission work', async () => {
    const f = fixture({admission: false, bindings: false, extension: false, lifecycle: false});
    try {
        await f.run(); assert.deepEqual(f.events, ['traces', 'ack']);
        assert.equal(f.metrics().action_service_delivery, undefined); assert.equal(f.metrics().action_service_callback, undefined);
        assert.equal(f.metrics().action_service_ack?.count, 1);
    } finally {f.dispose();}
});

test('disabled existing profiler preserves all original effects and retains no metrics', async () => {
    const f = fixture({profiling: false}); configureHandoff(f);
    try {
        await f.run(); assert.equal(f.events.at(-1), 'ack'); assert.equal(f.events.includes('record-handoff'), true);
        assert.deepEqual(f.metrics(), {});
    } finally {f.dispose();}
});

test('Redis current-source rejection retains the original exception and does not execute or clear the pipeline', async () => {
    const f = fixture(), sentinel = new Error('original Redis current-source failure'), pipeline = {exec() {assert.fail('must not execute');}};
    f.worker.redisBatchPipeline = pipeline; f.worker.redisBatchHasOps = true;
    f.worker.protocolCacheIsCurrent = async () => {throw sentinel;};
    try {
        await assert.rejects(f.worker.flushRedisBatch(), error => error === sentinel);
        assert.equal(f.worker.redisBatchPipeline, pipeline); assert.equal(f.worker.redisBatchHasOps, true);
        assert.equal(f.metrics().action_service_redis_current?.count, 1); assert.equal(f.metrics().redis_batch_exec, undefined);
    } finally {f.dispose();}
});

for (const native of [true, false]) {
    test(`original Redis execution error keeps ${native ? 'native propagation' : 'legacy handling'} and finalization`, async () => {
        const f = fixture({admission: native, bindings: native, extension: native, lifecycle: native}), sentinel = new Error('original Redis execution failure');
        f.worker.redisBatchPipeline = {async exec() {f.events.push('redis-exec'); throw sentinel;}}; f.worker.redisBatchHasOps = true;
        f.worker.protocolCacheIsCurrent = async () => true;
        const log = console.log; console.log = () => {};
        try {
            if (native) await assert.rejects(f.worker.flushRedisBatch(), error => error === sentinel);
            else assert.equal(await f.worker.flushRedisBatch(), undefined);
            assert.deepEqual(f.events, ['redis-exec']); assert.equal(f.metrics().redis_batch_exec?.count, 1);
            assert.equal(f.metrics().action_service_redis_current?.count ?? 0, native ? 1 : 0);
            if (!native) {assert.equal(f.worker.redisBatchPipeline, null); assert.equal(f.worker.redisBatchHasOps, false);}
        } finally {console.log = log; f.dispose();}
    });
}

test('original synchronous native ACK exception remains identical after ACK and outer spans finalize', async () => {
    const f = fixture(), sentinel = new Error('original ACK failure'); f.consumer.ack = () => {f.events.push('ack'); throw sentinel;};
    try {
        await assert.rejects(f.run(), error => error === sentinel);
        assert.equal(f.events.at(-1), 'ack'); assert.equal(f.metrics().action_service_ack?.count, 1);
        assert.equal(f.metrics().action_service_callback?.count, 1); assert.equal(f.metrics().action_service_delivery?.count, 1);
    } finally {f.dispose();}
});

test('original successful Redis exec retains its pending await and clears state only after it settles', async () => {
    const f = fixture(), gate = deferred();
    f.worker.redisBatchPipeline = {async exec() {f.events.push('redis-exec'); await gate.promise; return 'original result';}};
    f.worker.redisBatchHasOps = true;
    f.worker.protocolCacheIsCurrent = async () => {f.events.push('redis-current'); return true;};
    try {
        const running = f.worker.flushRedisBatch(); await nextTurn();
        assert.deepEqual(f.events, ['redis-current', 'redis-exec']); assert.equal(f.worker.redisBatchHasOps, true);
        assert.equal(f.metrics().action_service_redis_current?.count, 1); assert.equal(f.metrics().redis_batch_exec, undefined);
        gate.resolve(); assert.equal(await running, undefined);
        assert.equal(f.worker.redisBatchPipeline, null); assert.equal(f.worker.redisBatchHasOps, false);
        assert.equal(f.metrics().redis_batch_exec?.count, 1);
    } finally {gate.resolve(); f.dispose();}
});

test('original legacy ACK failure retains its existing catch/log behavior and completes the ACK span', async () => {
    const f = fixture({admission: false, bindings: false, extension: false, lifecycle: false}), sentinel = new Error('original legacy ACK failure'), logs = [];
    f.consumer.ack = () => {f.events.push('ack'); throw sentinel;};
    const log = console.log; console.log = (...args) => logs.push(args);
    try {
        assert.equal(await f.run(), undefined); assert.deepEqual(f.events, ['traces', 'ack']);
        assert.equal(logs.length, 3); assert.equal(logs[0][0], sentinel); assert.deepEqual(logs[1][0], []); assert.equal(logs[2][0], f.data.properties.headers);
        assert.equal(f.metrics().action_service_ack?.count, 1); assert.equal(f.metrics().action_service_delivery, undefined);
    } finally {console.log = log; f.dispose();}
});

test('original non-native trace error still propagates without an ACK or a managed-delivery span', async () => {
    const f = fixture({admission: false, bindings: false, extension: false, lifecycle: false}), sentinel = new Error('original legacy trace error');
    f.worker.processTraces = async () => {f.events.push('traces'); throw sentinel;};
    try {
        await assert.rejects(f.run(), error => error === sentinel); assert.deepEqual(f.events, ['traces']);
        assert.equal(f.metrics().action_service_ack, undefined); assert.equal(f.metrics().action_service_delivery, undefined);
        assert.equal(f.metrics().process_messages_batch?.count, 1);
    } finally {f.dispose();}
});

test('original failed attempt also waits for physical drain before rejecting with the same error', async () => {
    const f = fixture(), gate = deferred(), sentinel = new Error('original failure with pending physical work');
    f.worker.processTraces = async () => {f.events.push('traces'); currentProofConsumerScope(true).operation(() => gate.promise); throw sentinel;};
    try {
        const running = f.run(), rejected = assert.rejects(running, error => error === sentinel);
        await nextTurn();
        assert.deepEqual(f.events, ['begin', 'traces']); assert.equal(f.metrics().action_service_callback?.count, 1);
        assert.equal(f.metrics().action_service_delivery, undefined);
        gate.resolve(); await rejected;
        assert.equal(f.metrics().action_service_delivery?.count, 1); assert.equal(f.metrics().action_service_ack, undefined);
    } finally {gate.resolve(); f.dispose();}
});
