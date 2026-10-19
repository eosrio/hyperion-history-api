import {expect, it} from 'bun:test';
import {resolve} from 'node:path';

// The native master imports uWebSockets. Exercise its emitted Node artifacts,
// with the CI Node22/24 runtime, instead of loading that addon through Bun.
it('retains current assignments, fences replaced workers and waits for all readers', async () => {
    const source = new URL('../../build/indexer/modules/master.js', import.meta.url).href;
    const script = `
        import assert from 'node:assert/strict';
        import cluster from 'node:cluster';
        import {EventEmitter} from 'node:events';
        const {HyperionMaster} = await import(${JSON.stringify(source)});
        const sent = [];
        function worker(id) {
            return Object.assign(new EventEmitter(), {id, isConnected() {return true;}, send(msg) {sent.push({id, msg});}, kill() {this.killed = true;}});
        }
        function master(definitions, fields = {}) {
            const result = Object.assign(Object.create(HyperionMaster.prototype), {
                workerMap: definitions, activeReadersCount: 2, max_readers: 2, lastAssignedBlock: 20,
                maxBatchSize: 10, head: 40, allowMoreReaders: true, indexerMonitor: {},
                pendingRepairRanges: [], dsPoolMap: new Map(), ...fields
            });
            result.initHandlerMap();
            return result;
        }
        const initial = worker(1);
        const definition = {worker_id: 1, worker_role: 'reader', first_block: 10, last_block: 20,
            reader_assignment: 'initial', wref: initial};
        cluster.workers = {1: initial};
        const m = master([definition]);
        m.msgHandlerMap.completed(initial, {event: 'completed', id: '1', assignment_id: 'wrong'});
        assert.equal(definition.first_block, 10);
        assert.equal(m.activeReadersCount, 2);
        m.msgHandlerMap.completed(initial, {event: 'completed', id: '1', assignment_id: 'initial'});
        assert.equal(definition.first_block, 20);
        assert.equal(definition.last_block, 30);
        const assignment = definition.reader_assignment;
        assert.notEqual(assignment, 'initial');
        assert.equal(sent.at(-1).msg.data.assignment_id, assignment);
        const originalFork = cluster.fork;
        let forkEnvironment;
        cluster.fork = env => {forkEnvironment = {...env}; return worker(2);};
        const timers = [];
        const originalTimeout = globalThis.setTimeout;
        globalThis.setTimeout = (callback, ms) => {timers.push({callback, ms}); return {unref(){}};};
        try {m.handleWorkerDisconnect(initial);} finally {globalThis.setTimeout = originalTimeout;}
        assert.equal(definition.wref, undefined);
        m.launchWorkers();
        assert.equal(forkEnvironment.first_block, 20);
        assert.equal(forkEnvironment.last_block, 30);
        assert.equal(forkEnvironment.reader_assignment, assignment);
        let accepted = 0;
        m.handleMessage = () => accepted++;
        const replacement = definition.wref;
        replacement.emit('message', {event: 'read_block'});
        assert.equal(accepted, 1);
        // A late old disconnect must not clear the replacement definition.
        m.handleWorkerDisconnect(initial);
        assert.equal(definition.wref, replacement);
        cluster.fork = originalFork;

        const repair = worker(3);
        const repairDefinition = {worker_id: 3, worker_role: 'repair_reader', wref: repair};
        const r = master([repairDefinition], {repairReader: repairDefinition,
            pendingRepairRanges: [{start: 100, end: 109}, {start: 200, end: 209}]});
        r.sendPendingRepairRanges();
        const activeRepair = repairDefinition.reader_assignment;
        assert.deepEqual([repairDefinition.first_block, repairDefinition.last_block], [100, 110]);
        const newRepair = worker(4);
        repairDefinition.wref = newRepair;
        r.msgHandlerMap.repair_reader_ready(newRepair, {event: 'repair_reader_ready'});
        assert.equal(r.pendingRepairRanges.length, 1, 'shifted next repair before interrupted assignment completed');
        assert.equal(sent.at(-1).msg.data.assignment_id, activeRepair);
        r.msgHandlerMap.completed(newRepair, {event: 'completed', id: '3', assignment_id: activeRepair});
        assert.deepEqual([repairDefinition.first_block, repairDefinition.last_block], [200, 210]);

        const a = worker(10), b = worker(11);
        const da = {worker_id: 10, worker_role: 'reader', reader_assignment: 'a', wref: a};
        const db = {worker_id: 11, worker_role: 'reader', reader_assignment: 'b', wref: b};
        const last = master([da, db], {lastAssignedBlock: 40});
        last.msgHandlerMap.completed(a, {event: 'completed', id: '10', assignment_id: 'a'});
        assert.equal(sent.at(-1).msg.event, 'finish');
        assert.equal(b.killed, undefined, 'killed an unfinished assigned reader');
        assert.equal(last.activeReadersCount, 1);
        last.msgHandlerMap.completed(b, {event: 'completed', id: '11', assignment_id: 'b'});
        assert.equal(sent.at(-1).id, 11);
        assert.equal(sent.at(-1).msg.event, 'finish');
        assert.equal(last.activeReadersCount, 0);
        console.log('master-reader-recovery-passed');
    `;
    const node = process.env.READER_RECOVERY_NODE ?? Bun.which('node');
    if (!node) throw new Error('Node.js22/24 is required for the native master recovery test');
    const child = Bun.spawn([resolve(node), '--input-type=module', '--eval', script], {stdout: 'pipe', stderr: 'pipe'});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr}).toEqual({code: 0, stderr: ''});
    expect(stderr).toBe('');
    expect(stdout).toContain('master-reader-recovery-passed');
}, 15000);
