/** Native original-method component loop. Controlled storage/transport; no source, end or retry authority. */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import cluster from 'node:cluster';
import {fileURLToPath} from 'node:url';
import {installWorkerRejectionDiagnostics} from '../../scripts/qualification/worker-rejection-diagnostics.mjs';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
const originalDirectory = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'hapi-rejection-provenance-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const bounds = process.argv[2];
try {
    mkdirSync(join(directory, 'config'));
    const conf = {settings: {chain: 'rejection-loop', parser: '3.2', index_version: 'v1', index_partition_size: 1000},
        indexer: {}, whitelists: {actions: [], deltas: []}, blacklists: {}, plugins: {}};
    writeFileSync(join(directory, 'config/connections.json'), '{}');
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(conf));
    process.env.CONFIG_JSON = join(directory, 'chain.json'); process.chdir(directory);
    const [{default: Pool}, {default: Reader}, {actionProducerEpoch}, {actionSourceAdmissionHeader}] = await Promise.all([
        import('../../build/indexer/workers/ds-pool.js'), import('../../build/indexer/workers/state-reader.js'),
        import('../../build/indexer/history/action-producer-epoch.js'), import('../../build/indexer/history/action-source-admission.js')]);
    const rows = [];
    let failRecorder = false;
    const diagnostics = installWorkerRejectionDiagnostics({Pool, Reader, cluster, Supervisor: cluster.isPrimary ? WorkerAttemptSupervisor : undefined, record(event, value) {
        if (failRecorder) throw new Error('controlled diagnostic sink failure');
        rows.push({event, ...value});
    }});
    let checks = 0;
    const cases = [
        ['binding-boundary', () => {}],
        ['owner_current', ({worker}) => {worker.actionAdmissionStore.resolve = async function() {worker.ch_ready = false; return worker.testAdmission;};}],
        ['producer_epoch', ({admission}) => {admission.source.producer = {...admission.source.producer, profileId: 'other-profile'};}],
        ['executable', ({admission}) => {admission.source.executableSha256 = 'b'.repeat(64);}],
        ['source_chain', ({source}) => {source.chainId = 'b'.repeat(64);}],
        ['source_block_number', ({message}) => {message.properties.headers.block_num++;}],
        ['source_block_id', ({message}) => {message.properties.headers.block_id = 'b'.repeat(64);}],
        ['source_producer', ({message}) => {message.properties.headers.producer = 'other';}],
        ['source_timestamp', ({message}) => {message.properties.headers.ts = 'other';}],
        ['target_identity', ({worker}) => {worker.testTargetUuid = 'other-target';}],
        ['transaction_dispatch_present', ({admission}) => {admission.inventory.transactions = [];}],
        ['dispatch_payload', ({admission}) => {admission.inventory.transactions[0].dispatch.bodySha256 = 'b'.repeat(64);}],
        ['dispatch_inline_count', ({message}) => {message.properties.headers.inline_count++;}],
        ['dispatch_filtered', ({message}) => {message.properties.headers.filtered = true;}],
        ['source_selection', ({message}) => {message.properties.headers['hyperion-source-selection-v1'] = 'other';}],
        ['bound_owner_current', ({worker}) => {worker.testOnTargetRead = () => {worker.ch_ready = false;};}],
        ['bound_configuration', ({worker}) => {worker.testOnTargetRead = () => {worker.conf.indexer.changed = 'operator-secret';};}],
        ['multiple-first-chain', ({source, message}) => {source.chainId = 'b'.repeat(64); message.properties.headers.block_num++;}],
        ['unrelated-store-error', ({worker}) => {worker.testOnTargetRead = () => {throw worker.testSentinel;};}],
        ['queued-header-changed', ({worker, message}) => {worker.testAfterCapture = () => {message.properties.headers.block_num++;};}],
        ['stale-channel', ({worker}) => {worker.testAfterCapture = () => {worker.ch = new EventEmitter();};}],
        ['diagnostic-sink-failure', ({source}) => {source.chainId = 'b'.repeat(64); failRecorder = true;}],
    ];
    const selected = bounds === '--record-limit' ? Array(34).fill(cases.find(([name]) => name === 'source_chain'))
        : bounds === '--byte-limit' ? [['record-byte-limit', ({source}) => {source.chainId = 'b'.repeat(70 * 1024);}]]
        : cluster.isWorker ? cases.filter(([name]) => name === 'source_chain') : cases;
    for (const [predicate, change] of selected) {
        const worker = Object.assign(Object.create(Pool.prototype), {chain: conf.settings.chain, chainId: 'a'.repeat(64), conf: structuredClone(conf),
            protocol: {profileId: 'controlled-wire-component'}, protocolId: 'wire', protocolComponents: [],
            filters: {action_blacklist: new Set(), action_whitelist: new Set(), delta_blacklist: new Set(), delta_whitelist: new Set()},
            mLoader: {parser: {flatten: false}, snapshotActionHandlers: () => []}, ch: new EventEmitter(), cch: new EventEmitter(),
            ch_ready: true, cch_ready: true, actionAdmissionOwners: new WeakMap()});
        if (cluster.isWorker) worker.configureWorkerAttemptLifecycle(new WorkerAttemptClient({mode: 'managed', role: 'ds_pool_worker', transport: process}));
        else worker.installControlledAttemptLifecycle('ds_pool_worker');
        const epoch = await actionProducerEpoch(worker);
        const source = {chainId: worker.chainId, blockNum: 33, blockId: 'c'.repeat(64), producer: 'sysio', timestamp: '2026-10-22T00:00:00.000'};
        const target = {name: 'rejection-loop-action-v1-000001', uuid: 'controlled-target'};
        const admission = {id: 'controlled-admission', planId: null, source: {producer: epoch.producer,
            executableSha256: epoch.executableSha256, inventoryInput: {source}}, target};
        worker.testAdmission = admission;
        worker.actionAdmissionStore = {async resolve() {return admission;}};
        let targetReads = 0, bindings = 0;
        worker.client = {indices: {async getSettings({index}) {targetReads++; worker.testOnTargetRead?.();
            return {[index]: {settings: {'index.uuid': worker.testTargetUuid ?? target.uuid}}};}}};
        const sentinel = new Error('controlled binding boundary: no authority issued');
        worker.testSentinel = sentinel;
        const bind = worker.bindWorkerAttempt;
        worker.bindWorkerAttempt = async (...args) => {bindings++; if (predicate.startsWith('bound_')) return bind.apply(worker, args); throw sentinel;};
        const message = {content: Buffer.from('controlled original delivery'), fields: {deliveryTag: 7, redelivered: false},
            properties: {headers: {[actionSourceAdmissionHeader]: admission.id, block_num: source.blockNum,
                block_id: source.blockId, producer: source.producer, ts: source.timestamp, action_trace_ordinal: 1,
                inline_count: 0, filtered: false, 'hyperion-source-selection-v1': 'controlled-selection'}}};
        if (predicate.startsWith('dispatch_') || ['transaction_dispatch_present', 'source_selection'].includes(predicate))
            admission.inventory = {sourceSelectionId: 'controlled-selection', transactions: [{traceOrdinal: 1,
                dispatch: {bodySha256: hash(message.content), inlineCount: 0, filtered: false}}]};
        change({worker, admission, source, message, target});
        worker.captureActionAdmissionDelivery(message, worker.ch);
        worker.testAfterCapture?.();
        const retained = worker.workerAttemptClient.describe(worker.workerAttemptDeliveries.get(message).handle);
        assert.equal(retained.descriptor.payloadSha256, hash(message.content));
        const beforeRows = rows.length;
        let caught;
        try {await worker.runWorkerAttemptDelivery(message, () => worker.beginActionAdmission(message));} catch (error) {caught = error;}
        if (predicate === 'queued-header-changed') {
            assert.match(caught.message, /queued worker attempt bytes\/headers changed/); assert.equal(rows.length, beforeRows);
            assert.equal(bindings, 0); assert.equal(targetReads, 0);
        } else if (predicate === 'stale-channel') {
            assert.equal(caught.message, 'Admitted action channels are unavailable');
            assert.equal(rows.at(-1).event, 'action_admission_threw'); assert.equal(rows.at(-1).predicate, null);
            assert.equal(rows.at(-1).attempt.descriptor.consumerId, retained.descriptor.consumerId);
            assert.equal(bindings, 0); assert.equal(targetReads, 0);
        } else if (['binding-boundary', 'unrelated-store-error'].includes(predicate)) {
            assert.equal(caught, sentinel); assert.equal(bindings, predicate === 'binding-boundary' ? 1 : 0); assert.equal(targetReads, 1);
            assert.equal(rows.at(-1).event, 'action_admission_threw'); assert.equal(rows.at(-1).predicate, null);
        } else {
            const expected = ['multiple-first-chain', 'diagnostic-sink-failure', 'record-byte-limit'].includes(predicate) ? 'source_chain' : predicate;
            const inventory = !!admission.inventory;
            assert.equal(caught?.message, predicate.startsWith('bound_') ? 'Action admission producer/channel epoch changed during attempt binding'
                : inventory ? 'Action admission input payload or source ordinal mismatch' : 'Action admission producer/source/target epoch mismatch');
            assert.equal(caught?.actionAdmissionPredicate, expected, 'the original decision must name its first failed predicate');
            assert.equal(bindings, predicate.startsWith('bound_') ? 1 : 0);
            assert.equal(targetReads, predicate === 'target_identity' || inventory || predicate.startsWith('bound_') ? 1 : 0);
            if (!failRecorder && !(bounds === '--record-limit' && checks >= 32) && bounds !== '--byte-limit') {
                const row = rows.at(-1);
                assert.equal(rows.length, beforeRows + 1); assert.equal(row.event, 'action_admission_rejected');
                assert.equal(row.predicate, expected); assert.notDeepEqual(row.actual, row.expected);
                assert.deepEqual(row.attempt.descriptor, retained.descriptor); assert.equal(row.attempt.attemptId, retained.attemptId);
                assert.equal(row.delivery.headersSha256, retained.descriptor.headersSha256);
                assert.equal(row.delivery.payloadSha256, retained.descriptor.payloadSha256);
                assert.equal(row.attempt.masterEnd, null);
                if (cluster.isWorker) {assert.equal(row.attempt.mode, 'managed'); assert.match(row.parentIncarnation, /^[0-9a-f-]{36}$/);}
                else assert.equal(row.parentIncarnation, null);
                assert.equal(row.observationOnly, true); assert.equal(row.physical.pid, process.pid);
                if (process.platform === 'linux') assert.match(row.physical.birthTicks, /^[1-9][0-9]*$/);
                if (predicate === 'bound_configuration') {
                    assert.ok(!JSON.stringify(row).includes('operator-secret')); assert.equal(row.operandFormat, 'sha256');
                    assert.equal(row.expected.sha256, epoch.producer.configurationSha256);
                }
            } else {assert.equal(rows.length, beforeRows); failRecorder = false;}
        }
        const after = rows.length;
        await assert.rejects(worker.runWorkerAttemptDelivery({...message}, () => assert.fail('copied delivery reached callback')), /original physical ingress/);
        await assert.rejects(worker.runWorkerAttemptDelivery(message, () => assert.fail('reused attempt reached callback')), /root cannot be repeated/);
        assert.equal(rows.length, after, 'copied/reused custody cannot create a rejection decision');
        const end = worker.workerAttemptClient.describe(worker.workerAttemptDeliveries.get(message).handle).masterEnd;
        if (cluster.isWorker) {assert.equal(end.status, 'quiescent'); assert.equal(end.rootResult, 'threw'); assert.equal(end.acknowledgementAttempted, false);}
        else assert.equal(end, null);
        worker.workerAttemptClient.dispose(); checks++;
    }
    if (cluster.isPrimary && !bounds) {
        const ends = [], supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end)});
        const children = [];
        for (const mode of ['managed', 'close', 'error', 'return', 'nack', 'replaced-confirm', 'send-throw', 'clean-close', 'stale-close']) {
            cluster.setupPrimary({exec: fileURLToPath(new URL(mode === 'managed' ? './worker-rejection-provenance.mjs' : './reader-rejection-provenance.mjs', import.meta.url)),
                args: mode === 'managed' ? [] : [mode], silent: true});
            const child = cluster.fork(), pid = child.process.pid, messages = [];
            children.push(child); let stdout = '', stderr = '';
            child.process.stdout.on('data', data => {stdout += data;}); child.process.stderr.on('data', data => {stderr += data;});
            child.on('message', message => messages.push(message));
            if (mode === 'managed') supervisor.attach(child, 'ds_pool_worker');
            const result = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {child.kill(); reject(new Error('Owned provenance test worker exceeded 15 seconds'));}, 15000);
                child.once('exit', (code, signal) => {clearTimeout(timer); resolve({code, signal});});
                child.once('error', error => {clearTimeout(timer); reject(error);});
            });
            assert.equal(result.signal, null, stderr);
            assert.equal(result.code, ['managed', 'stale-close'].includes(mode) ? 0 : 1, stderr);
            const output = stdout.trim().split('\n').map(line => {try {return JSON.parse(line);} catch {return null;}}).filter(Boolean).at(-1);
            assert.ok(output?.passed === true || output?.status === 'passed', stdout + stderr);
            if (!['managed', 'stale-close'].includes(mode)) assert.equal(messages.filter(message => message.event === 'reader_recovery_required').length, 1);
            else assert.equal(messages.filter(message => message.event === 'reader_recovery_required').length, 0);
            const fork = rows.find(row => row.event === 'physical_worker_forked' && row.child.pid === pid);
            const exit = rows.find(row => row.event === 'physical_worker_exited' && row.child?.pid === pid);
            assert.ok(fork); assert.ok(exit); assert.deepEqual(exit.child, fork.child); assert.equal(exit.code, result.code);
            assert.equal(exit.workerId, child.id); checks++;
        }
        assert.equal(ends.length, 1);
        const end = describeWorkerAttemptEnd(supervisor, ends[0]);
        assert.equal(end.rootResult, 'threw'); assert.equal(end.freshWrites.length, 0); assert.equal(end.acknowledgementAttempted, false);
        const owner = rows.find(row => row.event === 'attempt_owner_attached');
        assert.equal(owner.parentEpoch, end.epoch); assert.equal(owner.parentIncarnation, end.incarnation);
        assert.throws(() => describeWorkerAttemptEnd(supervisor, JSON.parse(JSON.stringify(ends[0]))), /Unissued or foreign/);
        assert.throws(() => describeWorkerAttemptEnd(new WorkerAttemptSupervisor(), ends[0]), /Unissued or foreign/);
        supervisor.stop();
    }
    assert.equal(diagnostics.snapshot().reportFailures, bounds === '--record-limit' ? 2 : cluster.isWorker ? 0 : 1, 'capture failures must stay visible');
    assert.equal(diagnostics.snapshot().omittedRejections, bounds === '--record-limit' ? 2 : 0);
    console.log(JSON.stringify({status: 'passed', checks, rows: rows.length,
        endAssociationRows: rows.filter(row => row.event === 'worker_attempt_end_association').length,
        node: process.versions.node, scope: 'original-method component only'}));
    if (cluster.isWorker) process.disconnect();
} finally {
    process.chdir(originalDirectory);
    assert.ok(directory.startsWith(join(tmpdir(), 'hapi-rejection-provenance-')));
    rmSync(directory, {recursive: true, force: true});
}
