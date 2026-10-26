/** Original emitted failure handlers with controlled services; native child exits remain raw. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {installWorkerRejectionDiagnostics} from '../../scripts/qualification/worker-rejection-diagnostics.mjs';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';

const scenario = process.env.FAILURE_SCENARIO ?? process.argv[2] ?? 'projection';
const sentinelMessage = 'original projection initialization failure';
assert.ok(['projection', 'cleanup-error', 'copied-error', 'primitive', 'sink-failure', 'ds', 'legacy'].includes(scenario));
if (process.argv[2] === 'child') {
    const [{default: Pool}, {default: Reader}, {default: Projection}] = await Promise.all([
        import('../../build/indexer/workers/ds-pool.js'), import('../../build/indexer/workers/state-reader.js'),
        import('../../build/indexer/workers/projection.js')]);
    const diagnostics = installWorkerRejectionDiagnostics({Pool, Reader, Projection, WorkerClient: WorkerAttemptClient,
        record(event, value) {
            if (scenario === 'sink-failure') throw new Error('Controlled diagnostic sink failure');
            appendFileSync(process.env.FAILURE_TRACE, JSON.stringify({event, ...value}) + '\n');
        }});
    process.once('exit', () => appendFileSync(process.env.FAILURE_TRACE,
        JSON.stringify({event: 'fixture_summary', snapshot: diagnostics.snapshot()}) + '\n'));
    const sentinel = new Error(sentinelMessage);
    if (['ds', 'legacy'].includes(scenario)) {
        const worker = Object.assign(Object.create(Pool.prototype), {conf: {prefetch: {block: 1}},
            poolAbiCache: new Map(), poolTypeCache: new Map(), ch: new EventEmitter(), cch: new EventEmitter(),
            ch_ready: true, cch_ready: true, profiler: {start: () => () => {}},
            flushRedisBatch: async () => {}, processTraces: async () => {throw sentinel;}});
        Object.defineProperties(worker, {usesExtensionProtocol: {value: scenario === 'ds'},
            usesProtocolSourceBindings: {value: false}, actionSourceAdmissionEnabled: {value: false}});
        let nacks = 0; worker.ch.nackAll = () => {nacks++;};
        worker.installControlledAttemptLifecycle('ds_pool_worker');
        const message = {content: Buffer.from('[]'), properties: {headers: {}}, fields: {deliveryTag: 1}};
        worker.captureWorkerAttemptDelivery(message, worker.ch, 'ds-delivery');
        worker.consumerQueue = worker.createConsumerQueue();
        await worker.consumerQueue.push(message);
        assert.equal(scenario, 'legacy', 'Fatal queue handler must exit before completion');
        assert.equal(nacks, 1); assert.equal(worker.ch_ready, true);
        process.exit(0);
    }
    const worker = Object.assign(Object.create(Projection.prototype), {chainId: 'a'.repeat(64),
        conf: {features: {portable_state: {}}}, protocolReady: scenario === 'copied-error' ? Promise.resolve()
            : Promise.reject(scenario === 'primitive' ? undefined : sentinel),
        profiler: {stopReporting() {}}});
    worker.installControlledAttemptLifecycle('projection');
    if (scenario === 'cleanup-error') {
        const drain = worker.workerAttemptClient.boundedDrain;
        worker.workerAttemptClient.boundedDrain = async function(scope) {
            await drain.call(this, scope); throw new Error('different cleanup failure');
        };
    }
    if (scenario === 'copied-error') {
        try {await worker.runProjectionAttempt('projection-initialization', {}, () => {throw sentinel;});}
        catch (error) {worker.handleProjectionFailure(new Error(error.message));}
    }
    await worker.run();
    throw new Error('The original fatal path must exit');
} else {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'hapi-worker-failure-'));
    try {
        mkdirSync(join(directory, 'config'));
        writeFileSync(join(directory, 'config/connections.json'), '{}');
        writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'failure-loop'}, features: {},
            indexer: {}, whitelists: {}, blacklists: {}}));
        const trace = join(directory, 'trace.jsonl'); writeFileSync(trace, '');
        const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'child'],
            {cwd: directory, env: {...process.env, CONFIG_JSON: join(directory, 'chain.json'), FAILURE_TRACE: trace,
                FAILURE_SCENARIO: scenario},
                timeout: 5000, encoding: 'utf8'});
        assert.equal(result.error, undefined);
        assert.equal(result.status, scenario === 'legacy' ? 0 : 1, 'The actual original failure still has its raw exit');
        if (scenario !== 'primitive') assert.match(result.stdout, /original projection initialization failure|different cleanup failure/, result.stderr);
        const rows = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
        const fatal = rows.find(row => row.event === 'worker_failure_decision');
        const summary = rows.find(row => row.event === 'fixture_summary').snapshot;
        if (['sink-failure', 'legacy'].includes(scenario)) {
            assert.equal(fatal, undefined);
            assert.equal(summary.reportFailures > 0, scenario === 'sink-failure');
            console.log(JSON.stringify({passed: true, node: process.versions.node, scenario,
                originalExitCode: result.status, controlledServices: true, faultMembership: false}));
        } else {
        assert.ok(fatal, 'The original fatal callback must be captured, separately from the raw exit code');
        assert.equal(fatal.boundary, scenario === 'ds' ? 'action-processing' : 'projection');
        assert.equal(fatal.root.originalObjectMatch, ['projection', 'ds'].includes(scenario));
        assert.equal(fatal.root.runRejectionObjectMatch, !['copied-error', 'primitive'].includes(scenario));
        if (fatal.root.runRejectionObjectMatch) {
            assert.equal(fatal.root.attempt.descriptor.kind, scenario === 'ds' ? 'ds-delivery' : 'projection-initialization');
            assert.equal(fatal.root.attempt.scope.state, 'drained');
            assert.equal(fatal.root.attempt.masterEnd, null, 'Controlled-local descriptions grant no managed end');
        } else assert.equal(fatal.root.attempt, null);
        if (scenario === 'cleanup-error') {
            assert.equal(fatal.root.rootResult, 'threw');
            assert.equal(fatal.root.rootError.message, sentinelMessage);
            assert.equal(fatal.error.message, 'different cleanup failure');
        }
        if (scenario === 'ds') assert.equal(fatal.originalBatchMatch, true);
        assert.equal(summary.reportFailures, 0);
        assert.equal(fatal.observationOnly, true);
        console.log(JSON.stringify({passed: true, node: process.versions.node, scenario,
            originalExitCode: result.status, controlledServices: true, faultMembership: false}));
        }
    } finally {
        assert.ok(directory.startsWith(join(realpathSync(tmpdir()), 'hapi-worker-failure-')));
        rmSync(directory, {recursive: true, force: true});
    }
}
