// Stop-capable CI controller. Never import/execute this file for local pure controls.
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {release} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {MongoClient} from 'mongodb';
import {OwnedMongoFixture, MONGODB_IMAGE, MONGODB_VERSION, waitForMongo} from '../projection-fixture.mjs';
import {terminalChild} from '../stateful-complete-kind-mongodb/ci.mjs';
import {PLAN, failure, sha, assertNativeCompletion, assertOriginalTerminal, afterReadiness} from './contract.mjs';
import {admitOperatorListAssembly, OPERATOR_LIST_ASSEMBLY} from './linux-snapshot-source-profile.mjs';
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Fixed disposable fixture only. No server URI, image, container or resource override is accepted. */
export async function runCI(output) {
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This controller is GitHub CI only; bare-metal admission is separate');
    assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
    assert.equal(realpathSync(process.env.GITHUB_WORKSPACE), realpathSync(root));
    assert.equal(MONGODB_VERSION, PLAN.server); assert.equal(MONGODB_IMAGE, OPERATOR_LIST_ASSEMBLY.fixture.image);
    assert.ok(!existsSync(output)); mkdirSync(output, {recursive: true});
    const fixture = new OwnedMongoFixture(), report = {schemaVersion: 1, scope: PLAN.scope, status: 'running', run: fixture.run,
        profile: PLAN.profile, plan: PLAN, image: MONGODB_IMAGE, mongodb: MONGODB_VERSION, kernel: release(),
        cleanup: fixture.cleanupResult, HAPIOnSend: 'pending', AtomicParity: 'pending', WireReplay: 'separate-pending'};
    let original, child;
    const stop = () => {original ??= new Error('Operator-list CI controller interrupted'); child?.kill('SIGTERM');};
    const check = () => {if (original) throw original;};
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
        check();
        // Exact new root741/native429/native45 admission precedes every Docker command.
        report.assembly = admitOperatorListAssembly(PLAN.profile);
        const source = process.env.GITHUB_SHA; assert.match(source, /^[a-f0-9]{40}$/);
        const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
        report.checkout = {commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}'])};
        assert.equal(report.checkout.commit, source, 'CI checkout differs from the original workflow source');
        assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all', '--', 'src', 'package.json', 'package-lock.json', 'tsconfig.json',
            '.bun-version', 'packages/backend-mongodb', '.github/workflows/build.yml', 'scripts/qualification/operator-list-mongodb',
            'scripts/qualification/projection-fixture.mjs', 'scripts/qualification/stateful-complete-kind-mongodb/ci.mjs',
            'tests/unit/stateful-engineering-source-admission.mjs']), '', 'Unreviewed CI/product source changes');
        check(); const kernel = fixture.command(['info', '--format', '{{.KernelVersion}}']); report.dockerKernel = kernel;
        const version = /^(\d+)\.(\d+)\.(\d+)/.exec(kernel);
        assert.ok(!version || !(Number(version[1]) === 6 && Number(version[2]) >= 19
            || Number(version[1]) === 7 && Number(version[2]) === 0 && Number(version[3]) < 14), 'MongoDB 8.0.34 kernel constraint');
        check(); fixture.prepare(); check(); const uri = fixture.start('replica');
        const ready = async primary => {
            const client = await waitForMongo(() => {check(); return new MongoClient(uri, {directConnection: true, retryReads: false, retryWrites: false,
                maxAdaptiveRetries: 0, maxPoolSize: 1, serverSelectionTimeoutMS: 1000, connectTimeoutMS: 1000});},
            {primary, replicaSet: fixture.replicaSet, timeoutMS: 60000});
            // Closing an already-acquired readiness client remains required after interruption.
            await client.close();
            check();
        };
        await afterReadiness(check, () => ready(false), () => fixture.initializeReplica());
        report.child = await afterReadiness(check, () => ready(true), () => {
            const owned = fixture.ownedContainer('replica'), image = fixture.inspect('image', MONGODB_IMAGE);
            assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, 'amd64'); assert.equal(owned.Image, image.Id);
            assert.equal(owned.HostConfig.NanoCpus, OPERATOR_LIST_ASSEMBLY.fixture.nanoCPUs);
            assert.equal(owned.HostConfig.Memory, OPERATOR_LIST_ASSEMBLY.fixture.memoryBytes);
            report.container = {id: owned.Id, name: owned.Name, labels: owned.Config.Labels, imageId: image.Id, repoDigests: image.RepoDigests,
                replicaSet: fixture.replicaSet, volume: fixture.volume.name, cpus: owned.HostConfig.NanoCpus, memory: owned.HostConfig.Memory,
                memorySwap: owned.HostConfig.MemorySwap, port: owned.NetworkSettings.Ports};
            const runner = fileURLToPath(new URL('./runner.mjs', import.meta.url));
            check();
            // Publish the child handle and attach its terminal collector in this same synchronous turn.
            child = spawn(process.execPath, [runner, '--run', '--allow-failpoints', '--database', 'h45_lists_' + fixture.run.slice(0, 12),
                '--output', join(output, 'native'), '--source', source, '--compiled-sha256', OPERATOR_LIST_ASSEMBLY.trees.nativeBuild.sha256],
            {stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, HYPERION_OPERATOR_LIST_MONGO_URI: uri + '&replicaSet=' + fixture.replicaSet}});
            // Existing owned-fixture terminal/stream collector retains its original 300s + failure-only grace.
            return terminalChild(child, createWriteStream(join(output, 'runner.stdout.log'), {flags: 'wx'}),
                createWriteStream(join(output, 'runner.stderr.log'), {flags: 'wx'}),
                {deadlineMS: OPERATOR_LIST_ASSEMBLY.fixture.childDeadlineMS, graceMS: OPERATOR_LIST_ASSEMBLY.fixture.graceMS,
                    terminalMS: OPERATOR_LIST_ASSEMBLY.fixture.terminalMS});
        });
        check();
        assertOriginalTerminal(report.child);
        const native = JSON.parse(readFileSync(join(output, 'native/report.json')));
        assertNativeCompletion(report.child, native, OPERATOR_LIST_ASSEMBLY.trees.nativeBuild.sha256);
        const checksums = JSON.parse(readFileSync(join(output, 'native/sha256.json')));
        assert.deepEqual(checksums.map(row => row.path).sort(), ['report.json', 'trace.json']);
        for (const entry of checksums) {
            const body = readFileSync(join(output, 'native', entry.path)); assert.equal(body.length, entry.bytes); assert.equal(sha(body), entry.sha256);
        }
        report.native = {status: native.status, cases: native.cases.length, traceEvents: native.traceEvents, checkedRawArtifacts: checksums};
    } catch (error) {original ??= error; report.failure = failure(original); if (error !== original) report.secondaryFailure = failure(error);}
    finally {
        try {report.diagnostics = fixture.diagnostics(); json(join(output, 'before-cleanup.json'), report);}
        catch (error) {original ??= error; report.evidenceFailure = failure(error);}
        try {await fixture.cleanup();} catch (error) {original ??= error; report.cleanupFailure = failure(error);}
        process.off('SIGINT', stop); process.off('SIGTERM', stop);
        if (original) report.failure ??= failure(original);
        report.status = original ? 'failed' : 'passed-native-operator-list-only'; json(join(output, 'controller.json'), report);
    }
    if (original) throw original; return report;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    assert.equal(process.argv.length, 3, 'Use node ci.mjs NEW_EVIDENCE_DIRECTORY');
    const report = await runCI(resolve(process.argv[2])); console.log(JSON.stringify({status: report.status, run: report.run}));
}
