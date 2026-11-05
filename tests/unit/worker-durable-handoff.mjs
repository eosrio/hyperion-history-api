import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {controlledAttemptLifecycle} from './worker-attempt-fixture.mjs';

// Imported queue definitions read configuration, but no worker constructor or transport is started.
const previousDirectory = process.cwd(), previousConfig = process.env.CONFIG_JSON;
const directory = mkdtempSync(join(tmpdir(), 'hyperion-confirmed-worker-'));
let Pool, Deserializer, Parser;
try {
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'controlled'}, indexer: {},
        features: {tables: {}}, scaling: {}, whitelists: {}, blacklists: {}}));
    writeFileSync(join(directory, 'config/connections.json'), '{}');
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
    ({default: Pool} = await import('../../build/indexer/workers/ds-pool.js'));
    ({default: Deserializer} = await import('../../build/indexer/workers/deserializer.js'));
    ({default: Parser} = await import('../../build/indexer/modules/parsers/3.2-parser.js'));
} finally {
    process.chdir(previousDirectory);
    if (previousConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = previousConfig;
    rmSync(directory, {recursive: true, force: true});
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function actionWorker({writable = true, sendError, prototype = Pool.prototype, role = 'ds_pool_worker', legacy = false} = {}) {
    const worker = Object.create(prototype);
    const consumer = new EventEmitter(), publisher = new EventEmitter();
    const sent = [], acks = [];
    consumer.ack = message => acks.push(message);
    consumer.sendToQueue = (queue, payload, options) => {sent.push({queue, payload, options, ordinary: true}); return writable;};
    publisher.sendToQueue = (queue, payload, options, confirm) => {
        sent.push({queue, payload, options, confirm}); if (sendError) throw sendError; return writable;
    };
    Object.assign(worker, {
        ch: consumer, cch: publisher, ch_ready: true, cch_ready: true,
        protocol: {profileId: legacy ? 'antelope-default-v1' : 'wire-controlled-v1'}, chain: 'wire-controlled',
        conf: {indexer: {disable_indexing: false}, scaling: {ad_idx_queues: 1}, prefetch: {block: 1}}, act_emit_idx: 1,
        profiler: {start: () => () => {}}, protocolDeliveryOwners: new WeakMap(),
        poolAbiCache: new Map(), poolTypeCache: new Map(),
    });
    // Processing is controlled; the real ingress, emitter, attempt lifecycle and upstream ACK run.
    worker.processTraces = async () => {await worker.pushToActionsQueue(Buffer.from('{"action":"owned"}'), 33);};
    worker.preIndexingQueue = worker.createDurableWorkerOutputQueue();
    if (!legacy) controlledAttemptLifecycle(worker, role);
    const message = {content: Buffer.from('{}'), properties: {headers: {}}, fields: {deliveryTag: 1}};
    if (!legacy) {
        if (role === 'deserializer') worker.captureProtocolSourceDelivery(message, consumer);
        else worker.captureProtocolActionDelivery(message, consumer);
    }
    return {worker, consumer, publisher, sent, acks, message};
}

test('actual Wire action delivery waits for durable downstream confirmation before upstream ACK', async () => {
    const fixture = actionWorker();
    const running = fixture.worker.processMessages([fixture.message]);
    await tick();
    try {
        assert.equal(fixture.sent.length, 1);
        assert.equal(fixture.acks.length, 0, 'source ACK must not precede downstream confirmation');
        assert.equal(fixture.sent[0].options.persistent, true);
        assert.equal(fixture.sent[0].options.mandatory, true);
    } finally {
        fixture.sent[0]?.confirm?.(null);
        await running;
    }
    assert.equal(fixture.acks.length, 1);
});

test('legacy cargo retires a failed durable publisher and a fresh worker can process redelivery', async () => {
    const fixture = actionWorker({legacy: true}), originalExit = process.exit;
    const exits = []; let nacks = 0, callbacks = 0;
    fixture.consumer.nackAll = () => {nacks++;};
    fixture.worker.consumerQueue = fixture.worker.createConsumerQueue();
    try {
        process.exit = code => {exits.push(code);};
        fixture.worker.consumerQueue.push(fixture.message, () => {callbacks++;});
        await tick(); fixture.sent[0].confirm(new Error('broker nack')); await tick(); await tick();
        // Before the fix, nackAll/callback kept this worker alive and its sticky group poisoned every retry.
        if (!exits.length) {
            fixture.worker.consumerQueue.push({...fixture.message, fields: {deliveryTag: 2}}, () => {callbacks++;});
            await tick(); await tick();
            assert.equal(fixture.sent.length, 1, 'the poisoned retry never reached its publisher');
            assert.equal(nacks, 2); assert.equal(callbacks, 2);
        }
        assert.deepEqual(exits, [1]);
        assert.equal(fixture.worker.ch_ready, false);
        assert.equal(nacks, 0); assert.equal(callbacks, 0); assert.equal(fixture.acks.length, 0);
    } finally {
        process.exit = originalExit; fixture.worker.consumerQueue.kill(); fixture.worker.preIndexingQueue.kill();
    }
    const replacement = actionWorker({legacy: true});
    const running = replacement.worker.processMessages([replacement.message]);
    await tick(); assert.equal(replacement.acks.length, 0); replacement.sent[0].confirm(null); await running;
    assert.equal(replacement.acks.length, 1);
});

test('an unrelated legacy contract failure keeps its existing cargo recovery behavior', async () => {
    const fixture = actionWorker({legacy: true}); let nacks = 0, callbacks = 0;
    fixture.consumer.nackAll = () => {nacks++;};
    fixture.worker.processTraces = async () => {throw new Error('controlled contract failure');};
    fixture.worker.consumerQueue = fixture.worker.createConsumerQueue();
    try {
        fixture.worker.consumerQueue.push(fixture.message, () => {callbacks++;});
        await tick(); await tick();
        assert.equal(nacks, 1); assert.equal(callbacks, 1); assert.equal(fixture.worker.ch_ready, true);
        assert.equal(fixture.acks.length, 0); assert.equal(fixture.sent.length, 0);
    } finally {fixture.worker.consumerQueue.kill(); fixture.worker.preIndexingQueue.kill();}
});

test('false send requires confirmation and drain without republishing', async () => {
    const fixture = actionWorker({writable: false});
    const running = fixture.worker.processMessages([fixture.message]);
    await tick(); fixture.sent[0].confirm(null); await tick();
    assert.equal(fixture.acks.length, 0);
    assert.equal(fixture.sent.length, 1);
    fixture.publisher.emit('drain'); await running;
    assert.equal(fixture.acks.length, 1);
    assert.equal(fixture.publisher.listenerCount('return'), 0);
    assert.equal(fixture.publisher.listenerCount('drain'), 0);
});

for (const failure of ['nack', 'return', 'close', 'error', 'throw', 'publisher-replaced', 'consumer-replaced', 'fork-fence', 'proof-guard']) {
    test(`actual action delivery never ACKs after ${failure}`, async () => {
        const fixture = actionWorker({sendError: failure === 'throw' ? new Error('uncertain send') : undefined});
        if (failure === 'proof-guard') fixture.worker.revalidateProtocolDeliveryNativeOutputs = async () => {throw new Error('stale canonical proof');};
        const running = fixture.worker.processMessages([fixture.message]);
        const rejected = assert.rejects(running);
        await tick();
        const publication = fixture.sent[0];
        if (failure === 'nack') publication.confirm(new Error('broker nack'));
        if (failure === 'return') {fixture.publisher.emit('return', {properties: {messageId: publication.options.messageId}}); publication.confirm(null);}
        if (failure === 'close') fixture.publisher.emit('close');
        if (failure === 'error') {fixture.publisher.emit('error', new Error('publisher failure')); fixture.publisher.emit('close');}
        if (failure === 'throw') fixture.publisher.emit('close');
        if (failure === 'publisher-replaced') {fixture.worker.cch = new EventEmitter(); publication.confirm(null);}
        if (failure === 'consumer-replaced') {fixture.worker.ch = new EventEmitter(); publication.confirm(null);}
        if (failure === 'fork-fence') {fixture.worker.workerAttemptClient.fenceActiveAttempts(); fixture.publisher.emit('close');}
        if (failure === 'proof-guard') publication.confirm(null);
        await rejected;
        assert.equal(fixture.acks.length, 0);
        assert.equal(fixture.sent.length, 1, 'uncertain output is not resent on another channel');
        assert.equal(fixture.publisher.listenerCount('return'), 0);
        assert.equal(fixture.publisher.listenerCount('drain'), 0);
    });
}

test('caught host publication failure cannot authorize a later action ACK', async () => {
    const fixture = actionWorker();
    fixture.worker.processTraces = async () => {try {await fixture.worker.pushToActionsQueue(Buffer.from('{}'), 33);} catch {}};
    const rejected = assert.rejects(fixture.worker.processMessages([fixture.message]), /nack/);
    await tick(); fixture.sent[0].confirm(new Error('broker nack')); await rejected;
    assert.equal(fixture.acks.length, 0);
});

test('a caught queue rejection without an Error still prevents an action ACK', async () => {
    const fixture = actionWorker();
    fixture.worker.preIndexingQueue = {push: () => Promise.reject(undefined)};
    fixture.worker.processTraces = async () => {try {await fixture.worker.pushToActionsQueue(Buffer.from('{}'), 33);} catch {}};
    await assert.rejects(fixture.worker.processMessages([fixture.message]), /undefined/);
    assert.equal(fixture.acks.length, 0);
    assert.equal(fixture.sent.length, 0);
});

test('durable handoff snapshots payload and typed headers before asynchronous confirmation', async () => {
    const fixture = actionWorker(), payload = Buffer.from('original'), headers = {block_num: 33, typed: Buffer.from('typed')};
    const running = fixture.worker.publishDurableWorkerOutput('wire-controlled:index_state:1', payload, {headers});
    payload.fill(0); headers.block_num = 99; headers.typed.fill(0);
    assert.equal(fixture.sent[0].payload.toString(), 'original');
    assert.equal(fixture.sent[0].options.headers.block_num, 33);
    assert.equal(fixture.sent[0].options.headers.typed.toString(), 'typed');
    fixture.sent[0].confirm(null); await running;
});

test('detached host fan-out has a finite pending budget and cannot ACK after overflow', async () => {
    const fixture = actionWorker();
    fixture.publisher.setMaxListeners(0); // This controlled fan-out deliberately reaches the admission bound.
    const publications = [];
    fixture.worker.processTraces = async () => {
        for (let index = 0; index < 1100; index++) {
            try {publications.push(fixture.worker.publishDurableWorkerOutput('wire-controlled:index_state:1', Buffer.from('{}')));} catch {break;}
        }
    };
    const rejected = assert.rejects(fixture.worker.processMessages([fixture.message]), /budget exhausted/);
    await tick(); assert(fixture.sent.length > 0 && fixture.sent.length < 1100);
    for (const sent of fixture.sent) sent.confirm(null);
    await Promise.all(publications); await rejected;
    assert.equal(fixture.acks.length, 0);
});

test('source ACK waits for queued work even when an intermediate helper is not awaited', async () => {
    const fixture = actionWorker();
    fixture.worker.preIndexingQueue.pause();
    fixture.worker.processTraces = async () => {void fixture.worker.pushToActionsQueue(Buffer.from('{}'), 33);};
    const running = fixture.worker.processMessages([fixture.message]);
    await tick(); assert.equal(fixture.sent.length, 0); assert.equal(fixture.acks.length, 0);
    fixture.worker.preIndexingQueue.resume(); await tick();
    assert.equal(fixture.sent.length, 1); assert.equal(fixture.acks.length, 0);
    fixture.sent[0].confirm(null); await running;
    assert.equal(fixture.acks.length, 1);
});

test('owner retirement removes paused output tasks without publishing or ACKing', async () => {
    const fixture = actionWorker();
    fixture.worker.preIndexingQueue.pause();
    const rejected = assert.rejects(fixture.worker.processMessages([fixture.message]), /worker attempt/);
    await tick(); fixture.consumer.emit('close'); await rejected;
    fixture.worker.preIndexingQueue.resume(); await tick();
    assert.equal(fixture.sent.length, 0); assert.equal(fixture.acks.length, 0);
});

test('best-effort action streaming stays on its ordinary channel', () => {
    const fixture = actionWorker();
    const streams = [];
    fixture.worker.allowStreaming = true; fixture.worker.conf.features = {streaming: {traces: true}};
    fixture.consumer.publish = (...args) => {streams.push(args); return true;};
    fixture.worker.pushToActionStreamingQueue(Buffer.from('{}'), {act: {authorization: [], account: 'test', name: 'go'}, receipts: []});
    assert.equal(streams.length, 1);
    assert.equal(fixture.sent.length, 0);
});

test('actual deserializer/parser awaits DS dispatch and state/history output before source ACK', async () => {
    const fixture = actionWorker({prototype: Deserializer.prototype, role: 'deserializer'});
    const worker = fixture.worker;
    Object.assign(worker.conf, {whitelists: {root_only: false}, scaling: {routing_mode: 'round_robin', ds_pool_size: 1, indexing_queues: 1}});
    Object.assign(worker, {filters: {action_whitelist: new Set(), action_blacklist: new Set()}, lastSelectedWorker: 0,
        emit_idx: 1, protocolDeliveryOwners: new WeakMap()});
    worker.checkBlacklist = () => false;
    worker.prepareProtocolAbiObservations = async () => ({});
    worker.processProtocolSourceDelivery = async (message, operation) => {
        worker.activeSourceDelivery = {message, channel: fixture.consumer};
        await operation({this_block: {block_num: 33}, last_irreversible: {block_num: 32}});
    };
    worker.processBlock = async () => {
        await worker.routeToPool({action_traces: [['action_trace_v0', {act: {account: 'test', name: 'go'}}]]}, {block_num: 33});
        await worker.pushToStateIndexQueue({block_num: 33}, 'permission');
        await worker.pushToIndexQueue({block_num: 33}, 'block');
        return {block_num: 33};
    };
    worker.mLoader = {parser: Object.create(Parser.prototype)};
    worker.captureProtocolSourceDelivery(fixture.message, fixture.consumer);
    const running = worker.processMessages([fixture.message]);
    for (let index = 0; index < 3; index++) {
        await tick(); assert.equal(fixture.sent.length, index + 1); assert.equal(fixture.acks.length, 0);
        assert.equal(fixture.sent[index].ordinary, undefined);
        fixture.sent[index].confirm(null);
    }
    await running;
    assert.equal(fixture.acks.length, 1);
    assert.deepEqual(fixture.sent.map(item => item.queue), ['wire-controlled:ds_pool:1', 'wire-controlled:index_state:1', 'wire-controlled:index_generic:1']);
});
