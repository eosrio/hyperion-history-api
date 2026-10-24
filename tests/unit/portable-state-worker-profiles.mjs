/** Real native observer capture/flush, without services or a substitute Wire correctness workload. */
import assert from 'node:assert/strict';
import {assertNativeQualificationRuntime} from '../../scripts/qualification/native-node-runtime.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {auditPortableWorkerProfiles} from '../../scripts/qualification/portable-state-worker-profiles.ts';
import {portableWorkerEnvironment} from '../../scripts/qualification/portable-state-worker.ts';
import {assertSuccessfulWorkerShutdown} from '../../scripts/qualification/es955-workers.ts';

assertNativeQualificationRuntime();
const mode = process.argv[2]; assert(['control', 'profile'].includes(mode));
const enabled = mode === 'profile', output = mkdtempSync(join(tmpdir(), 'hyperion-portable-profile-'));
const observer = join(output, 'observer/master'); mkdirSync(observer, {recursive: true});
const workload = `
import cluster from 'node:cluster';
function qualificationProfileWork() {
    const until = performance.now() + 180; let checksum = 0;
    while (performance.now() < until) for (let i = 1; i < 1000; i++) checksum += Math.sqrt(i);
    return checksum;
}
const checksum = qualificationProfileWork();
if (cluster.isPrimary) {
    cluster.setupPrimary({exec: process.argv[1]});
    const worker = cluster.fork();
    worker.on('message', message => {
        if (message?.event === 'qualification_profile_ready') process.send({event: message.event, checksum: checksum + message.checksum});
    });
} else process.send({event: 'qualification_profile_ready', checksum});
setInterval(() => {}, 1000);
`;
const environment = portableWorkerEnvironment({...process.env, ES198_CPU_PROFILE: '1', ES198_PROFILE_MAX_MS: '1'},
    output, join(output, 'unused-config.json'), 'qualification-profile', enabled);
environment.ES198_OBSERVER_DIR = observer;
const workloadFile = join(output, 'workload.mjs'); writeFileSync(workloadFile, workload);
const child = spawn(process.execPath, ['--import', new URL('../../scripts/qualification/es955-worker-observer.mjs', import.meta.url).href,
    workloadFile], {env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
let closed = false, stderr = ''; child.on('close', () => {closed = true;});
child.stderr.on('data', bytes => {stderr += bytes.toString();}); child.stdout.resume();
const ending = once(child, 'close'); void ending.catch(() => {}); let timer;
try {
    await Promise.race([new Promise((yes, no) => {
        child.on('message', message => {if (message?.event === 'qualification_profile_ready') {
            assert(Number.isFinite(message.checksum) && message.checksum > 0); yes();
        }});
        child.once('error', no); child.once('exit', () => no(new Error('Native profile child exited before its workload completed')));
    }), new Promise((_, no) => {timer = setTimeout(() => no(new Error('Native profile workload deadline exceeded')), 5000);})]);
    clearTimeout(timer); child.send({event: 'qualifier_shutdown'});
    const [code, signal] = await Promise.race([ending, new Promise((_, no) => {
        timer = setTimeout(() => no(new Error('Native profile shutdown deadline exceeded')), 5000);
    })]); clearTimeout(timer);
    assert.equal(code, 0); assert.equal(signal, null); assert.equal(stderr, '');
    const rows = readdirSync(observer).filter(name => name.endsWith('.jsonl'))
        .flatMap(name => readFileSync(join(observer, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    assertSuccessfulWorkerShutdown(rows, child.pid, code, signal);
    const receipts = await auditPortableWorkerProfiles(output, 'master', rows, child.pid, enabled);
    assert.equal(receipts.length, 2); assert(receipts.some(receipt => receipt.pid === child.pid));
    assert(rows.some(row => row.kind === 'worker_fork' && receipts.some(receipt => receipt.pid === row.childPid)));
    for (const receipt of receipts) assert.equal(receipt.state, enabled ? 'saved' : 'disabled');
    if (enabled) for (const receipt of receipts) {
        const profile = JSON.parse(readFileSync(join(output, receipt.file), 'utf8'));
        const work = new Set(profile.nodes.filter(node => node.callFrame.functionName === 'qualificationProfileWork').map(node => node.id));
        assert(profile.samples.some(id => work.has(id)), 'actual native CPU capture must sample the executed workload');
    }
    console.log(JSON.stringify({passed: true, native: process.version, mode, receipts, ordinaryBoundedFilesVerified: true,
        actualSampledWorkload: enabled, fullWorkerQualification: false}));
} finally {
    clearTimeout(timer);
    if (!closed) {child.kill('SIGKILL'); await ending;}
    const owned = resolve(output); assert.equal(dirname(owned), resolve(tmpdir()));
    assert.match(basename(owned), /^hyperion-portable-profile-/); rmSync(owned, {recursive: true, force: true});
}
