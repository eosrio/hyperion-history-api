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
    },
    ProtocolSourceCodecError: class extends Error {},
    protocolSourceCapture: Symbol('controlled-source-capture')
}));

const {default: MainDSWorker} = await import('../../src/indexer/workers/deserializer.js');
function gate() {
    let release!: () => void;
    const promise = new Promise<void>(done => {release = done;});
    return {promise, release};
}
async function until(check: () => boolean, detail: () => string) {
    for (let index = 0; index < 100; index++) {
        if (check()) return;
        await new Promise<void>(done => setTimeout(done, 2));
    }
    assert.fail(detail());
}

const checks: string[] = [];
for (const mode of ['live', 'bulk']) {
    process.env.live_mode = String(mode === 'live');
    const worker: any = new MainDSWorker();
    const entered = gate(), failed = gate();
    const processed: number[] = [], acknowledged: number[] = [];
    let attempts = 0, nacks = 0;
    const message = (deliveryTag: number) => ({content: Buffer.from('{}'), fields: {deliveryTag}});
    const channel = {
        ack(item: any) {acknowledged.push(item.fields.deliveryTag);},
        nackAll() {
            nacks++;
            // RabbitMQ redelivers both outstanding messages with new delivery tags.
            setImmediate(() => {worker.consumerQueue.push(message(101)); worker.consumerQueue.push(message(102));});
        }
    };
    Object.assign(worker, {ch: channel, ch_ready: true});
    worker.mLoader.parser = {async parseMessage(current: any, messages: any[]) {
        attempts++;
        if (attempts === 1) {
            entered.release(); await failed.promise;
            throw new Error('Decoding error at table_delta[]: Read past end of buffer');
        }
        for (const item of messages) {processed.push(item.fields.deliveryTag); current.ch.ack(item);}
    }};
    try {
        worker.consumerQueue.push(message(1)); await entered.promise;
        worker.consumerQueue.push(message(2));
        assert.equal(worker.consumerQueue.length(), 1, 'A second broker delivery is already queued when decoding fails');
        failed.release();
        await until(() => acknowledged.length >= 2, () => `${mode} cargo stalled after decoding failure: running=${worker.consumerQueue.running()}, queued=${worker.consumerQueue.length()}`);
        assert.equal(nacks, 1);
        assert.deepEqual(processed, [101, 102], 'Only fresh broker deliveries may run after nackAll');
        assert.deepEqual(acknowledged, [101, 102], 'Never acknowledge a stale delivery tag from the discarded local queue');
        await until(() => worker.consumerQueue.idle(), () => `${mode} cargo did not drain`);
        assert.equal(worker.consumerQueue.running(), 0);
        checks.push(`${mode}-redelivery-progress-without-stale-tags`);
    } finally {worker.consumerQueue.kill(); worker.preIndexingQueue.kill();}
}

for (const state of ['disconnected', 'nack-throws']) {
    const worker: any = new MainDSWorker();
    let attempts = 0, nacks = 0;
    Object.assign(worker, {ch_ready: state !== 'disconnected', ch: {nackAll() {nacks++; throw new Error('Channel closed');}}});
    worker.mLoader.parser = {async parseMessage() {if (++attempts === 1) throw new Error('controlled decoding failure');}};
    try {
        worker.consumerQueue.push({content: Buffer.from('{}')});
        await until(() => worker.consumerQueue.idle(), () => `${state} cargo did not release its failed batch`);
        await worker.consumerQueue.pushAsync({content: Buffer.from('{}')});
        assert.equal(attempts, 2);
        assert.equal(nacks, state === 'disconnected' ? 0 : 1);
        checks.push(`${state}-releases-cargo`);
    } finally {worker.consumerQueue.kill(); worker.preIndexingQueue.kill();}
}

if (process.argv.includes('--protocol')) {
    for (const policy of ['usesExtensionProtocol', 'actionSourceAdmissionEnabled']) {
        const worker: any = new MainDSWorker();
        const entered = gate(), failed = gate();
        const originalExit = process.exit;
        let attempts = 0, nacks = 0, callbacks = 0;
        const exits: unknown[] = [];
        Object.assign(worker, {[policy]: true, ch_ready: true, ch: {nackAll() {nacks++;}}});
        worker.mLoader.parser = {async parseMessage() {
            attempts++; entered.release(); await failed.promise; throw new Error('controlled protocol failure');
        }};
        process.exit = ((code?: number) => {exits.push(code);}) as never;
        try {
            worker.consumerQueue.push({}, () => {callbacks++;}); await entered.promise;
            worker.consumerQueue.push({}, () => {callbacks++;}); failed.release();
            await until(() => exits.length > 0, () => `${policy} did not request supervised replacement`);
            assert.deepEqual(exits, [1]);
            assert.equal(worker.ch_ready, false);
            assert.equal(worker.consumerQueue.length(), 0);
            assert.equal(attempts, 1);
            assert.equal(nacks, 0);
            assert.equal(callbacks, 0, 'Supervised failures must not resume cargo through a success callback');
            checks.push(`${policy}-supervised-exit-without-resuming`);
        } finally {process.exit = originalExit; worker.consumerQueue.kill(); worker.preIndexingQueue.kill();}
    }
}
assert(logs.some(args => args[0] === 'NACK ALL'));
console.log(JSON.stringify({passed: true, actualConstructorCargo: true, checks}));
