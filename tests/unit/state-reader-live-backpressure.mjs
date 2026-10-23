/** Actual reader/monitor/SHIP encoding; controlled socket, ES and broker transports only. */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {cargo} from 'async';
import {ABI, Serializer} from '@wharfkit/antelope';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {sockets as physicalSockets} from './state-reader-live-backpressure-ws.mjs';
const previousDirectory = process.cwd(), previousSend = process.send;
const directory = mkdtempSync(join(tmpdir(), 'hyperion-live-backpressure-'));
const chain = 'live-backpressure', chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d';
const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readers = [];
const scenario = process.argv[2];
const originalWireFrame = !scenario.startsWith('legacy') && scenario !== 'socket-callbacks';
const controlledWsUrl = new URL('./state-reader-live-backpressure-ws.mjs', import.meta.url).href;
const hooks = scenario.includes('socket-') ? registerHooks({resolve(specifier, context, nextResolve) {
    if (specifier === 'ws' && context.parentURL?.endsWith('/connections/state-history.js'))
        return {url: controlledWsUrl, shortCircuit: true};
    return nextResolve(specifier, context);
}}) : undefined;
let cleaned = false;
const cleanup = () => {
    if (cleaned) return; cleaned = true;
    for (const reader of readers) {reader.coordinatorRpc?.cancel(); reader.shipSession?.close?.(); reader.clearProtocolReconnect();
        if (reader.confirmationDeadline) clearTimeout(reader.confirmationDeadline); reader.blockReadingQueue.kill(); reader.stageOneDistQueue.kill();}
    hooks?.deregister();
    process.send = previousSend; process.chdir(previousDirectory);
    const owned = resolve(directory); assert.equal(dirname(owned), resolve(tmpdir())); rmSync(owned, {recursive: true, force: true});
};
process.once('exit', cleanup);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, message) {
    const deadline = Date.now() + 2000;
    while (!check()) {assert(Date.now() < deadline, message); await sleep(1);}
}
try {
    const config = {settings: {chain, parser: '3.2', protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId},
        es_replicas: 0, index_version: 'v1', reader_recovery_window_blocks: 256},
        indexer: {fetch_block: true, fetch_traces: true, fetch_deltas: true},
        scaling: {ds_queues: 1, max_queue_limit: 64, block_queue_limit: 64, resume_trigger: 8, max_autoscale: 0},
        prefetch: {read: 8}, plugins: {}};
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'config/connections.json'), '{}');
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
    delete process.env.worker_last_processed_block;
    process.send = (_message, callback) => {callback?.(null); return true;};
    const [{default: Reader}, {HyperionMaster}, {HyperionQueueMonitor}, {StateHistorySocket}, {loadChainProtocol},
        {ProtocolSourceBindingStore}, {ProtocolAbiObservationStore}, {ProtocolAbiFrontierStore},
        {ProtocolAbiCoordinator}, {ProtocolAbiCoordinatorRpc}] = await Promise.all([
        import('../../build/indexer/workers/state-reader.js'), import('../../build/indexer/modules/master.js'),
        import('../../build/indexer/modules/queueMonitor.js'), import('../../build/indexer/connections/state-history.js'), import('../../build/indexer/protocol/selection.js'),
        import('../../build/indexer/protocol/source-bindings.js'), import('../../build/indexer/protocol/abi-observation-store.js'),
        import('../../build/indexer/protocol/abi-frontier-store.js'), import('../../build/indexer/protocol/abi-coordinator.js'),
        import('../../build/indexer/protocol/abi-coordinator-rpc.js')]);
    const selected = await loadChainProtocol(config.settings.protocol);
    const legacySelection = scenario.startsWith('legacy') ? await loadChainProtocol({provider: 'antelope'}) : undefined;
    const wire = await import('@eosrio/hyperion-wire-plugin');
    const wireRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
    const source = join(wireRoot, 'fixtures/codec/native-onblock-6508-20261022');
    const manifest = JSON.parse(readFileSync(join(source, 'manifest.json')));
    const schemaJson = readFileSync(resolve(source, manifest.schema.path), 'utf8');
    assert.equal(sha(schemaJson), manifest.schema.sha256);
    const frame = readFileSync(join(source, 'block-000033.bin'));
    const member = manifest.members.find(value => value.path === 'block-000033.bin');
    assert.equal(sha(frame), member.sha256); assert.equal(frame.length, member.bytes);
    assert.equal(manifest.originalArchiveSha256, '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
    const codec = wire.createWireValueCodec(JSON.parse(schemaJson), wire.resolveCodecProfile(profileId));
    const original = codec.decode('result', frame)[1];
    const status = Buffer.from(codec.encode('result', ['get_status_result_v0', {head: original.head,
        last_irreversible: original.last_irreversible, trace_begin_block: 1, trace_end_block: 10000,
        chain_state_begin_block: 1, chain_state_end_block: 10000, chain_id: chainId}]));
    const legacySchemaBytes = readFileSync(new URL('./fixtures/ship-genesis/protocol.json', import.meta.url));
    const legacyFrame = readFileSync(new URL('./fixtures/ship-genesis/frame.bin', import.meta.url));
    assert.equal(sha(legacyFrame), '85d8a6d8fb004c0c5ff8031522d449b0ff226a382d974b469de8279021e61653');
    const legacyAbi = ABI.from(JSON.parse(legacySchemaBytes));
    const legacyOriginal = Serializer.objectify(Serializer.decode({data: legacyFrame, type: 'result', abi: legacyAbi}))[1];
    const legacyChainId = 'd8b73ada6b0ff982b5bafed1cde4d7612cc778ff82206c3b67d31a134f95be6c';
    async function fixture(live = true, legacy = false, actualSocket = false) {
        const protocol = legacy ? legacySelection : selected; assert.ok(protocol);
        const inputFrame = legacy ? legacyFrame : frame, result = legacy ? legacyOriginal : original;
        const inputSchema = legacy ? legacySchemaBytes : Buffer.from(schemaJson);
        const ownConfig = legacy ? {...config, settings: {...config.settings, protocol: {provider: 'antelope'}}} : config;
        process.env.worker_role = live ? 'continuous_reader' : 'reader';
        const memory = frontierMemoryClient(), bindings = new ProtocolSourceBindingStore(memory.client, chain);
        const observations = new ProtocolAbiObservationStore(memory.client, chain), frontier = new ProtocolAbiFrontierStore(memory.client, chain);
        const commands = [], publications = [], sockets = [], socketOffset = physicalSockets.length;
        let automatic = true, writable = true, queueError;
        const publisher = Object.assign(new EventEmitter(), {sendToQueue(queue, content, options, callback) {
            const publication = {queue, content: Buffer.from(content), options, confirm: (error = null) => callback(error)};
            publications.push(publication); if (automatic) queueMicrotask(publication.confirm); return writable;
        }});
        const reader = Object.assign(Object.create(Reader.prototype), {chain, chainId: legacy ? legacyChainId : chainId, conf: ownConfig,
            protocol: protocol.provider, protocolId: protocol.id, protocolComponents: protocol.components,
            protocolReady: Promise.resolve(), abieos: protocol.decoder, client: memory.client,
            ch: Object.assign(new EventEmitter(), {async assertQueue() {}}), cch: publisher, ch_ready: true, cch_ready: true,
            profiler: {start: () => () => {}}, events: new EventEmitter(),
            baseRequest: {max_messages_in_flight: 8, have_positions: [], irreversible_only: false, fetch_block: true, fetch_traces: true, fetch_deltas: true},
            shipRev: 'v0', isLiveReader: live, socketGeneration: 0, activeIngressGeneration: 0,
            allowRequests: true, local_block_num: Number(result.this_block.block_num) - 1, local_block_id: result.prev_block?.block_id ?? '',
            local_lib: Number(result.last_irreversible.block_num), receivedFirstBlock: true, currentIdx: 1,
            range_size: 10000, local_distributed_count: 0, drainCount: 0, reconnectCount: 0, internalPendingRanges: [],
            reversibleBlockMap: new Map(), forkedBlocks: new Map(), publications: new Map(), protocolSourceBindingStore: bindings});
        reader.stageOneDistQueue = cargo((tasks, callback) => reader.distribute(tasks, callback), 8);
        reader.blockReadingQueue = cargo((tasks, callback) => reader.processIncomingBlocks(tasks).then(() => callback(), error => {queueError = error; callback(error);}), 8);
        reader.ship = actualSocket ? new StateHistorySocket('ws://owned-controlled.invalid') : {connected: false, close() {this.connected = false;}, nextUrl() {},
            connect(message, disconnect, error, open) {sockets.push({message, disconnect, error, open});},
            send(bytes) {commands.push({socket: sockets.length, request: legacy
                ? Serializer.objectify(Serializer.decode({data: bytes, type: 'request', abi: legacyAbi}))
                : codec.decode('request', bytes)});}};
        if (!legacy) {
        const coordinator = new ProtocolAbiCoordinator({chainId, profile: {id: selected.id, profileId, components: selected.components},
            ownerId: 'live-backpressure-owner', bindings, observations, store: frontier,
            verifyNativeGenesis: selected.provider.verifyNativeGenesis.bind(selected.provider), nativeActionInterfaceVersion: 1});
        await coordinator.start();
        reader.coordinatorRpc = new ProtocolAbiCoordinatorRpc((request, callback) => {
            const input = request.data;
            void (input.operation === 'open' ? coordinator.openSource(input.contextId, input.readerSessionId) : coordinator.admit(input.selectionId, input.generation))
                .then(result => reader.onIpcMessage({event: 'protocol_abi_coordinator_reply', mId: request.mId, data: {ok: true, result}}))
                .catch(error => reader.onIpcMessage({event: 'protocol_abi_coordinator_reply', mId: request.mId, data: {ok: false, error: {code: 'fixture_transport', message: error.message}}}));
            callback(null);
        });
        }
        readers.push(reader);
        const drain = async () => {await until(() => reader.blockReadingQueue.idle(), 'reader ingress did not complete'); if (queueError) throw queueError;};
        const beginOpen = () => {
            reader.startWS();
            if (actualSocket) {
                const physical = physicalSockets.at(-1);
                sockets.push({physical, message: data => physical.emit('message', data), disconnect: () => physical.emit('close'),
                    error: error => physical.emit('error', error), open: () => physical.emit('open')});
            } else reader.ship.connected = true;
            const socket = sockets.at(-1); socket.open(); return socket;
        };
        const open = async () => {const socket = beginOpen(); await drain(); return socket;};
        const handshake = async socket => {
            socket.message(inputSchema); await drain();
            const response = legacy ? Buffer.from(Serializer.encode({object: ['get_status_result_v0', {head: result.head,
                last_irreversible: result.last_irreversible, trace_begin_block: 1, trace_end_block: 10000,
                chain_state_begin_block: 1, chain_state_end_block: 10000, chain_id: legacyChainId}], type: 'result', abi: legacyAbi}).array) : status;
            socket.message(response); await drain();
        };
        const socket = await open(); await handshake(socket);
        const creditCommands = () => (actualSocket ? physicalSockets.slice(socketOffset).flatMap((physical, index) => physical.sent.map(bytes => ({
            socket: index + 1, request: legacy ? Serializer.objectify(Serializer.decode({data: bytes, type: 'request', abi: legacyAbi}))
                : codec.decode('request', bytes)}))) : commands).filter(value => value.request[0] === 'get_blocks_ack_request_v0');
        return {reader, frame: inputFrame, memory, bindings, publisher, commands, publications, sockets, socket, open, beginOpen, handshake, drain, creditCommands,
            automatic(value) {automatic = value;}, writable(value) {writable = value;}};
    }
    if (scenario === 'socket-callbacks') {
        const ship = new StateHistorySocket('ws://owned-controlled.invalid'), calls = [[], []];
        const connect = index => ship.connect(message => calls[index].push(['message', message]), () => calls[index].push(['close']),
            error => calls[index].push(['error', error.message]), () => calls[index].push(['open']));
        connect(0); const old = physicalSockets.at(-1); old.emit('open');
        assert.equal(ship.connected, true); assert.deepEqual(calls[0], [['open']]);
        connect(1); const current = physicalSockets.at(-1);
        assert.equal(ship.connected, false, 'a replacement attempt is not connected before its own open');
        old.emit('open'); old.emit('message', Buffer.from('retired')); old.emit('error', new Error('retired')); old.emit('close');
        assert.equal(ship.connected, false); assert.deepEqual(calls[0], [['open']]); assert.deepEqual(calls[1], []);
        current.emit('open'); current.emit('message', Buffer.from('current')); current.emit('error', new Error('current'));
        assert.equal(ship.connected, true);
        assert.deepEqual(calls[1], [['open'], ['message', Buffer.from('current')], ['error', 'current']]);
        old.emit('close'); assert.equal(ship.connected, true);
        current.emit('close'); assert.equal(ship.connected, false); assert.equal(calls[1].at(-1)[0], 'close');
        current.emit('open'); current.emit('close'); current.emit('message', Buffer.from('after close')); current.emit('error', new Error('after close'));
        assert.equal(ship.connected, false); assert.equal(calls[1].length, 4);
        connect(1); const graceful = physicalSockets.at(-1); graceful.emit('open');
        ship.close(true); assert.equal(graceful.closes, 1); graceful.emit('close');
        assert.equal(ship.connected, false); assert.equal(calls[1].filter(call => call[0] === 'close').length, 1);
    } else if (scenario === 'legacy-socket-late-close') {
        const h = await fixture(true, true, true), next = await h.open(); await h.handshake(next);
        h.reader.onIpcMessage({event: 'pause'}); const before = h.creditCommands().length;
        next.message(h.frame); await h.drain();
        assert.equal(h.publications.length, 1); assert(h.publications[0].content.equals(h.frame));
        assert.equal(h.creditCommands().length, before); assert.equal(h.reader.withheldShipCredits.count, 1);
        h.socket.disconnect();
        assert.equal(h.reader.physicalIngressGeneration, 2);
        assert.equal(h.reader.ship.connected, true, 'obsolete physical close disabled the replacement connection');
        h.reader.onIpcMessage({event: 'resume'}); h.reader.onIpcMessage({event: 'resume'});
        assert.deepEqual(h.creditCommands().slice(before), [{socket: 2, request: ['get_blocks_ack_request_v0', {num_messages: 1}]}]);
        assert.equal(h.reader.withheldShipCredits, undefined);
        h.socket.open(); h.socket.message(h.frame); h.socket.error(new Error('retired transport')); h.socket.disconnect(); await h.drain();
        assert.equal(h.reader.ship.connected, true); assert.equal(h.reader.physicalIngressGeneration, 2);
        assert.equal(h.publications.length, 1); assert.equal(h.creditCommands().length, before + 1);
    } else if (scenario === 'monitor') {
        const bulk = await fixture(false), live = await fixture(true), signals = [];
        let queueSize = 64;
        const master = Object.assign(Object.create(HyperionMaster.prototype), {chain, conf: config,
            workerMap: [{worker_role: 'reader', wref: {send(value) {signals.push({role: 'reader', value}); bulk.reader.onIpcMessage(value);}}},
                {worker_role: 'continuous_reader', wref: {send(value) {signals.push({role: 'continuous_reader', value}); live.reader.onIpcMessage(value);}}},
                {worker_role: 'ds_pool_worker', local_id: 1}],
            manager: {async checkQueueSize(queue) {assert.equal(queue, chain + ':ds_pool:1'); return queueSize;}}});
        const monitor = new HyperionQueueMonitor(master);
        await monitor.checkQueues({}, 1000000);
        assert.equal(bulk.reader.allowRequests, false);
        assert.equal(live.reader.allowRequests, false, 'queue monitor must pause continuous_reader too');
        await monitor.checkQueues({}, 1000000);
        bulk.socket.message(bulk.frame); live.socket.message(live.frame); await Promise.all([bulk.drain(), live.drain()]);
        assert.equal(bulk.publications.length, 1); assert.equal(live.publications.length, 1);
        assert.equal(bulk.creditCommands().length, 0); assert.equal(live.creditCommands().length, 0);
        queueSize = 8; await monitor.checkQueues({}, 1000000);
        assert.equal(signals.length, 2, 'resume hysteresis must preserve pause at the threshold');
        queueSize = 7; await monitor.checkQueues({}, 1000000); await monitor.checkQueues({}, 1000000);
        assert.equal(bulk.reader.allowRequests, true); assert.equal(live.reader.allowRequests, true);
        for (const h of [bulk, live]) assert.deepEqual(h.creditCommands(), [{socket: 1, request: ['get_blocks_ack_request_v0', {num_messages: 1}]}]);
        assert.deepEqual(signals, [
            {role: 'reader', value: {event: 'pause'}}, {role: 'continuous_reader', value: {event: 'pause'}},
            {role: 'reader', value: {event: 'resume'}}, {role: 'continuous_reader', value: {event: 'resume'}}]);
    } else if (['credits', 'bulk-credits', 'legacy-credits'].includes(scenario)) {
        const h = await fixture(scenario !== 'bulk-credits', scenario === 'legacy-credits');
        const before = h.creditCommands().length;
        h.reader.onIpcMessage({event: 'pause'});
        h.socket.message(h.frame); await h.drain();
        assert.equal(h.publications.length, 1); assert(h.publications[0].content.equals(h.frame));
        assert.equal(h.creditCommands().length, before, 'paused reader returned SHIP block credit after confirmed publication');
        h.reader.onIpcMessage({event: 'resume'});
        assert.deepEqual(h.creditCommands().slice(before), [{socket: 1, request: ['get_blocks_ack_request_v0', {num_messages: 1}]}]);
        h.reader.onIpcMessage({event: 'resume'}); assert.equal(h.creditCommands().length, before + 1);
    } else if (scenario === 'coalesced-credits') {
        const h = await fixture();
        h.reader.onIpcMessage({event: 'pause'}); h.reader.onIpcMessage({event: 'pause'});
        for (let index = 0; index < 8; index++) {h.socket.message(h.frame); await h.drain();}
        assert.equal(h.creditCommands().length, 0); assert.equal(h.publications.length, 8);
        h.reader.onIpcMessage({event: 'pause'}); h.reader.onIpcMessage({event: 'resume'}); h.reader.onIpcMessage({event: 'resume'});
        assert.deepEqual(h.creditCommands(), [{socket: 1, request: ['get_blocks_ack_request_v0', {num_messages: 8}]}]);
    } else if (['pause-during-confirm', 'resume-before-confirm', 'pause-during-drain', 'resume-before-drain'].includes(scenario)) {
        const h = await fixture(), needsDrain = scenario.endsWith('drain');
        h.automatic(false); if (needsDrain) h.writable(false);
        h.socket.message(h.frame); await until(() => h.publications.length === 1, 'confirmed publication boundary not reached');
        assert.equal(h.creditCommands().length, 0, 'input credited before confirmation');
        h.reader.onIpcMessage({event: 'pause'});
        if (scenario.startsWith('resume')) h.reader.onIpcMessage({event: 'resume'});
        assert.equal(h.creditCommands().length, 0);
        h.publications[0].confirm();
        if (needsDrain) {
            await sleep(10); assert.equal(h.creditCommands().length, 0, 'input credited before publisher drain');
            h.writable(true); h.publisher.emit('drain');
        }
        await h.drain();
        if (scenario.startsWith('pause')) assert.equal(h.creditCommands().length, 0, 'pause during async processing was ignored');
        h.reader.onIpcMessage({event: 'resume'}); h.reader.onIpcMessage({event: 'resume'});
        assert.deepEqual(h.creditCommands(), [{socket: 1, request: ['get_blocks_ack_request_v0', {num_messages: 1}]}]);
        h.publications[0].confirm(); h.publisher.emit('drain'); assert.equal(h.creditCommands().length, 1);
    } else if (scenario === 'pause-during-retention') {
        const h = await fixture();
        let entered, release; const enteredPromise = new Promise(resolve => {entered = resolve;});
        const releasePromise = new Promise(resolve => {release = resolve;}); let held = false;
        h.memory.faults.beforeWrite = async () => {if (!held) {held = true; entered(); await releasePromise;}};
        h.socket.message(h.frame); await enteredPromise; h.reader.onIpcMessage({event: 'pause'}); release(); await h.drain();
        delete h.memory.faults.beforeWrite;
        assert.equal(h.publications.length, 1); assert.equal(h.creditCommands().length, 0);
        h.reader.onIpcMessage({event: 'resume'}); assert.equal(h.creditCommands().length, 1);
    } else if (['reconnect-withheld', 'reconnect-during-confirm', 'legacy-queued-before-reconnect'].includes(scenario)) {
        const legacy = scenario.startsWith('legacy'), h = await fixture(true, legacy);
        const before = h.creditCommands().length;
        h.reader.onIpcMessage({event: 'pause'});
        if (scenario === 'legacy-queued-before-reconnect') h.reader.blockReadingQueue.pause();
        else h.automatic(scenario !== 'reconnect-during-confirm');
        h.socket.message(h.frame);
        if (scenario === 'reconnect-withheld') await h.drain();
        else if (!legacy) await until(() => h.publications.length === 1, 'original confirmation not reached');
        const next = h.beginOpen();
        if (scenario === 'legacy-queued-before-reconnect') {
            h.reader.blockReadingQueue.resume(); await h.drain();
            assert.equal(h.publications.length, 0, 'old queued raw frame used the replacement session');
        } else if (scenario === 'reconnect-during-confirm') {h.publications[0].confirm(); await h.drain();}
        else await h.drain();
        h.socket.open(); assert.equal(h.reader.physicalIngressGeneration, 2, 'obsolete open restored old connection');
        h.socket.disconnect(); assert.equal(h.reader.physicalIngressGeneration, 2, 'obsolete close disabled replacement connection');
        h.reader.onIpcMessage({event: 'resume'});
        assert.equal(h.creditCommands().length, before, 'old input credit reached the replacement socket');
        await h.handshake(next);
        const afterHandshake = h.creditCommands().length;
        h.automatic(true); next.message(h.frame); await h.drain();
        assert.deepEqual(h.creditCommands().slice(afterHandshake), [{socket: 2, request: ['get_blocks_ack_request_v0', {num_messages: 1}]}]);
    } else if (scenario === 'legacy-reconnect-during-drain') {
        const h = await fixture(true, true), before = h.creditCommands().length;
        h.writable(false); h.reader.onIpcMessage({event: 'pause'});
        // Both original deliveries enter the same legacy cargo. Reconnect while
        // its first confirmed publication still awaits publisher drain.
        h.socket.message(h.frame); h.socket.message(h.frame);
        await until(() => h.publications.length === 1, 'legacy drain boundary not reached');
        const next = h.beginOpen(); h.writable(true); h.publisher.emit('drain'); await h.drain();
        assert.equal(h.publications.length, 1, 'old cargo decoded another frame using a replacement session');
        h.reader.onIpcMessage({event: 'resume'}); assert.equal(h.creditCommands().length, before);
        await h.handshake(next); const afterHandshake = h.creditCommands().length;
        next.message(h.frame); await h.drain();
        assert.deepEqual(h.creditCommands().slice(afterHandshake), [{socket: 2, request: ['get_blocks_ack_request_v0', {num_messages: 1}]}]);
    } else if (['legacy-preopen-close', 'legacy-preopen-next-server'].includes(scenario)) {
        const h = await fixture(true, true), before = h.creditCommands().length;
        h.reader.onIpcMessage({event: 'pause'}); h.socket.message(h.frame); await h.drain();
        h.reader.startWS(); h.reader.ship.connected = false;
        const attempt = h.sockets.at(-1);
        assert.equal(h.reader.socketGeneration, 2); assert.equal(h.reader.physicalIngressGeneration, undefined);
        const endpoints = [{node: {url: 'ws://owned-first.invalid'}}, {node: {url: 'ws://owned-second.invalid'}}];
        const reconnects = [], connectedUrls = []; let nextUrlCalls = 0, closes = 0;
        const connect = h.reader.ship.connect;
        Object.assign(h.reader.ship, {shipNodes: endpoints, selectedUrlIndex: 0, shipNode: endpoints[0].node,
            nextUrl() {nextUrlCalls++; StateHistorySocket.prototype.nextUrl.call(this);},
            close() {closes++; this.connected = false; attempt.disconnect();},
            connect(...args) {connectedUrls.push(this.shipNode.url); connect(...args);}});
        const originalSetTimeout = globalThis.setTimeout;
        try {
            globalThis.setTimeout = (callback, delay, ...args) => {
                if (delay === 5000) {reconnects.push(() => callback(...args)); return {unref() {return this;}};}
                return originalSetTimeout(callback, delay, ...args);
            };
            if (scenario === 'legacy-preopen-next-server') h.reader.onIpcMessage({event: 'next_server'});
            else attempt.disconnect();
            attempt.disconnect(); h.socket.disconnect();
            assert.equal(reconnects.length, 1, 'active connection failure before open must schedule exactly one reconnect');
            assert.equal(nextUrlCalls, 1); assert.equal(closes, 1);
            attempt.open(); h.socket.open();
            assert.equal(h.reader.physicalIngressGeneration, undefined, 'retired attempt reopened before its replacement');
            reconnects[0](); h.reader.ship.connected = true;
            const next = h.sockets.at(-1);
            attempt.open(); attempt.disconnect();
            assert.equal(h.reader.physicalIngressGeneration, undefined);
            next.open(); await h.drain();
            assert.equal(h.reader.socketGeneration, 3); assert.equal(h.reader.physicalIngressGeneration, 3);
            attempt.open(); attempt.disconnect(); h.socket.open(); h.socket.disconnect();
            assert.equal(h.reader.physicalIngressGeneration, 3);
            assert.equal(reconnects.length, 1); assert.equal(nextUrlCalls, 1);
            assert.deepEqual(connectedUrls, [endpoints[1].node.url]);
            h.reader.onIpcMessage({event: 'resume'}); assert.equal(h.creditCommands().length, before);
            await h.handshake(next); const afterHandshake = h.creditCommands().length;
            next.message(h.frame); await h.drain();
            assert.deepEqual(h.creditCommands().slice(afterHandshake), [{socket: 3, request: ['get_blocks_ack_request_v0', {num_messages: 1}]}]);
        } finally {globalThis.setTimeout = originalSetTimeout;}
    } else if (['next-server', 'legacy-next-server'].includes(scenario)) {
        const h = await fixture(true, scenario.startsWith('legacy')), before = h.creditCommands().length;
        const endpoints = [{node: {url: 'ws://owned-first.invalid'}}, {node: {url: 'ws://owned-second.invalid'}}];
        const connectedUrls = [], reconnects = []; let nextUrlCalls = 0, closes = 0;
        const connect = h.reader.ship.connect;
        Object.assign(h.reader.ship, {shipNodes: endpoints, selectedUrlIndex: 0, shipNode: endpoints[0].node,
            nextUrl() {nextUrlCalls++; StateHistorySocket.prototype.nextUrl.call(this);},
            close() {closes++; this.connected = false; h.socket.disconnect();},
            connect(...args) {connectedUrls.push(this.shipNode.url); connect(...args);}});
        h.reader.onIpcMessage({event: 'pause'}); h.socket.message(h.frame); await h.drain();
        assert.equal(h.creditCommands().length, before);
        const originalSetTimeout = globalThis.setTimeout;
        try {
            globalThis.setTimeout = (callback, delay, ...args) => {
                if (delay === 5000) {reconnects.push(() => callback(...args)); return {unref() {return this;}};}
                return originalSetTimeout(callback, delay, ...args);
            };
            h.reader.onIpcMessage({event: 'next_server'});
            h.socket.disconnect(); h.socket.disconnect();
            assert.equal(reconnects.length, 1, 'next_server must schedule exactly one reconnect');
            assert.equal(nextUrlCalls, 1, 'stale close callbacks must not rotate the endpoint again');
            assert.equal(closes, 1); assert.equal(h.reader.ship.shipNode.url, endpoints[1].node.url);
            assert.equal(h.reader.physicalIngressGeneration, undefined);
            reconnects[0](); h.reader.ship.connected = true;
            const next = h.sockets.at(-1); next.open(); await h.drain();
            assert.deepEqual(connectedUrls, [endpoints[1].node.url]);
            assert.equal(h.reader.socketGeneration, 2); assert.equal(h.reader.physicalIngressGeneration, 2);
            h.socket.open(); h.socket.disconnect();
            assert.equal(h.reader.physicalIngressGeneration, 2);
            assert.equal(reconnects.length, 1); assert.equal(nextUrlCalls, 1);
            h.reader.onIpcMessage({event: 'resume'}); assert.equal(h.creditCommands().length, before);
            await h.handshake(next); const afterHandshake = h.creditCommands().length;
            next.message(h.frame); await h.drain();
            assert.deepEqual(h.creditCommands().slice(afterHandshake), [{socket: 2, request: ['get_blocks_ack_request_v0', {num_messages: 1}]}]);
        } finally {globalThis.setTimeout = originalSetTimeout;}
    } else if (['close-withheld', 'legacy-close-withheld'].includes(scenario)) {
        const h = await fixture(true, scenario.startsWith('legacy')), before = h.creditCommands().length;
        h.reader.onIpcMessage({event: 'pause'}); h.socket.message(h.frame); await h.drain();
        const originalSetTimeout = globalThis.setTimeout; let reconnect;
        try {
            globalThis.setTimeout = (callback, delay, ...args) => {
                if (delay === 5000) {reconnect = () => callback(...args); return {unref() {return this;}};}
                return originalSetTimeout(callback, delay, ...args);
            };
            h.reader.ship.connected = false; h.socket.disconnect();
        } finally {globalThis.setTimeout = originalSetTimeout;}
        assert.equal(typeof reconnect, 'function');
        assert.equal(h.reader.physicalIngressGeneration, undefined);
        h.reader.onIpcMessage({event: 'resume'}); assert.equal(h.creditCommands().length, before);
        reconnect(); h.reader.ship.connected = true; const next = h.sockets.at(-1); next.open(); await h.drain();
        await h.handshake(next); const afterHandshake = h.creditCommands().length;
        next.message(h.frame); await h.drain();
        assert.deepEqual(h.creditCommands().slice(afterHandshake), [{socket: 2, request: ['get_blocks_ack_request_v0', {num_messages: 1}]}]);
    } else if (scenario === 'session-replacement') {
        const h = await fixture(); h.reader.onIpcMessage({event: 'pause'}); h.socket.message(h.frame); await h.drain();
        await h.reader.initializeProtocolShip(schemaJson); h.reader.onIpcMessage({event: 'resume'});
        assert.equal(h.creditCommands().length, 0, 'old session credits survived decoder/session replacement');
    } else if (scenario === 'revoked-source') {
        const h = await fixture(); h.reader.onIpcMessage({event: 'pause'}); h.socket.message(h.frame); await h.drain();
        h.reader.revokeCoordinatorSource(); h.reader.onIpcMessage({event: 'resume'});
        assert.equal(h.creditCommands().length, 0, 'revoked source retained usable credits');
    } else if (scenario === 'finish-cannot-resume') {
        const h = await fixture(); h.reader.onIpcMessage({event: 'pause'}); h.socket.message(h.frame); await h.drain();
        await assert.rejects(h.reader.finishReader(), /Reader range is incomplete/);
        h.reader.onIpcMessage({event: 'resume'});
        assert.equal(h.reader.allowRequests, false); assert.equal(h.creditCommands().length, 0);
    } else if (scenario === 'stop-cannot-resume') {
        const h = await fixture(); h.reader.onIpcMessage({event: 'pause'}); h.socket.message(h.frame); await h.drain();
        const originalSetTimeout = globalThis.setTimeout; let exits = 0;
        try {
            globalThis.setTimeout = (callback, delay, ...args) => {
                if (delay === 2000) {exits++; return {unref() {return this;}};}
                return originalSetTimeout(callback, delay, ...args);
            };
            h.reader.onIpcMessage({event: 'stop'});
        } finally {globalThis.setTimeout = originalSetTimeout;}
        assert.equal(exits, 1); h.reader.onIpcMessage({event: 'resume'});
        assert.equal(h.reader.allowRequests, false); assert.equal(h.creditCommands().length, 0);
    } else if (scenario === 'range-scheduling') {
        const h = await fixture(false), before = h.commands.length;
        h.reader.onIpcMessage({event: 'pause'});
        h.reader.newRange({first_block: 40, last_block: 42, assignment_id: 'paused-range'});
        assert.equal(h.commands.length, before); assert.deepEqual(h.reader.pendingRequest, [40, 42]);
        h.reader.onIpcMessage({event: 'resume'}); h.reader.onIpcMessage({event: 'resume'});
        const request = h.commands.slice(before); assert.equal(request.length, 1);
        assert.equal(request[0].request[0], 'get_blocks_request_v0');
        assert.equal(request[0].request[1].start_block_num, 40); assert.equal(request[0].request[1].end_block_num, 42);
        assert.equal(request[0].request[1].max_messages_in_flight, 8); assert.equal(h.reader.pendingRequest, null);
    } else if (['failure-nack', 'failure-unknown-close'].includes(scenario)) {
        const h = await fixture(); await h.reader.assertQueues();
        h.reader.onIpcMessage({event: 'pause'}); h.automatic(false);
        h.socket.message(h.frame); await until(() => h.publications.length === 1, 'publication failure boundary not reached');
        process.on('exit', code => {
            assert.equal(code, 1); assert.equal(h.creditCommands().length, 0);
            assert.equal(h.reader.allowRequests, false); assert(h.reader.publisherFailure);
            console.log(JSON.stringify({passed: true, scenario, originalWireFrame, actualReaderMonitorAndEncoding: scenario !== 'socket-callbacks',
                actualSocketWrapper: scenario.includes('socket-'), controlledTransports: true, productionQualification: false}));
        });
        if (scenario === 'failure-nack') h.publications[0].confirm(new Error('controlled broker NACK'));
        else h.publisher.emit('close');
        h.reader.onIpcMessage({event: 'resume'});
        await sleep(1000); throw new Error('reader did not exit after failed/unknown confirmation');
    } else throw new Error('Unknown reader backpressure scenario: ' + scenario);
    console.log(JSON.stringify({passed: true, scenario, originalWireFrame, actualReaderMonitorAndEncoding: scenario !== 'socket-callbacks',
        actualSocketWrapper: scenario.includes('socket-'), controlledTransports: true, productionQualification: false}));
} finally {cleanup();}
