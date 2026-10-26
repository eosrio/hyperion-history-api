/** Original managed worker callbacks with controlled storage/channels; no source or semantic completion authority. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {installWorkerRejectionDiagnostics} from '../../scripts/qualification/worker-rejection-diagnostics.mjs';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd, workerAttemptDigest} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
const previous = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'hapi-fence-origin-'));
const mode = process.argv[2] ?? 'active';
assert.ok(['active', 'source-open', 'channel-close', 'retire', 'deferred', 'copied', 'stale',
    'control', 'unrelated-error', 'bounded', 'sink-failure'].includes(mode));
let client;
try {
    mkdirSync(join(directory, 'config'));
    const conf = {settings: {chain: 'fence-origin', parser: '3.2', index_version: 'v1', index_partition_size: 1000},
        indexer: {}, whitelists: {actions: [], deltas: []}, blacklists: {}, plugins: {}};
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(conf)); writeFileSync(join(directory, 'config/connections.json'), '{}');
    process.env.CONFIG_JSON = join(directory, 'chain.json'); process.chdir(directory);
    const [{default: Pool}, {default: Reader}, {actionProducerEpoch}, {actionSourceAdmissionHeader}, {currentProofConsumerScope}, {HyperionWorker}] = await Promise.all([
        import('../../build/indexer/workers/ds-pool.js'), import('../../build/indexer/workers/state-reader.js'),
        import('../../build/indexer/history/action-producer-epoch.js'), import('../../build/indexer/history/action-source-admission.js'),
        import('../../build/indexer/protocol/proof-consumer-scope.js'), import('../../build/indexer/workers/hyperionWorker.js')]);
    const Master = cluster.isPrimary ? (await import('../../build/indexer/modules/master.js')).HyperionMaster : undefined;
    const rows = [], diagnostics = installWorkerRejectionDiagnostics({Pool, Reader, WorkerClient: WorkerAttemptClient,
        WorkerHost: HyperionWorker, Master, maximumFenceEvents: mode === 'bounded' ? 1 : 1024,
        Supervisor: cluster.isPrimary ? WorkerAttemptSupervisor : undefined, cluster, record: (event, value) => {
            if (mode === 'sink-failure' && event.startsWith('worker_attempt_fence')) throw new Error('Controlled fence sink failure');
            rows.push({event, ...value});
        }});
    if (cluster.isPrimary) {
        const ends = [], supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end)});
        cluster.setupPrimary({exec: fileURLToPath(import.meta.url), args: [mode], silent: true});
        const child = cluster.fork(); let stdout = '', stderr = '', result, held;
        child.process.stdout.on('data', data => {stdout += data;}); child.process.stderr.on('data', data => {stderr += data;});
        supervisor.attach(child, 'ds_pool_worker');
        const master = Object.assign(Object.create(Master.prototype), {workerAttemptSupervisor: supervisor,
            liveReader: {wref: child}, workerMap: [{wref: child, worker_role: 'continuous_reader'}],
            protocolAbiCoordinator: {async openSource() {return {generation: 'controlled-generation', resumeFromBlock: null};}, async drain() {}}});
        if (mode === 'deferred') {
            const send = child.send; let fenced = false;
            child.send = function(message, ...args) {
                // Reorder only actual original messages: no fabricated hello/register reply or send callback.
                if (!fenced && message?.event === 'worker_attempt_reply' && message.result?.role) {
                    fenced = true; supervisor.fenceActive();
                }
                return send.call(this, message, ...args);
            };
        }
        child.on('message', async message => {
            if (message?.event === 'fence_origin_fixture_held') {
                held = message;
                const owner = supervisor.snapshot().owners.find(value => value.attempts.some(attempt => attempt.attemptId === held.attemptId));
                assert.ok(owner, 'original managed attempt must be registered before the parent fences it');
                if (mode === 'source-open') {
                    const input = {event: 'protocol_abi_coordinator_request', mId: randomUUID(),
                        data: {operation: 'open', contextId: 'h45srcctx1:' + 'e'.repeat(64), readerSessionId: 'controlled-session'}};
                    // A copied Worker description never passes the original current-reader check.
                    const copied = Object.assign(new EventEmitter(), {id: child.id, process: {pid: child.process.pid},
                        isConnected: () => true, send(reply) {this.reply = reply;}});
                    await master.handleProtocolAbiCoordinatorRequest(copied, input);
                    assert.equal(copied.reply.data.error.code, 'unauthorized');
                    assert.equal(rows.some(row => row.event === 'worker_attempt_fence_sent'), false);
                    await master.handleProtocolAbiCoordinatorRequest(child, input);
                } else if (mode === 'retire') supervisor.retire(child);
                else if (['active', 'bounded', 'sink-failure'].includes(mode)) supervisor.fenceActive();
                else if (mode === 'copied') child.send(JSON.parse(JSON.stringify({event: 'worker_attempt_fence_active',
                    epoch: supervisor.epoch, incarnation: owner.incarnation})));
                else {
                    if (mode === 'stale') {
                        child.send({event: 'worker_attempt_fence_active', epoch: randomUUID(), incarnation: owner.incarnation});
                        child.send({event: 'worker_attempt_fence_active', epoch: supervisor.epoch, incarnation: randomUUID()});
                    }
                    child.send({event: 'fence_origin_fixture_release'});
                }
            } else if (message?.event === 'fence_origin_fixture_result') result = message;
        });
        const exit = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {child.kill(); reject(new Error('Owned fence-origin child exceeded 10 seconds'));}, 10000);
            child.once('exit', (code, signal) => {clearTimeout(timer); resolve({code, signal});});
            child.once('error', error => {clearTimeout(timer); reject(error);});
        });
        assert.deepEqual(exit, {code: 0, signal: null}, stdout + stderr); assert.equal(stderr, '');
        assert.ok(result);
        assert.equal(ends.length, 1);
        const end = describeWorkerAttemptEnd(supervisor, ends[0]);
        assert.equal(end.attemptId, result.attemptId); assert.deepEqual(end.freshWrites, []);
        assert.equal(end.status, 'quiescent'); assert.equal(end.rootResult, 'threw');
        assert.equal(end.acknowledgementAttempted, false);
        const rejection = result.rows.find(row => row.event === 'action_admission_rejected');
        const sent = rows.find(row => row.event === 'worker_attempt_fence_sent');
        const received = result.rows.find(row => row.event === 'worker_attempt_fence_received');
        const local = result.rows.find(row => row.event === 'worker_attempt_scope_fenced');
        const negative = ['control', 'stale', 'unrelated-error'].includes(mode);
        if (mode !== 'deferred' && !negative) {
            assert.equal(rejection.predicate, 'owner_current'); assert.equal(rejection.attempt.scope.state, 'fenced');
            assert.equal(rejection.consumerReady, true); assert.equal(rejection.publisherReady, true);
            assert.equal(rejection.ownerConsumerIsCurrent, true); assert.equal(rejection.ownerPublisherIsCurrent, true);
            if (mode === 'sink-failure') assert.equal(typeof rejection.fenceOrigin.id, 'string');
            else assert.equal(rejection.fenceOrigin.id, (received ?? local).id);
            assert.equal(result.bindings, 0);
        } else {assert.equal(rejection, undefined);}
        if (negative) {
            assert.equal(received, undefined); assert.equal(local, undefined); assert.equal(sent, undefined);
            assert.equal(result.originalError, true); assert.equal(result.bindings, mode === 'unrelated-error' ? 0 : 1);
            assert.equal(result.metrics.fences.normalDrains, 1);
        } else if (mode === 'channel-close') {
            assert.equal(sent, undefined); assert.equal(received, undefined);
            assert.equal(local.origin.kind, 'channel-close');
        } else {
            if (!['bounded', 'sink-failure', 'copied'].includes(mode)) {
                assert.ok(sent, 'the original parent fence callback must retain its physical owner and targeted attempts');
                assert.equal(sent.child.pid, child.process.pid); assert.equal(sent.parentEpoch, end.epoch);
                assert.equal(sent.parentIncarnation, end.incarnation);
                assert.equal(received.origin.messageSha256, sent.messageSha256);
                const members = rows.filter(row => row.event === 'worker_attempt_fence_members' && row.sendId === sent.sendId).flatMap(row => row.members);
                assert.equal(members.length, sent.memberCount);
                if (mode === 'deferred') {
                    assert.equal(members.length, 0); assert.equal(received.origin.deferred, true); assert.equal(result.rootEntered, false);
                } else {
                    assert.equal(members.length, 1); assert.equal(members[0].attemptId, end.attemptId);
                    assert.equal(members[0].descriptorSha256, workerAttemptDigest(end.descriptor));
                    assert.equal(members[0].bindingSha256, workerAttemptDigest(end.binding));
                }
                assert.equal(rows.find(row => row.event === 'worker_attempt_fence_send_callback' && row.sendId === sent.sendId).error, null);
                if (mode === 'source-open') assert.deepEqual(sent.sourceOperation, {method: 'handleProtocolAbiCoordinatorRequest',
                    workerId: child.id, reader: sent.child, currentReaderAtCall: true,
                    requestId: sent.sourceOperation.requestId, operation: 'open', readerSessionId: 'controlled-session'});
            } else assert.equal(sent, undefined, 'copied or absent capture is never an original supervisor send');
            assert.ok(received || mode === 'sink-failure');
            if (received) assert.equal(received.origin.event, mode === 'retire' ? 'worker_attempt_fence' : 'worker_attempt_fence_active');
        }
        if (mode === 'bounded') {assert.ok(diagnostics.snapshot().fences.omitted > 0); assert.ok(diagnostics.snapshot().reportFailures > 0);}
        else if (mode === 'sink-failure') {assert.ok(diagnostics.snapshot().reportFailures > 0); assert.ok(result.metrics.reportFailures > 0);}
        else {assert.equal(diagnostics.snapshot().reportFailures, 0); assert.equal(result.metrics.reportFailures, 0);}
        // Descriptions, including copied fence JSON, can never recreate the parent's private end token.
        assert.throws(() => describeWorkerAttemptEnd(supervisor, structuredClone(end)), /Unissued or foreign/);
        supervisor.stop();
        console.log(JSON.stringify({passed: true, node: process.versions.node, scenario: mode,
            originalAttemptId: end.attemptId, parentEpoch: end.epoch, parentIncarnation: end.incarnation,
            controlledStorageAndChannels: true, sourceAuthority: false}));
    } else {
        const worker = Object.assign(Object.create(Pool.prototype), {chain: conf.settings.chain, chainId: 'a'.repeat(64), conf,
            protocol: {profileId: 'controlled-wire-component'}, protocolId: 'wire', protocolComponents: [],
            filters: {action_blacklist: new Set(), action_whitelist: new Set(), delta_blacklist: new Set(), delta_whitelist: new Set()},
            mLoader: {parser: {flatten: false}, snapshotActionHandlers: () => []}, ch: new EventEmitter(), cch: new EventEmitter(),
            ch_ready: true, cch_ready: true, actionAdmissionOwners: new WeakMap()});
        client = new WorkerAttemptClient({mode: 'managed', role: 'ds_pool_worker', transport: process});
        worker.configureWorkerAttemptLifecycle(client);
        const epoch = await actionProducerEpoch(worker);
        const source = {chainId: worker.chainId, blockNum: 33, blockId: 'c'.repeat(64), producer: 'sysio', timestamp: '2026-10-22T00:00:00.000'};
        const admission = {id: 'controlled-admission', planId: null, source: {producer: epoch.producer,
            executableSha256: epoch.executableSha256, inventoryInput: {source}}, target: {name: 'fence-origin-action-v1-000001', uuid: 'controlled-target'}};
        const sentinel = new Error('Original controlled boundary sentinel'); let release, bindings = 0, rootEntered = false;
        process.on('message', message => {
            if (message?.event !== 'fence_origin_fixture_release') return;
            if (mode === 'channel-close') worker.ch.emit('close');
            else release();
        });
        worker.actionAdmissionStore = {async resolve() {
            const scope = currentProofConsumerScope(true);
            process.send({event: 'fence_origin_fixture_held', attemptId: scope.id});
            await new Promise(resolve => {release = resolve; scope.signal.addEventListener('abort', resolve, {once: true});});
            if (mode === 'unrelated-error') throw sentinel;
            return admission;
        }};
        worker.bindWorkerAttempt = async () => {bindings++; throw sentinel;};
        worker.client = {indices: {async getSettings({index}) {return {[index]: {settings: {'index.uuid': admission.target.uuid}}};}}};
        const message = {content: Buffer.from('original controlled broker delivery'), fields: {deliveryTag: 1, redelivered: true},
            properties: {headers: {[actionSourceAdmissionHeader]: admission.id, block_num: source.blockNum, block_id: source.blockId,
                producer: source.producer, ts: source.timestamp, action_trace_ordinal: 0}}};
        worker.captureActionAdmissionDelivery(message, worker.ch);
        const handle = worker.workerAttemptDeliveries.get(message).handle;
        let caught;
        try {await worker.runWorkerAttemptDelivery(message, () => {rootEntered = true; return worker.beginActionAdmission(message);});}
        catch (error) {caught = error;}
        assert.ok(caught);
        const value = {event: 'fence_origin_fixture_result', rows, attemptId: client.describe(handle).attemptId,
            originalError: caught === sentinel, bindings, rootEntered, metrics: diagnostics.snapshot()};
        await new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
        client.dispose(); client = undefined; process.disconnect();
    }
} finally {
    client?.dispose(); process.chdir(previous);
    assert.ok(directory.startsWith(join(tmpdir(), 'hapi-fence-origin-'))); rmSync(directory, {recursive: true, force: true});
}
