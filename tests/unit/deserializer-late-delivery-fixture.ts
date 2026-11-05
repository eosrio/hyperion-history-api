import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {writeSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {PassThrough} from 'node:stream';
import {mock} from 'bun:test';

mock.module('../../src/indexer/helpers/common_functions.js', () => ({hLog() {}, debugLog() {}}));
mock.module('../../src/indexer/definitions/index-queues.js', () => ({index_queues: [], RabbitQueueDef: {durable: true}}));
mock.module('../../src/indexer/workers/hyperionWorker.js', () => ({
    HyperionWorker: class {
        conf = {prefetch: {block: 4}, settings: {eosio_alias: 'eosio'}, features: {tables: {}}};
        events = new EventEmitter();
        mLoader = {parser: undefined, appendDynamicContracts() {}};
        profiler = {start: () => () => {}};
        usesExtensionProtocol = false;
        actionSourceAdmissionEnabled = false;
        captureWorkerAttemptDelivery() {}
        createDurableWorkerOutputQueue() {return {kill() {}};}
    },
    ProtocolSourceCodecError: class extends Error {}, protocolSourceCapture: Symbol('controlled-source-capture')
}));
const {default: MainDSWorker} = await import('../../src/indexer/workers/deserializer.js');
const require = createRequire(import.meta.url), amqpRoot = dirname(require.resolve('amqplib'));
const {Connection} = require(join(amqpRoot, 'lib/connection.js'));
const {Channel} = require(join(amqpRoot, 'lib/channel_model.js'));
const defs = require(join(amqpRoot, 'lib/defs.js'));
assert.equal(require(join(amqpRoot, 'package.json')).version, '2.0.1');

const mode = process.argv.includes('--bulk') ? 'bulk' : 'live';
process.env.live_mode = String(mode === 'live');
process.env.worker_queue = mode === 'live' ? 'wax:live_blocks' : 'wax:blocks:1';
const worker: any = new MainDSWorker(), connection = new Connection(new PassThrough());
connection.channelMax = 2047;
const channel = new Channel(connection).allocate(), tag = 'controlled-deserializer';
const deliveries: number[] = [], parsed: number[] = [], acked: number[] = [], nacked: number[] = [];
let entered!: () => void, fail!: () => void, queuedAtFailure = -1, lateCompleted = false;
const parsing = new Promise<void>(done => {entered = done;}), failure = new Promise<void>(done => {fail = done;});
channel.on('delivery', (message: any) => {deliveries.push(message.fields.deliveryTag);});
// Keep actual prefetch/consume RPC, frame encoding, delivery assembly and
// consumer dispatch. Only the network endpoint is controlled by this fixture.
connection.channels[channel.ch].buffer.write = (frame: Buffer) => {
    const method = frame.readUInt32BE(7);
    if (method === defs.BasicQos) setImmediate(() => channel.accept({id: defs.BasicQosOk, fields: {}}));
    if (method === defs.BasicConsume) setImmediate(() => channel.accept({id: defs.BasicConsumeOk, fields: {consumerTag: tag}}));
    if (method === defs.BasicAck) acked.push(Number(frame.readBigUInt64BE(11)));
    if (method === defs.BasicNack) nacked.push(Number(frame.readBigUInt64BE(11)));
    return true;
};
Object.assign(worker, {ch: channel, ch_ready: true});
worker.mLoader.parser = {async parseMessage(current: any, messages: any[]) {
    for (const message of messages) {
        parsed.push(message.fields.deliveryTag);
        if (message.fields.deliveryTag === 1) {entered(); await failure; throw new Error('controlled delta decoding failure');}
        current.ch.ack(message);
    }
}};
process.once('exit', code => {
    writeSync(1, JSON.stringify({mode, code, deliveries, parsed, acked, nacked, queuedAtFailure,
        ready: worker.ch_ready, lateCompleted}) + '\n');
});
worker.initConsumer();
for (let attempt = 0; !channel.consumers.has(tag); attempt++) {
    assert(attempt < 100, 'Actual AMQP consume RPC did not register its consumer');
    await new Promise<void>(done => setTimeout(done, 2));
}
function start(deliveryTag: number) {
    channel.accept({id: defs.BasicDeliver, fields: {consumerTag: tag, deliveryTag, redelivered: false, exchange: '', routingKey: 'wax'}});
}
function finish() {
    channel.accept({id: defs.BasicProperties, fields: {}, size: 2});
    channel.accept({content: Buffer.from('{}')});
}
start(1); finish(); await parsing;
start(2); finish();
start(3); // The delivery method is received; its headers/body remain in transit.
queuedAtFailure = worker.consumerQueue.length();
assert.equal(queuedAtFailure, 1, 'Only original tag 2 has reached the local cargo queue');
assert.deepEqual(deliveries, [1, 2]);
// This independent inbound completion is not fenced by an outbound nackAll.
// A real worker exit must terminate the process before this callback runs.
setTimeout(() => {lateCompleted = true; finish();}, 20);
setTimeout(() => process.exit(0), 60);
fail();
