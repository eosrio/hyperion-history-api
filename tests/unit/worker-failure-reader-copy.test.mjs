import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {installWorkerFailureDiagnostics} from '../../scripts/qualification/worker-failure-diagnostics.mjs';

async function scenario(mode) {
    const cluster = new EventEmitter(); cluster.isPrimary = true;
    let nextPid = 10;
    cluster.fork = () => ({process: {pid: ++nextPid}});
    class Master {
        handleWorkerDisconnect(worker) {
            const definition = this.workerMap.find(item => item.wref === worker);
            definition.wref = undefined; definition.failures = (definition.failures ?? 0) + 1;
        }
        launchWorkers() {
            const definition = this.workerMap[0], copy = {...definition, reader_pressure_sync: 'true'};
            const worker = cluster.fork(mode === 'identity' ? definition : copy);
            if (['assigned', 'identity', 'ambiguous', 'nonpending'].includes(mode)) definition.wref = worker;
            if (mode === 'ambiguous') this.workerMap.push({worker_id: 9, worker_role: 'reader', wref: worker});
            if (mode === 'wrong-role') {definition.worker_role = 'projection'; definition.wref = worker;}
            if (mode === 'other-master') other.workerMap[0].wref = worker;
        }
        relaunchDisconnectedWorker() {this.launchWorkers();}
    }
    const rows = [], failures = [];
    installWorkerFailureDiagnostics({Master, cluster, workerIdentity: worker => ({pid: worker.process.pid}),
        emit: (event, snapshot) => rows.push({event, ...snapshot()}), failed: () => failures.push(true)});
    const old = {process: {pid: 1}}, definition = {worker_id: 2, worker_role: 'reader', wref: old};
    const master = new Master(); master.workerMap = [definition];
    const other = new Master(); other.workerMap = [{worker_id: 2, worker_role: 'reader'}];
    if (mode === 'nonpending') {
        definition.wref = undefined;
        master.launchWorkers();
    } else {
        cluster.emit('fork', old); cluster.emit('disconnect', old); master.handleWorkerDisconnect(old);
        master.relaunchDisconnectedWorker(old, definition);
    }
    await Promise.resolve();
    assert.deepEqual(failures, []);
    return rows.filter(row => row.event === 'worker_replacement_forked');
}

test('reader association uses the actual assigned Worker, not a matching fork environment', async () => {
    assert.equal((await scenario('assigned')).length, 1);
    assert.equal((await scenario('identity')).length, 1);
    for (const mode of ['forged-unassigned', 'ambiguous', 'nonpending', 'wrong-role', 'other-master'])
        assert.equal((await scenario(mode)).length, 0, mode);
});
