import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {finished} from 'node:stream/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {release} from 'node:os';
import {MongoClient} from 'mongodb';
import {OwnedMongoFixture, MONGODB_IMAGE, MONGODB_VERSION, waitForMongo} from '../projection-fixture.mjs';
import {admitNativeApiSourceOptions} from '../../../tests/unit/stateful-engineering-source-admission.mjs';
import {PLAN} from './runner.mjs';

const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});

/** Wait for a real child terminal and both log streams. A timeout/grace never becomes success. */
export async function terminalChild(child, stdout, stderr, {deadlineMS = 300000, graceMS = 10000, terminalMS = 10000} = {}) {
    const streams = Promise.all([finished(stdout), finished(stderr)]); void streams.catch(() => {});
    child.stdout.pipe(stdout); child.stderr.pipe(stderr);
    let timedOut = false, hard, abandoned, error;
    const deadline = setTimeout(() => {
        timedOut = true; child.kill('SIGTERM');
        hard = setTimeout(() => {child.kill('SIGKILL');}, graceMS);
    }, deadlineMS);
    try {
        const terminal = await new Promise((accept, reject) => {
            // A bounded final terminal wait follows forced termination; it always reports failure.
            abandoned = setTimeout(() => reject(new Error('Native child did not reach a terminal state')), deadlineMS + graceMS + terminalMS);
            child.once('error', reject); child.once('close', (code, signal) => accept({code, signal}));
        });
        await streams;
        return {...terminal, timedOut, terminal: true, streamsClosed: true};
    } catch (failure) {error = failure; throw failure;}
    finally {clearTimeout(deadline); clearTimeout(hard); clearTimeout(abandoned);
        if (error) {stdout.destroy(); stderr.destroy(); child.kill('SIGKILL');}}
}

/** CI-only owned fixture. No URI, image, resource name or Docker target is accepted as input. */
export async function runCI(output) {
    assert.ok(!existsSync(output), 'CI evidence directory must be new'); mkdirSync(output, {recursive: true});
    const fixture = new OwnedMongoFixture(), report = {schemaVersion: 1, status: 'running', run: fixture.run,
        image: MONGODB_IMAGE, mongodb: MONGODB_VERSION, kernel: release(), plan: PLAN,
        cleanup: fixture.cleanupResult, physicalManagedAPI: 'pending', publicHTTP: 'pending', atomicParity: 'pending'};
    let failure, child;
    const stop = () => {failure ??= new Error('CI controller interrupted'); child?.kill('SIGTERM');};
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
        report.source = admitNativeApiSourceOptions({engineeringSourceProfile: PLAN.profile});
        const kernel = fixture.command(['info', '--format', '{{.KernelVersion}}']); report.dockerKernel = kernel;
        const version = /^(\d+)\.(\d+)\.(\d+)/.exec(kernel);
        assert.ok(!version || !(Number(version[1]) === 6 && Number(version[2]) >= 19
            || Number(version[1]) === 7 && Number(version[2]) === 0 && Number(version[3]) < 14), 'MongoDB 8.0.34 kernel constraint');
        fixture.prepare(); const uri = fixture.start('replica');
        const ready = async primary => {
            const client = await waitForMongo(() => new MongoClient(uri, {directConnection: true,
                retryReads: false, retryWrites: false, maxAdaptiveRetries: 0, maxPoolSize: 1,
                serverSelectionTimeoutMS: 1000, connectTimeoutMS: 1000}),
                {primary, replicaSet: fixture.replicaSet, timeoutMS: 60000});
            await client.close();
        };
        await ready(false); fixture.initializeReplica(); await ready(true);
        const owned = fixture.ownedContainer('replica'), image = fixture.inspect('image', MONGODB_IMAGE);
        assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, 'amd64'); assert.equal(owned.Image, image.Id);
        report.container = {id: owned.Id, name: owned.Name, labels: owned.Config.Labels, imageId: image.Id,
            repoDigests: image.RepoDigests, replicaSet: fixture.replicaSet, volume: fixture.volume.name,
            cpus: owned.HostConfig.NanoCpus, memory: owned.HostConfig.Memory, port: owned.NetworkSettings.Ports};
        const runner = fileURLToPath(new URL('./runner.mjs', import.meta.url));
        child = spawn(process.execPath, [runner, '--run', '--allow-failpoints', '--database', 'h45_kind_' + fixture.run.slice(0, 12),
            '--output', join(output, 'native')], {stdio: ['ignore', 'pipe', 'pipe'],
            env: {...process.env, HYPERION_COMPLETE_KIND_MONGO_URI: uri + '&replicaSet=' + fixture.replicaSet}});
        report.child = await terminalChild(child, createWriteStream(join(output, 'runner.stdout.log'), {flags: 'wx'}),
            createWriteStream(join(output, 'runner.stderr.log'), {flags: 'wx'}));
        assert.equal(report.child.timedOut, false, 'Timeout/grace cannot grant native success');
        assert.equal(report.child.code, 0); assert.equal(report.child.signal, null);
        const native = JSON.parse(readFileSync(join(output, 'native/report.json')));
        assert.equal(native.status, 'passed-native-only'); assert.equal(native.cleanup.databaseDropped, true);
        assert.equal(native.cleanup.failpointDisabled, true); assert.equal(native.cleanup.sessionsEnded, true);
        assert.equal(native.cleanup.managedClientClosed, true);
        report.native = {status: native.status, cases: native.cases.length, traceEvents: native.traceEvents};
    } catch (error) {failure ??= error; report.failure = {name: error.name, message: String(error.message).slice(0, 1024)};}
    finally {
        // Retain failed traces/stdout/stderr and owned diagnostics BEFORE removing only verified owned resources.
        report.diagnostics = fixture.diagnostics(); json(join(output, 'before-cleanup.json'), report);
        try {await fixture.cleanup();} catch (error) {failure ??= error; report.cleanupFailure = String(error.message).slice(0, 1024);}
        process.off('SIGINT', stop); process.off('SIGTERM', stop);
        report.status = failure ? 'failed' : 'passed-native-engine-only';
        json(join(output, 'controller.json'), report);
    }
    if (failure) throw failure; return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    if (process.argv.length !== 3) throw new Error('Usage: node ci.mjs NEW_EVIDENCE_DIRECTORY');
    const report = await runCI(resolve(process.argv[2])); console.log(JSON.stringify({status: report.status, run: report.run}));
}
