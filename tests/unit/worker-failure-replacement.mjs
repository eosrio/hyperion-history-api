/** Original master relaunch timer and native cluster IPC; no storage or broker fault is emulated. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {WorkerAttemptSupervisor} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {installWorkerRejectionDiagnostics} from '../../scripts/qualification/worker-rejection-diagnostics.mjs';

const mode = process.argv[2] ?? 'single';
assert.ok(['single', 'coalesced', 'coalesced-reader'].includes(mode));
if (cluster.isWorker) {
    if (process.env.worker_role !== 'reader') new WorkerAttemptClient({mode: 'managed', role: process.env.worker_role, transport: process});
    process.on('message', message => {
        if (message.event === 'fixture_fail') process.exit(1);
        if (message.event === 'fixture_finish') process.exit(0);
    });
    process.send({event: 'fixture_ready'});
} else {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'hapi-worker-replacement-'));
    const rows = [], children = [], ready = [];
    const until = async (test, message) => {
        const end = performance.now() + 10000;
        while (!test()) {assert.ok(performance.now() < end, message); await delay(5);}
    };
    let master, supervisor;
    try {
        mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'config/connections.json'), '{}');
        const configuration = join(directory, 'chain.json');
        writeFileSync(configuration, JSON.stringify({settings: {chain: 'replacement-loop'}, indexer: {}, features: {}}));
        process.env.CONFIG_JSON = configuration;
        const previousDirectory = process.cwd(); process.chdir(directory);
        const [{default: Pool}, {default: Reader}, {default: Projection}, {HyperionMaster}, {HyperionWorker}] = await Promise.all([
            import('../../build/indexer/workers/ds-pool.js'), import('../../build/indexer/workers/state-reader.js'),
            import('../../build/indexer/workers/projection.js'), import('../../build/indexer/modules/master.js'),
            import('../../build/indexer/workers/hyperionWorker.js')]);
        process.chdir(previousDirectory);
        const diagnostics = installWorkerRejectionDiagnostics({Pool, Reader, Projection, Master: HyperionMaster,
            WorkerClient: WorkerAttemptClient, WorkerHost: HyperionWorker, Supervisor: WorkerAttemptSupervisor, cluster,
            record(event, value) {rows.push({event, ...value});}});
        supervisor = new WorkerAttemptSupervisor();
        const definition = {worker_id: 1, worker_role: 'projection'};
        const definitions = [definition];
        if (mode !== 'single') definitions.push({worker_id: 2, worker_role: mode === 'coalesced-reader' ? 'reader' : 'projection'});
        master = Object.assign(Object.create(HyperionMaster.prototype), {workerMap: [...definitions], chain: 'replacement-loop',
            workerAttemptSupervisor: supervisor, dsPoolMap: new Map(),
            handleMessage(worker, message) {if (message.event === 'fixture_ready') ready.push(worker);}});
        cluster.on('fork', worker => {
            children.push(worker); worker.process.stdout.resume(); worker.process.stderr.resume();
        });
        // Exact registration/call shape used by startIndexing; actual cluster emits the disconnect.
        cluster.on('disconnect', worker => master.handleWorkerDisconnect(worker));
        cluster.setupPrimary({exec: fileURLToPath(import.meta.url), silent: true});
        master.launchWorkers();
        const originals = definitions.map(value => value.wref);
        await until(() => originals.every(worker => ready.includes(worker)), 'Initial original workers become ready');
        for (const original of originals) {
            original.send({event: 'fixture_fail'});
            await until(() => rows.some(row => row.event === 'worker_replacement_requested' && row.previous.pid === original.process.pid),
                'Each original disconnect schedules its own request before the first relaunch sweep');
        }
        // A new definition launched by that same sweep has no previous physical worker.
        const unrelated = mode === 'single' ? null : {worker_id: 9, worker_role: 'projection'};
        if (unrelated) master.workerMap.push(unrelated);
        await until(() => definitions.every((value, index) => value.wref && value.wref !== originals[index] && ready.includes(value.wref))
            && (!unrelated || unrelated.wref && ready.includes(unrelated.wref)), 'Original 5000ms relaunch sweep forks all pending workers');
        assert.equal(rows.filter(row => row.event === 'worker_replacement_forked').length, definitions.length);
        const firstRequest = rows.find(row => row.event === 'worker_replacement_requested');
        for (let index = 0; index < definitions.length; index++) {
            const definition = definitions[index], original = originals[index], replacement = definition.wref;
            const disconnected = rows.find(row => row.event === 'physical_worker_disconnected' && row.child.pid === original.process.pid);
            const requested = rows.find(row => row.event === 'worker_replacement_requested' && row.previous.pid === original.process.pid);
            const forked = rows.find(row => row.event === 'worker_replacement_forked' && row.previous.pid === original.process.pid);
            const attached = rows.find(row => row.event === 'replacement_owner_attached' && row.previous.pid === original.process.pid);
            assert.ok(disconnected); assert.ok(requested); assert.ok(forked);
            assert.equal(forked.triggerRequestId, firstRequest.requestId);
            assert.equal(requested.disconnectId, disconnected.disconnectId);
            assert.equal(forked.requestId, requested.requestId);
            assert.notEqual(forked.replacementId, forked.requestId);
            assert.deepEqual(requested.previous, disconnected.child);
            assert.deepEqual(forked.previous, disconnected.child);
            assert.equal(forked.child.pid, replacement.process.pid);
            assert.notEqual(forked.child.pid, original.process.pid);
            if (definition.worker_role !== 'reader') {
                assert.ok(attached); assert.equal(attached.requestId, requested.requestId);
                assert.equal(attached.replacementId, forked.replacementId); assert.deepEqual(attached.child, forked.child);
                assert.equal(attached.parentEpoch, supervisor.epoch);
                assert.equal(attached.parentIncarnation, supervisor.owners.get(replacement).incarnation);
                const originalOwner = rows.find(row => row.event === 'attempt_owner_attached' && row.child.pid === original.process.pid);
                assert.notEqual(attached.parentIncarnation, originalOwner.parentIncarnation);
                assert.deepEqual(requested.previousOwner, {epoch: originalOwner.parentEpoch, incarnation: originalOwner.parentIncarnation});
            } else {assert.equal(attached, undefined); assert.equal(requested.previousOwner, null);}
            assert.deepEqual(forked.previousOwner, requested.previousOwner);
            assert.equal(rows.find(row => row.event === 'physical_worker_exited' && row.child.pid === original.process.pid).code, 1);
            assert.equal(definition.failures, 1);
            // A copied description or a stale real Worker cannot schedule or join another replacement.
            const before = rows.filter(row => row.event === 'worker_replacement_requested').length;
            master.handleWorkerDisconnect({id: original.id, process: {pid: original.process.pid}});
            master.handleWorkerDisconnect(original);
            assert.equal(rows.filter(row => row.event === 'worker_replacement_requested').length, before);
            assert.equal(definition.wref, replacement);
        }
        assert.equal(new Set(rows.filter(row => row.event === 'worker_replacement_forked').map(row => row.requestId)).size, definitions.length);
        if (unrelated) assert.ok(!rows.some(row => row.event === 'worker_replacement_forked' && row.child.pid === unrelated.wref.process.pid));
        master.shutdownStarted = true;
        const survivors = [...definitions, ...(unrelated ? [unrelated] : [])].map(value => value.wref);
        for (const worker of survivors) worker.send({event: 'fixture_finish'});
        await until(() => survivors.every(worker => rows.some(row => row.event === 'physical_worker_exited' && row.child.pid === worker.process.pid)),
            'Every replacement original exit callback is retained');
        for (const worker of survivors) assert.equal(rows.find(row => row.event === 'physical_worker_exited' && row.child.pid === worker.process.pid).code, 0);
        assert.equal(diagnostics.snapshot().reportFailures, 0);
        assert.equal(rows.filter(row => row.event === 'worker_replacement_forked').length, definitions.length);
        console.log(JSON.stringify({passed: true, node: process.versions.node, originalExit: 1, replacementExit: 0,
            actualClusterCallbacks: true, originalRelaunchDelayMs: 5000, controlledServices: true, faultMembership: false,
            scenario: mode, replacements: definitions.length, unrelatedForkUnassociated: true}));
    } finally {
        if (master) master.shutdownStarted = true;
        supervisor?.stop();
        for (const child of children) if (child.process.exitCode === null && child.process.signalCode === null) child.kill();
        assert.ok(directory.startsWith(join(realpathSync(tmpdir()), 'hapi-worker-replacement-')));
        rmSync(directory, {recursive: true, force: true});
    }
}
