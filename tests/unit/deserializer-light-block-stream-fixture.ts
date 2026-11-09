import {EventEmitter} from 'node:events';
import {writeSync} from 'node:fs';
import {mock} from 'bun:test';

mock.module('../../src/indexer/helpers/common_functions.js', () => ({hLog() {}, debugLog() {}}));
mock.module('../../src/indexer/definitions/index-queues.js', () => ({index_queues: [], RabbitQueueDef: {durable: true}}));
mock.module('../../src/indexer/workers/hyperionWorker.js', () => ({
    HyperionWorker: class {
        conf = {prefetch: {block: 4}, settings: {eosio_alias: 'eosio'}, features: {tables: {}, streaming: {enable: true, traces: true, deltas: true}}};
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
process.env.worker_queue = 'wax:live_blocks';
const {default: MainDSWorker} = await import('../../src/indexer/workers/deserializer.js');
const worker: any = new MainDSWorker();
const published: {queue: string; event: string; blockNum: number; body: any}[] = [];
worker.chain = 'wax';
worker.ch = {publish(exchange: string, queue: string, body: Buffer, options: any) {
    published.push({queue, event: options.headers.event, blockNum: options.headers.blockNum, body: JSON.parse(body.toString())});
    return true;
}};
const block = (block_num: number) => ({block_num, block_id: 'id' + block_num, producer: 'p', schedule_version: 1});
const counts: Record<string, number> = {};
function run(label: string, live: string | undefined, allow: boolean, value: any) {
    if (live === undefined) delete process.env.live_mode; else process.env.live_mode = live;
    worker.allowStreaming = allow;
    const before = published.length;
    worker.streamLightBlock(value);
    counts[label] = published.length - before;
}
run('live', 'true', true, block(10));
run('bulk', 'false', true, block(11));
run('unset-mode', undefined, true, block(12));
run('live-before-router', 'true', false, block(13));
run('live-without-block', 'true', true, undefined);
process.env.live_mode = 'true'; worker.allowStreaming = true; worker.ch = undefined;
let noChannel = 'published';
try {worker.streamLightBlock(block(14)); noChannel = 'skipped';} catch (error) {noChannel = 'threw: ' + (error as Error).message;}
writeSync(1, JSON.stringify({counts, published, noChannel}) + '\n');
process.exit(0);
