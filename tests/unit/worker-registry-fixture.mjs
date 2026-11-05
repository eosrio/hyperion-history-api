import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {once} from 'node:events';
import {registerHooks} from 'node:module';

if (cluster.isWorker) {
    process.on('message', message => {
        if (message.command === 'crash') process.exit(1);
        if (message.command === 'echo') process.send({event: 'registry_echo', token: message.token});
        if (message.command === 'reload') process.send({event: 'config_reloaded', worker_id: 'untrusted'});
        if (message.command === 'retire') process.send({event: 'kill_worker', id: message.id});
        if (message.command === 'ready') process.send({event: 'registry_ready', logical: Number(process.env.worker_id), physical: cluster.worker.id});
        if (message.event === 'initialize_abi') process.send({event: 'registry_abi', data: message.data});
    });
} else {
    // Native codecs and HTTP listeners are outside this cluster lifecycle test.
    // Fail if exercised, while keeping the actual master and Node cluster intact.
    const nativeStubs = {
        '@eosrio/node-abieos': 'export class Abieos {static getInstance() {throw new Error("Unexpected codec use in cluster fixture");}}',
        'uWebSockets.js': 'export function App() {throw new Error("Unexpected listener use in cluster fixture");}'
    };
    registerHooks({resolve(specifier, context, next) {
        if (nativeStubs[specifier]) return {url: `data:text/javascript,${encodeURIComponent(nativeStubs[specifier])}`, shortCircuit: true};
        return next(specifier, context);
    }});
    // Use the actual emitted master and real Node cluster. Avoid its constructor,
    // which would open database connections; only external services are stubbed.
    const {HyperionMaster} = await import('../../build/indexer/modules/master.js');
    const routingOnly = process.argv.includes('--routing');
    const timers = [];
    const seen = [];
    const owned = new Set();
    const counts = [];
    const definitions = [
        {worker_id: routingOnly ? 3 : 1, worker_role: 'deserializer', worker_queue: 'fixture:live_blocks'},
        {worker_id: 2, worker_role: 'ds_pool_worker', local_id: 7},
        {worker_id: routingOnly ? 99 : 3, worker_role: 'router'}
    ];
    const master = Object.assign(Object.create(HyperionMaster.prototype), {
        workerMap: definitions, dsPoolMap: new Map(), pendingReloadPromises: new Map(),
        chain: 'fixture', cachedInitABI: 'fixture-ship-abi', shutdownStarted: false,
        workerAttemptSupervisor: {attach() {}, retire() {}},
        localController: {pauses: {onWorkerResponse(id, message) {seen.push({id, message});}}}
    });
    master.initHandlerMap();
    master.msgHandlerMap.registry_echo = (worker, message) => seen.push({worker, message});
    master.msgHandlerMap.registry_ready = () => {};
    master.msgHandlerMap.registry_abi = () => {};

    // Drive production restart callbacks without waiting five seconds per crash.
    // Real child exit/disconnect and registry cleanup still run on Node itself.
    function disconnected(worker) {
        const realTimeout = globalThis.setTimeout;
        globalThis.setTimeout = (callback, ms) => {timers.push({callback, ms}); return {unref() {}};};
        try { master.handleWorkerDisconnect(worker); }
        finally { globalThis.setTimeout = realTimeout; }
    }
    cluster.on('disconnect', disconnected);
    cluster.on('fork', worker => owned.add(worker));
    async function reply(worker, event, command) {
        const response = new Promise(resolve => {
            const listener = message => {
                if (message.event !== event) return;
                worker.off('message', listener);
                resolve(message);
            };
            worker.on('message', listener);
        });
        worker.send(command);
        return response;
    }
    async function ready(worker) { return reply(worker, 'registry_ready', {command: 'ready'}); }
    function runTimer(ms) {
        const index = timers.findIndex(timer => timer.ms === ms);
        assert.notEqual(index, -1, `missing ${ms}ms restart callback`);
        const [timer] = timers.splice(index, 1);
        const realTimeout = globalThis.setTimeout;
        globalThis.setTimeout = (callback, delay) => {timers.push({callback, ms: delay}); return {unref() {}};};
        try { timer.callback(); } finally { globalThis.setTimeout = realTimeout; }
    }
    const deadline = setTimeout(() => {console.error('worker registry fixture timed out'); process.exit(1);}, 15000);
    try {
        master.launchWorkers();
        await Promise.all(definitions.map(definition => ready(definition.wref)));
        assert.equal(master.dsPoolMap.get(7), definitions[1].wref);
        assert.equal(master.wsRouterWorker, definitions[2].wref);
        for (let cycle = 0; cycle < 6; cycle++) {
            const definition = definitions[cycle % 2];
            const old = definition.wref;
            const before = await ready(old);
            const exited = once(old, 'exit');
            old.send({command: 'crash'});
            await exited;
            assert.equal(definition.wref, undefined, 'disconnect must find the current physical owner');
            if (!routingOnly) assert.equal(Object.keys(cluster.workers).length, 2, 'dead worker retained in Node registry');
            runTimer(5000);
            const current = definition.wref;
            const identity = await ready(current);
            assert.equal(identity.logical, definition.worker_id);
            if (!routingOnly) {
                assert.notEqual(identity.physical, before.physical);
                assert.equal(current.id, identity.physical, 'Node Worker.id was overwritten with a logical slot ID');
                assert.equal(cluster.workers[identity.physical], current);
                assert.equal(cluster.workers[before.physical], undefined);
            }
            // The nested ABI callback must still reach the replacement.
            const abiResponse = definition.worker_role === 'deserializer' ? once(current, 'message') : null;
            runTimer(1000);
            if (abiResponse) assert.equal((await abiResponse)[0].data, master.cachedInitABI);
            if (definition.worker_role === 'ds_pool_worker') assert.equal(master.dsPoolMap.get(7), current);

            // A retired physical owner cannot impersonate its replacement.
            const stale = `stale-${cycle}`;
            old.emit('message', {event: 'registry_echo', token: stale});
            assert.ok(!seen.some(item => item.message.token === stale), 'stale owner message reached current handler');
            disconnected(old);
            assert.equal(definition.wref, current, 'late disconnect cleared the replacement');
            assert.equal(timers.length, 0, 'late disconnect scheduled an extra replacement');

            let reloaded = 0;
            master.pendingReloadPromises.set(definition.worker_id, () => reloaded++);
            master.msgHandlerMap.config_reloaded(old, {event: 'config_reloaded'});
            assert.equal(reloaded, 0, 'retired owner acknowledged a current configuration reload');
            await reply(current, 'config_reloaded', {command: 'reload'});
            assert.equal(reloaded, 1, 'logical reload promise was not resolved by the current physical worker');
            assert.equal(master.pendingReloadPromises.has(definition.worker_id), false);

            const token = `current-${cycle}`;
            await reply(current, 'registry_echo', {command: 'echo', token});
            assert.equal(seen.find(item => item.message.token === token)?.worker, current);
            if (master.msgHandlerMap.indexer_pause_failed) {
                master.msgHandlerMap.indexer_paused(current, {event: 'indexer_paused'});
                assert.equal(seen.at(-1).id, identity.physical, 'pause coordinator must retain physical worker identity');
            }
            counts.push(Object.keys(cluster.workers).length);
        }
        // Logical retirement must not kill an unrelated worker whose native ID
        // happens to equal the requested logical ID. Unknown IDs are no-ops.
        const current = definitions[0].wref;
        const retiringId = definitions[0].worker_id;
        const survivorDefinition = definitions[2];
        const survivor = survivorDefinition.wref;
        master.msgHandlerMap.kill_worker(current, {event: 'kill_worker', id: '999999'});
        assert.equal(master.workerMap.length, 3);
        const retired = Promise.race([once(current, 'exit'), once(survivor, 'exit').then(() => {
            throw new Error('logical retirement killed the unrelated native worker');
        })]);
        current.send({command: 'retire', id: String(retiringId)});
        await retired;
        assert.equal(master.workerMap.some(definition => definition.worker_id === retiringId), false);
        assert.equal(survivorDefinition.wref, survivor);
        assert.equal(survivor.isConnected(), true);
        assert.equal(timers.length, 0, 'deliberately retired worker was scheduled for replacement');
        if (!routingOnly) assert.equal(Object.keys(cluster.workers).length, 2);
        console.log(JSON.stringify({passed: true, mode: routingOnly ? 'routing' : 'registry', replacements: 6, counts}));
    } finally {
        clearTimeout(deadline);
        master.shutdownStarted = true;
        cluster.off('disconnect', disconnected);
        await Promise.all([...owned].filter(worker => !worker.isDead()).map(async worker => {
            const exited = once(worker, 'exit');
            worker.kill();
            await exited;
        }));
    }
    if (!routingOnly) assert.deepEqual(Object.keys(cluster.workers), [], 'worker registry must be empty after shutdown');
}
