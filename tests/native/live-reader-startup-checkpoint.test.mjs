import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Pure VM caller regression: real source methods, inert cargo/cluster/HTTP and a
// manually advanced clock. No addon, worker, socket, broker or real timer loads.
const build = process.env.HYPERION_CHECKPOINT_VM_BUILD ?? 'build';
const read = path => readFileSync(new URL('../../' + build + '/' + path, import.meta.url), 'utf8');
const source = {
  master: read('indexer/modules/master.js'),
  reader: read('indexer/workers/state-reader.js'),
  progress: read('indexer/helpers/reader-progress.js'),
  controller: read('indexer/modules/controller.js')
};
function load(text, name, globals) {
  const script = text.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export (?:default )?/gm, '')
    .replace(/import\.meta\.(?:url|dirname|filename)/g, "'file:///inert-fixture/source.ts'");
  const context = vm.createContext(globals);
  vm.runInContext(script + '\nglobalThis.fixtureClass = ' + name, context);
  return {Type: context.fixtureClass, context};
}
function fixture() {
  const callbacks = [], forks = [], sends = [];
  const clock = {
    set(fn) { const token = {fn, unref() {return this;}}; callbacks.push(token); return token; },
    clear(token) {const i = callbacks.indexOf(token); if (i >= 0) callbacks.splice(i, 1);},
    advanceOne() {assert(callbacks.length, 'Expected a retained fake timer'); callbacks.shift().fn();}
  };
  const base = {
    Buffer, console: {log() {}, error() {}}, hLog() {}, debugLog() {},
    setTimeout: fn => clock.set(fn), clearTimeout: token => clock.clear(token),
    setInterval() {throw Error('Unexpected real interval boundary');},
    clearInterval() {}, performance: {now: () => 0},
    process: {env: {}, send() {}, exit() {throw Error('Unexpected process exit');}}
  };
  const cluster = {fork(input) {
    const worker = {process: {pid: 1000 + forks.length}, on() {}, send() {}};
    const env = Object.fromEntries(Object.entries(input).filter(([,v]) => v !== undefined).map(([k,v]) => [k,String(v)]));
    forks.push({worker,env}); return worker;
  }};
  const {Type: Master, context} = load(source.master, 'HyperionMaster', {...base,cluster});
  const master = Object.assign(Object.create(Master.prototype), {
    conf: {indexer: {live_reader: true, live_only_mode: true}, scaling: {ds_threads: 0}},
    chain_data: {head_block_num: {toNumber: () => 1000}}, validatedShipServers: [],
    workerMap: [], worker_index: 0, starting_block: 1, shouldCountIPCMessages: false
  });
  const marker = 'live_checkpoint: ';
  assert.equal(source.master.split(marker).length, 2, 'Real checkpoint handler must remain unambiguous');
  const tail = source.master.slice(source.master.indexOf(marker) + marker.length);
  const boundary = tail.indexOf('reader_recovery_required:');
  assert(boundary > 0);
  const arrow = tail.slice(0,boundary).trim().replace(/,$/, '');
  context.master = master;
  master.msgHandlerMap = {live_checkpoint: vm.runInContext(
    'function bind(){return (' + arrow + ');} bind.call(master);', context)};
  const {Type: Controller} = load(source.controller, 'LocalHyperionController', {...base,IndexerPauseCoordinator: class {}});
  const controller = new Controller(master), routes = new Map();
  const app = {get(path,handler) {routes.set(path,handler); return this;}};
  controller.localController = app; controller.setHttpHandlers();
  const info = () => {
    let body;
    const response = {writeHeader() {return this;},writeStatus() {return this;},end(value) {body = JSON.parse(value);}};
    routes.get('/get_worker/:worker_id')(response,{getParameter: () => String(master.liveReader.worker_id)});
    return body;
  };
  const progress = load(source.progress, 'LiveReaderCheckpoint', base).Type;
  const readers = [];
  function reader(fork = forks.at(-1), extension = true) {
    const config = {settings: {reader_recovery_window_blocks: 8}, indexer: {fetch_block: true}, prefetch: {read: 8}};
    class Parent {constructor() {this.conf = config; this.chain = 'fixture'; this.usesExtensionProtocol = extension;}}
    const globals = {...base,process: {...base.process, env: fork.env,send(message) {
      const copy = JSON.parse(JSON.stringify(message)); sends.push(copy); master.handleMessage(fork.worker,copy); return true;
    }}, HyperionWorker: Parent,LiveReaderCheckpoint: progress,
    cargo: () => ({kill() {}}),Serializer: {objectify: value => value}};
    const Reader = load(source.reader, 'StateReader', globals).Type;
    const value = new Reader(); readers.push(value);
    const requests = [], failures = [], confirms = [];
    value.ship = {connected: true};
    value.send = request => requests.push(JSON.parse(JSON.stringify(request)));
    value.allowRequests = true; value.queuePressurePending = false; value.backpressurePaused = false;
    value.profiler = {start: () => () => {}};
    value.failPublisherRecovery = reason => {value.publisherFailure = reason; failures.push(reason);};
    value.sourceContext = {id: 'source',readerSessionId: 'session',generation: 1};
    value.verifiedReaderSessionId = 'session';
    value.assertCurrentIngress = generation => assert.equal(generation,1);
    value.coordinatorRpc = {open: async () => ({generation: 'generation',resumeFromBlock: 900})};
    value.cch_ready = true;
    value.cch = {sendToQueue(_queue,_content,_options,confirm) {confirms.push(confirm); return true;}};
    return {value,requests,failures,confirms,fork,
      status() {value.handleStatusResult({chain_state_begin_block: 1,trace_begin_block: 1,chain_state_end_block: 2000});},
      publish(num,lib = 999) {
        const id = n => n.toString(16).padStart(64,'0');
        const confirmLive = value.liveCheckpoint.observe({num,id: id(num),previous: id(num - 1)},lib);
        value.recursiveDistribute([{num,content: Buffer.from([1]),confirmLive}],value.cch,() => {});
      }
    };
  }
  return {master,info,forks,clock,sends,reader};
}
async function started() {
  const f = fixture(); await f.master.setupReaders(); f.master.launchWorkers(); return f;
}

test('startup request head is not reported as confirmed publication progress', async () => {
  const f = await started();
  assert.equal(f.info().last_processed_block,undefined);
  const r = f.reader(undefined,false); r.status();
  assert.equal(r.requests.at(-1)[1].start_block_num,1000);
  assert.equal(f.info().last_processed_block,undefined);
});

test('real ABI rewind and broker confirms publish the lower contiguous checkpoint', async () => {
  const f = await started(), r = f.reader();
  await r.value.openCoordinatorSource(); r.status();
  assert.equal(r.requests.at(-1)[1].start_block_num,900);
  for (const num of [900,901,902]) r.publish(num);
  assert.equal(f.info().last_processed_block,undefined,'Accepted but unconfirmed bytes are not progress');
  r.confirms[2](null); r.confirms[1](null);
  assert.equal(f.info().last_processed_block,undefined,'Missing lower confirm must block the prefix');
  r.confirms[0](null);
  assert.equal(f.info().last_processed_block,903);
  assert.equal(f.master.liveReader.worker_last_processed_block_id,902..toString(16).padStart(64,'0'));
});

test('replacement uses genuine lower progress and ignores retired physical senders', async () => {
  const f = await started(), first = f.reader();
  await first.value.openCoordinatorSource(); first.status(); first.publish(900); first.confirms[0](null);
  assert.equal(f.info().last_processed_block,901);
  const old = f.forks[0].worker;
  f.master.handleWorkerDisconnect(old); f.clock.advanceOne();
  assert.equal(f.forks.at(-1).env.reader_pressure_sync,'true','Merged startup pressure gate must remain');
  const second = f.reader(undefined,false); second.status();
  assert.equal(second.requests.at(-1)[1].start_block_num,901);
  f.master.handleMessage(old,{event:'live_checkpoint',data:{nextBlock:1500,blockId:'f'.repeat(64)}});
  assert.equal(f.info().last_processed_block,901);
  f.master.handleMessage(f.forks.at(-1).worker,{event:'live_checkpoint',data:{nextBlock:899,blockId:'f'.repeat(64)}});
  assert.equal(f.info().last_processed_block,901,'Confirmed progress remains monotonic');
});

test('replacement before any confirm retains its request seed without fabricated progress', async () => {
  const f = await started(); f.master.handleWorkerDisconnect(f.forks[0].worker); f.clock.advanceOne();
  const r = f.reader(undefined,false); r.status();
  assert.equal(r.requests.at(-1)[1].start_block_num,1000);
  assert.equal(f.info().last_processed_block,undefined);
});

test('reversible and replaced-publisher confirmations never create a checkpoint', async () => {
  const f = await started(), r = f.reader();
  await r.value.openCoordinatorSource(); r.status(); r.publish(900,899); r.confirms[0](null);
  assert.equal(f.info().last_processed_block,undefined);
  r.publish(901,899); r.value.cch = {sendToQueue() {throw Error('Not used');}}; r.confirms[1](null);
  assert.match(r.failures[0],/replaced publisher/);
  assert.equal(f.info().last_processed_block,undefined);
});
