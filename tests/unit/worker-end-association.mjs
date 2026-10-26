/** Actual managed IPC and original end validator; controlled failure, no services or progress authority. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {WorkerAttemptSupervisor, workerAttemptDigest} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {currentProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';
import {installWorkerRejectionDiagnostics} from '../../scripts/qualification/worker-rejection-diagnostics.mjs';

const mode = process.argv[2] ?? 'invalid-binding';
assert.ok(['invalid-binding', 'invalid-descriptor', 'invalid-operation', 'invalid-summary', 'invalid-root-result',
    'invalid-ack', 'late-failure', 'valid', 'lost-reply', 'mutating-sink', 'sink-failure'].includes(mode));
const expectedMismatch = {'invalid-binding': 'bindingSha256', 'invalid-descriptor': 'descriptorSha256',
    'invalid-operation': 'operation', 'invalid-summary': 'summary.keys', 'invalid-root-result': 'summary.rootResult',
    'invalid-ack': 'summary.acknowledgementAttempted', 'late-failure': 'bindingSha256',
    'mutating-sink': 'bindingSha256', 'sink-failure': 'bindingSha256'}[mode];
const fenced = !['valid', 'lost-reply'].includes(mode);
const previous = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'hapi-end-association-'));
let client;
try {
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'config/connections.json'), '{}');
    writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'end-association'}, indexer: {}, features: {}}));
    process.env.CONFIG_JSON = join(directory, 'chain.json'); process.chdir(directory);
    const [{default: Pool}, {default: Reader}, {default: Projection}, {HyperionWorker}] = await Promise.all([
        import('../../build/indexer/workers/ds-pool.js'), import('../../build/indexer/workers/state-reader.js'),
        import('../../build/indexer/workers/projection.js'), import('../../build/indexer/workers/hyperionWorker.js')]);
    const Master = cluster.isPrimary ? (await import('../../build/indexer/modules/master.js')).HyperionMaster : undefined;
    process.chdir(previous);
    const rows = [], diagnostics = installWorkerRejectionDiagnostics({Pool, Reader, Projection, WorkerHost: HyperionWorker,
        WorkerClient: WorkerAttemptClient, Supervisor: cluster.isPrimary ? WorkerAttemptSupervisor : undefined,
        Master, cluster, record(event, value) {
            if (mode === 'sink-failure' && event === 'worker_attempt_end_association') throw new Error('Controlled end observation sink failure');
            rows.push(structuredClone({event, ...value}));
            if (mode === 'mutating-sink' && event === 'worker_attempt_end_association') {
                value.reply.ok = true; value.request.bindingSha256 = value.validator.bindingSha256;
            }
        }});
    if (cluster.isPrimary) {
        const supervisor = new WorkerAttemptSupervisor({fenceTimeoutMs: 1000});
        cluster.setupPrimary({exec: fileURLToPath(import.meta.url), args: [mode], silent: true});
        const child = cluster.fork(); let stdout = '', stderr = '', result;
        child.process.stdout.on('data', data => {stdout += data;}); child.process.stderr.on('data', data => {stderr += data;});
        supervisor.attach(child, 'projection');
        if (mode === 'lost-reply') {
            const send = child.send;
            child.send = function(message, ...args) {
                // The parent's original end is retained; the actual transport return remains unknown to the client.
                if (message?.event === 'worker_attempt_reply' && message.result?.end) return true;
                return send.call(this, message, ...args);
            };
        }
        child.on('message', message => {
            if (message?.event === 'end_fixture_held' && fenced) supervisor.fenceActive();
            if (message?.event === 'end_fixture_result') result = message;
        });
        const exit = await new Promise((resolveExit, reject) => {
            const timer = setTimeout(() => {child.kill(); reject(new Error('Owned end-association child exceeded ten seconds'));}, 10000);
            child.once('exit', (code, signal) => {clearTimeout(timer); resolveExit({code, signal});});
            child.once('error', error => {clearTimeout(timer); reject(error);});
        });
        assert.deepEqual({exit, stderr, stdout}, {exit: {code: 0, signal: null}, stderr: '', stdout: ''});
        assert.ok(result);
        assert.equal(result.rootErrorName ?? null, fenced ? 'ProofConsumerFencedError' : null);
        assert.equal(result.runErrorMessage ?? null, mode === 'valid' ? null : mode === 'lost-reply'
            ? 'Worker lifecycle IPC response is unknown' : 'Invalid worker attempt end association');
        if (mode !== 'valid') {assert.equal(result.sameRootError, false); assert.equal(result.masterEnd, null);}
        else assert.equal(result.masterEnd.status, 'quiescent');
        assert.equal(supervisor.snapshot().active, 0);
        const evidence = rows.filter(row => row.event === 'worker_attempt_end_association');
        if (mode === 'sink-failure') {assert.equal(evidence.length, 0); assert.ok(diagnostics.snapshot().reportFailures > 0);}
        else {
            assert.equal(evidence.length, mode === 'late-failure' ? 9 : 1, 'Original rejected end request, reply and validator operands must be retained');
            const end = evidence.at(-1);
            assert.equal(end.attemptId, result.attemptId);
            assert.equal(end.validator.bindingSha256, workerAttemptDigest({}));
            assert.equal(end.reply.ok, !fenced);
            if (fenced) assert.equal(end.reply.error, 'Invalid worker attempt end association');
            assert.deepEqual(end.mismatches, expectedMismatch ? [expectedMismatch] : []);
            assert.equal(end.credentialsRetained, false);
            const encoded = JSON.stringify(evidence);
            assert.ok(!encoded.includes('"challenge"') && !encoded.includes('"clientId"'));
            if (mode === 'invalid-summary') assert.ok(!encoded.includes('do-not-retain-this-sentinel'));
            assert.equal(diagnostics.snapshot().reportFailures, 0);
        }
        if (mode === 'late-failure') assert.equal(diagnostics.snapshot().endAssociation.omittedSuccesses, 1);
        console.log(JSON.stringify({passed: true, node: process.versions.node, mode, actualManagedIpc: true,
            originalRunRejectionPreserved: true, endAssociationObserved: mode !== 'sink-failure', controlledInputCorruption: !!expectedMismatch,
            productionCauseIdentified: false, fullWorkerQualification: false}));
    } else {
        const transport = {
            on: (event, callback) => process.on(event, callback), removeListener: (event, callback) => process.removeListener(event, callback),
            send(message, callback) {
                // Deliberately corrupt one original issued end only, after the client built its real request.
                let sent = message;
                if (message?.payload?.operation === 'end' && corrupt) {
                    const payload = {...message.payload};
                    if (mode === 'invalid-descriptor') payload.descriptorSha256 = 'c'.repeat(64);
                    else if (mode === 'invalid-operation') payload.operation = 'invalid-operation';
                    else if (mode === 'invalid-summary') payload.summary = {...payload.summary, extra: 'do-not-retain-this-sentinel'};
                    else if (mode === 'invalid-root-result') payload.summary = {...payload.summary, rootResult: 'invalid-result'};
                    else if (mode === 'invalid-ack') payload.summary = {...payload.summary, acknowledgementAttempted: 'no'};
                    else payload.bindingSha256 = 'f'.repeat(64);
                    sent = {...message, payload};
                }
                process.send(sent, callback);
            }};
        let corrupt = false;
        client = new WorkerAttemptClient({mode: 'managed', role: 'projection', transport, retries: 0, timeoutMs: mode === 'lost-reply' ? 500 : 5000});
        const capture = () => client.capture({kind: 'projection-frame', receiptId: randomUUID(), payloadSha256: 'a'.repeat(64),
            headersSha256: 'b'.repeat(64), consumerId: null, publisherId: null, queue: null, deliveryTag: null});
        if (mode === 'late-failure') for (let index = 0; index < 9; index++) await client.run(capture(), () => undefined);
        corrupt = fenced;
        const handle = capture();
        let rootError, runError;
        try {
            await client.run(handle, async () => {
                if (!fenced) return 7;
                const scope = currentProofConsumerScope(true);
                process.send({event: 'end_fixture_held'});
                await new Promise(resolveAbort => scope.signal.addEventListener('abort', resolveAbort, {once: true}));
                try {scope.assertActive();} catch (error) {rootError = error; throw error;}
            });
        } catch (error) {runError = error;}
        const attempt = client.describe(handle);
        await new Promise((resolveSend, reject) => process.send({event: 'end_fixture_result', attemptId: attempt.attemptId,
            rootErrorName: rootError?.name, runErrorMessage: runError?.message, sameRootError: runError === rootError,
            masterEnd: attempt.masterEnd ?? null}, error => error ? reject(error) : resolveSend()));
        client.dispose(); process.disconnect();
    }
} finally {
    client?.dispose(); process.chdir(previous);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('hapi-end-association-'));
    rmSync(directory, {recursive: true, force: true});
}
