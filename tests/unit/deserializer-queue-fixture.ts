import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mock} from 'bun:test';

// Replace startup I/O only. Exercise the production constructor, async.cargo,
// and processMessages; the parser supplies a controlled decoding exception.
const logs: unknown[][] = [];
mock.module('../../src/indexer/helpers/common_functions.js', () => ({
    hLog: (...args: unknown[]) => {logs.push(args);}, debugLog: () => {}
}));
mock.module('../../src/indexer/definitions/index-queues.js', () => ({index_queues: [], RabbitQueueDef: {durable: true}}));
mock.module('../../src/indexer/workers/hyperionWorker.js', () => ({
    HyperionWorker: class {
        conf = {prefetch: {block: 1}, settings: {eosio_alias: 'eosio'}, features: {tables: {}}};
        events = new EventEmitter();
        mLoader = {parser: undefined, appendDynamicContracts() {}};
        profiler = {start: () => () => {}};
        usesExtensionProtocol = false;
        actionSourceAdmissionEnabled = false;
        createDurableWorkerOutputQueue() {return {kill() {}};}
    },
    ProtocolSourceCodecError: class extends Error {}, protocolSourceCapture: Symbol('controlled-source-capture')
}));
const {default: MainDSWorker} = await import('../../src/indexer/workers/deserializer.js');
function gate() {
    let release!: () => void;
    const promise = new Promise<void>(done => {release = done;});
    return {promise, release};
}
async function until(check: () => boolean, detail: string) {
    for (let index = 0; index < 100; index++) {
        if (check()) return;
        await new Promise<void>(done => setTimeout(done, 2));
    }
    assert.fail(detail);
}

const checks: string[] = [];
for (const mode of ['live', 'bulk']) {
    process.env.live_mode = String(mode === 'live');
    const worker: any = new MainDSWorker(), acknowledged: number[] = [];
    Object.assign(worker, {ch_ready: true, ch: {
        ack(message: any) {acknowledged.push(message.fields.deliveryTag);},
        nackAll() {assert.fail('Healthy batches must not be requeued');}
    }});
    worker.mLoader.parser = {async parseMessage(current: any, messages: any[]) {
        for (const message of messages) current.ch.ack(message);
    }};
    try {
        await worker.consumerQueue.pushAsync({fields: {deliveryTag: 1}});
        await worker.consumerQueue.pushAsync({fields: {deliveryTag: 2}});
        await until(() => worker.consumerQueue.idle(), mode + ' cargo did not drain');
        assert.deepEqual(acknowledged, [1, 2]);
        checks.push(mode + '-healthy-batches-progress');
    } finally {worker.consumerQueue.kill(); worker.preIndexingQueue.kill();}
}

const policies = ['legacy-live', 'legacy-bulk', 'disconnected', 'missing-channel'];
if (process.argv.includes('--protocol')) policies.push('usesExtensionProtocol', 'actionSourceAdmissionEnabled');
for (const policy of policies) {
    process.env.live_mode = String(policy !== 'legacy-bulk');
    const worker: any = new MainDSWorker(), entered = gate(), failed = gate(), originalExit = process.exit;
    let attempts = 0, nacks = 0, callbacks = 0;
    const exits: unknown[] = [];
    Object.assign(worker, {ch_ready: policy !== 'disconnected',
        ch: policy === 'missing-channel' ? undefined : {nackAll() {nacks++;}}});
    if (policy === 'usesExtensionProtocol' || policy === 'actionSourceAdmissionEnabled') worker[policy] = true;
    worker.mLoader.parser = {async parseMessage() {
        attempts++; entered.release(); await failed.promise; throw new Error('controlled delta decoding failure');
    }};
    process.exit = ((code?: number) => {exits.push(code);}) as never;
    try {
        worker.consumerQueue.push({}, () => {callbacks++;}); await entered.promise;
        worker.consumerQueue.push({}, () => {callbacks++;}); failed.release();
        await until(() => exits.length > 0, policy + ' did not request supervised replacement');
        assert.deepEqual(exits, [1]);
        assert.equal(worker.ch_ready, false);
        assert.equal(worker.consumerQueue.length(), 0);
        assert.equal(attempts, 1);
        assert.equal(nacks, 0, 'Do not invalidate outstanding delivery tags before terminating their owner');
        assert.equal(callbacks, 0, 'Failed batches must not resume cargo through a success callback');
        checks.push(policy + '-supervised-exit-without-resuming');
    } finally {process.exit = originalExit; worker.consumerQueue.kill(); worker.preIndexingQueue.kill();}
}
assert(logs.some(args => String(args[0]).includes('supervised replacement required:')));
console.log(JSON.stringify({passed: true, actualConstructorCargo: true, checks}));
