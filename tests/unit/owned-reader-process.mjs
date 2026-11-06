import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {existsSync, mkdtempSync, realpathSync, rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {captureOwnedReader, terminateOwnedReader, describeOwnedReaderExit} from '../../scripts/qualification/owned-reader-process.mjs';

assert.equal(process.platform, 'linux'); assert.equal(process.versions.bun, undefined);
assert.match(process.version, /^v(?:24|26)\./);
const scenario = process.argv[2] ?? 'unchanged', title = 'hyp-owned-reader-fixture-continuous_reader:1';
assert.ok(['unchanged', 'wrong-directory', 'wrong-title', 'changed-title', 'disconnected', 'copied-token',
    'copied-receipt', 'consumed-token', 'disabled'].includes(scenario));
const until = async (test, label) => {const deadline = performance.now() + 5000;
    while (!test()) {assert.ok(performance.now() < deadline, label); await pause(5);}};
if (cluster.isWorker) {
    process.title = title; const timer = setInterval(() => {}, 1000);
    process.on('message', message => {
        if (message?.event === 'change-title') {process.title = message.title; process.send({event: 'title', title: process.title});}
        if (message?.event === 'finish') {clearInterval(timer); process.exit(0);}
    });
    process.send({event: 'ready', pid: process.pid});
} else {
    const previousCwd = process.cwd(), directory = realpathSync(mkdtempSync(join(tmpdir(), 'hapi-owned-reader-')));
    process.chdir(directory); process.env.HYPERION_PORTABLE_NATIVE_QUALIFICATION = '1';
    cluster.setupPrimary({exec: fileURLToPath(import.meta.url), args: [scenario], silent: true});
    const worker = cluster.fork(), state = {ready: false, exited: false, title, stderr: '', code: null, signal: null};
    worker.process.stdout.resume(); worker.process.stderr.on('data', bytes => {state.stderr += bytes.toString(); assert.ok(state.stderr.length <= 16384);});
    worker.on('message', message => {
        if (message?.event === 'ready') {assert.equal(message.pid, worker.process.pid); state.ready = true;}
        if (message?.event === 'title') state.title = message.title;
    });
    worker.on('exit', (code, signal) => Object.assign(state, {exited: true, code, signal: signal ?? null}));
    let result;
    try {
        await until(() => state.ready, 'owned reader starts');
        if (scenario === 'disabled') {
            process.env.HYPERION_PORTABLE_NATIVE_QUALIFICATION = '0';
            assert.throws(() => captureOwnedReader(worker, directory, title), /explicit qualification/);
            process.env.HYPERION_PORTABLE_NATIVE_QUALIFICATION = '1';
        } else if (scenario === 'wrong-directory') assert.throws(() => captureOwnedReader(worker, previousCwd, title));
        else if (scenario === 'wrong-title') assert.throws(() => captureOwnedReader(worker, directory, title + '-foreign'), /title differs/);
        else {
            const token = captureOwnedReader(worker, directory, title);
            if (scenario === 'changed-title') {
                worker.send({event: 'change-title', title: title + '-changed'});
                await until(() => state.title !== title, 'owned reader changes its observed command');
                await assert.rejects(terminateOwnedReader(token), /title differs/);
                await assert.rejects(terminateOwnedReader(token), /consumed/);
            } else if (scenario === 'disconnected') {
                worker.disconnect(); await until(() => !worker.isConnected(), 'reader IPC disconnects');
                await assert.rejects(terminateOwnedReader(token), /disconnected/);
            } else if (scenario === 'copied-token') await assert.rejects(terminateOwnedReader(structuredClone(token)), /unissued/);
            else {
                const receipt = await terminateOwnedReader(token), described = describeOwnedReaderExit(receipt);
                assert.equal(described.reader.pid, worker.process.pid); assert.equal(described.parent.pid, process.pid);
                assert.equal(described.directory, directory); assert.equal(described.expectedTitle, title);
                assert.deepEqual(described.outcome, {code: null, signal: 'SIGKILL'});
                assert.equal(described.brokerSettlement, 'unknown'); assert.equal(described.sourceCoverageQualified, false);
                assert.equal(state.exited, true); assert.equal(existsSync(`/proc/${worker.process.pid}/stat`), false);
                described.reader.pid = 1; assert.equal(describeOwnedReaderExit(receipt).reader.pid, worker.process.pid);
                if (scenario === 'copied-receipt') assert.throws(() => describeOwnedReaderExit(structuredClone(receipt)), /unissued/);
                if (scenario === 'consumed-token') await assert.rejects(terminateOwnedReader(token), /consumed/);
            }
        }
        if (!['unchanged', 'copied-receipt', 'consumed-token'].includes(scenario)) {
            assert.equal(state.exited, false, 'rejected control must not signal the reader');
            assert.equal(existsSync(`/proc/${worker.process.pid}/stat`), true);
        }
        result = {passed: true, scenario, native: process.version, actualNativeReader: true,
            masterPreserved: true, capacityAuthority: false, productionHandoverQualified: false};
    } finally {
        if (!state.exited) {
            if (worker.isConnected()) worker.send({event: 'finish'}); else worker.process.kill('SIGTERM');
            await until(() => state.exited, 'owned reader fixture exits');
        }
        assert.equal(state.stderr, ''); process.chdir(previousCwd); rmdirSync(directory);
    }
    console.log(JSON.stringify(result));
}
