/** Real native IPC/process custody with constructed parent/source state; not a production handover. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {fork} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {createWireReaderRecoveryControl, readWireReaderRecoveryControl, createWireReaderRecorder, wireReaderControlDigest,
    snapshotWireReader, describeWireReaderSnapshot, crashWireReader, describeWireReaderCrash, wireReaderStatus,
    releaseWireReaderRpc, wireReaderShutdownRows} from '../../scripts/qualification/portable-state-reader-recovery.mjs';
import {installWireReaderRecoveryHost} from '../../scripts/qualification/wire-reader-recovery-host.mjs';
import {durableRecoveryFile} from '../../scripts/qualification/recovery-custody.mjs';
import {assertSuccessfulWorkerShutdown} from '../../scripts/qualification/es955-workers.ts';
import {auditPortableWorkerProfiles} from '../../scripts/qualification/portable-state-worker-profiles.ts';

assert.equal(process.platform, 'linux'); assert.equal(process.versions.bun, undefined); assert.match(process.version, /^v(?:24|26)\./);
const file = fileURLToPath(import.meta.url), mode = process.argv[2], scenario = process.argv[3] ?? mode;
const until = async (test, label) => {const deadline = performance.now() + 8000;
    while (!await test()) {assert.ok(performance.now() < deadline, label); await pause(10);}};
if (mode === 'reader') {
    process.title = process.env.READER_FIXTURE_TITLE; const timer = setInterval(() => {}, 1000);
    process.on('message', message => {
        if (message?.event === 'fixture_title') {process.title = message.title; process.send({event: 'fixture_title_done'});}
        if (message?.event === 'fixture_fail') {clearInterval(timer); process.exit(7);}
    });
    process.send({event: 'fixture_reader_ready', pid: process.pid});
} else if (mode === 'server') {
    const control = readWireReaderRecoveryControl(process.env.ES198_WIRE_READER_CONTROL, {
        observerDirectory: process.env.ES198_OBSERVER_DIR, configFile: process.env.CONFIG_JSON, chain: process.env.CHAIN_NAME});
    process.title = control.titlePrefix + '-master';
    cluster.setupPrimary({exec: file, args: ['reader'], silent: true});
    const master = {shutdownStarted: false, liveReader: {}, protocolAbiSource: undefined, actionCanonicalLib: undefined};
    master.protocolAbiCoordinator = {retainSourceFence: (session, generation) => () =>
        master.protocolAbiSource?.readerSessionId === session && master.protocolAbiSource?.generation === generation};
    const launch = () => {
        const worker = cluster.fork({worker_role: 'continuous_reader', worker_id: '1',
            READER_FIXTURE_TITLE: `${control.titlePrefix}-continuous_reader:1`}); worker.id = 1;
        worker.process.stdout.resume(); worker.process.stderr.pipe(process.stderr);
        worker.on('message', message => {
            if (message?.event === 'fixture_reader_ready') {
                assert.equal(message.pid, worker.process.pid); master.liveReader.wref = worker;
                master.protocolAbiSource = {worker, readerSessionId: randomUUID(), generation: randomUUID()};
                master.actionCanonicalLib = {worker, blockNum: 196420, blockId: 'a'.repeat(64)};
            }
            if (message?.event === 'fixture_title_done') process.send({event: 'fixture_title_done'});
        });
        worker.once('exit', (_code, signal) => {if (signal === 'SIGKILL') {
            master.liveReader.wref = undefined; master.protocolAbiSource = undefined;
            setTimeout(launch, 50); // Constructed controller state only; production keeps its original relaunch timing.
        }});
        return worker;
    };
    const reader = launch(); await until(() => master.protocolAbiSource, 'native test reader ready');
    const end = {role: 'ds_pool_worker', status: 'quiescent', rootResult: 'returned', acknowledgementAttempted: true, freshWriteOverflow: false,
        epoch: randomUUID(), incarnation: randomUUID(), attemptId: randomUUID(), binding: {blockNum: 33, blockId: control.blockId,
            traceOrdinal: 0, admissionId: 'h45actionadmission1:' + 'a'.repeat(64), planId: 'h45actionplan1:' + 'b'.repeat(64)},
        descriptor: {kind: 'ds-delivery', payloadSha256: 'c'.repeat(64), headersSha256: 'd'.repeat(64)},
        freshWrites: [{kind: 'confirmed-handoff', classification: 'confirmed-handoff', id: 'h45actionhandoff1:' + 'e'.repeat(64)}]};
    const held = {master, reader, source: master.protocolAbiSource, coordinator: master.protocolAbiCoordinator,
        readerSessionId: master.protocolAbiSource.readerSessionId, generation: master.protocolAbiSource.generation,
        readBlockNum: 33, response: {blockId: control.blockId, previousBlockId: 'f'.repeat(64)}, end,
        release() {held.returned = true;}};
    const record = createWireReaderRecorder(control);
    durableRecoveryFile(join(control.output, 'reader-recovery/held.json'), {runId: control.runId,
        masterPid: process.pid, parentPid: process.ppid, controlSha256: wireReaderControlDigest(control), end});
    installWireReaderRecoveryHost(control, () => held, record);
    process.on('message', message => {
        if (message?.event === 'fixture_title') reader.send({event: 'fixture_title', title: 'foreign-reader-title'});
        if (message?.event === 'fixture_fail_replacement') master.liveReader.wref.send({event: 'fixture_fail'});
    });
    process.send({event: 'fixture_server_ready', pid: process.pid});
} else {
    assert.ok(['unchanged', 'copied-snapshot', 'copied-receipt', 'consumed-snapshot', 'wrong-run', 'changed-title', 'extra-failure'].includes(scenario));
    const output = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'hapi-reader-controller-')));
    const chain = 'hyp-p191-123456abcdef', profileId = 'wire-sysio-6508c9e8-native-engineering-v1', configFile = join(output, 'chain.json');
    mkdirSync(join(output, 'observer/master'), {recursive: true});
    durableRecoveryFile(configFile, {settings: {chain, protocol: {profileId}}});
    const {file: controlFile, control} = createWireReaderRecoveryControl({output, configFile, chain, frameSha256: 'a'.repeat(64),
        resumeFrameSha256: 'c'.repeat(64), source: {chainId: '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d',
            profileId, endBlock: 1480, records: Array.from({length: 34}, (_, i) => ({blockId: (i === 33 ? 'd' : 'b').repeat(64)}))}});
    const child = fork(file, ['server'], {cwd: output, detached: true, execArgv: ['--import',
        pathToFileURL(fileURLToPath(new URL('../../scripts/qualification/es955-worker-observer.mjs', import.meta.url))).href],
        env: {...process.env, worker_role: '', worker_id: '', CONFIG_JSON: configFile, CHAIN_NAME: chain,
            HYPERION_PORTABLE_NATIVE_QUALIFICATION: '1', ES198_CPU_PROFILE: '0',
            ES198_OBSERVER_DIR: join(output, 'observer/master'), ES198_WIRE_READER_CONTROL: controlFile}, silent: true});
    const state = {ready: false, titleChanged: false, wrongRunRejected: false, exited: false, code: null, signal: null, stderr: ''};
    child.stdout.resume(); child.stderr.on('data', bytes => {state.stderr += bytes.toString(); assert.ok(state.stderr.length < 65536);});
    child.on('message', message => {
        if (message?.event === 'fixture_server_ready') {assert.equal(message.pid, child.pid); state.ready = true;}
        if (message?.event === 'fixture_title_done') state.titleChanged = true;
        if (message?.event === 'qualifier_reader_reply' && message.mId === '0'.repeat(36)) state.wrongRunRejected = message.ok === false;
    });
    child.once('exit', (code, signal) => Object.assign(state, {exited: true, code, signal: signal ?? null}));
    const observerRows = async () => {
        const {readdirSync} = await import('node:fs'); const rows = [];
        for (const name of readdirSync(join(output, 'observer/master')).filter(name => name.endsWith('.jsonl'))) {
            const bytes = readFileSync(join(output, 'observer/master', name));
            for (const line of bytes.subarray(0, bytes.lastIndexOf(10) + 1).toString().split('\n').filter(Boolean)) rows.push(JSON.parse(line));
        }
        return rows;
    };
    let crash, snapshot, result;
    try {
        await until(() => {assert.equal(state.exited, false, state.stderr); return state.ready;}, 'native parent controller ready'); assert.equal(state.stderr, '');
        if (scenario === 'wrong-run') {
            child.send({event: 'qualifier_reader_request', mId: '0'.repeat(36), runId: randomUUID(), operation: 'snapshot'});
            await until(() => state.wrongRunRejected, 'foreign run rejected before capture');
        }
        const token = await snapshotWireReader({control, child, rows: await observerRows()}); snapshot = describeWireReaderSnapshot(token);
        if (scenario === 'changed-title') {
            child.send({event: 'fixture_title'}); await until(() => state.titleChanged, 'native reader changes title after capture');
            await assert.rejects(crashWireReader(token), /title differs/);
            assert.equal(existsSync(`/proc/${snapshot.census.reader.pid}/stat`), true);
        } else {
            if (scenario === 'copied-snapshot') await assert.rejects(crashWireReader(structuredClone(token)), /unissued/);
            crash = await crashWireReader(token); const described = describeWireReaderCrash(crash);
            assert.equal(described.fence.reader.pid, snapshot.census.reader.pid);
            if (scenario === 'consumed-snapshot') await assert.rejects(crashWireReader(token), /consumed/);
            if (scenario === 'copied-receipt') {
                assert.throws(() => describeWireReaderCrash(structuredClone(crash)), /unissued/);
                await assert.rejects(wireReaderStatus(structuredClone(crash)), /unissued/);
                await assert.rejects(releaseWireReaderRpc(structuredClone(crash)), /unissued/);
            }
            await until(async () => (await wireReaderStatus(crash)).replacement, 'replacement native reader observed by same parent');
            await releaseWireReaderRpc(crash); await assert.rejects(releaseWireReaderRpc(crash), /released/);
            assert.equal((await wireReaderStatus(crash)).masterPid, child.pid);
            if (scenario === 'extra-failure') {
                child.send({event: 'fixture_fail_replacement'});
                await until(async () => (await observerRows()).some(row => row.kind === 'worker_exit' && row.code === 7), 'second actual child failure retained');
            }
        }
        child.send({event: 'qualifier_shutdown'}); await until(() => state.exited, 'native parent and readers shut down');
        const rows = await observerRows(), original = structuredClone(rows);
        if (crash) {
            assert.equal(state.code, 1); assert.equal(state.signal, null);
            if (scenario === 'extra-failure') assert.throws(() => wireReaderShutdownRows(rows, crash, child.pid, state.code, state.signal));
            else {
                const normal = wireReaderShutdownRows(rows, crash, child.pid, state.code, state.signal);
                assertSuccessfulWorkerShutdown(normal, child.pid, 0, null);
                const profiles = await auditPortableWorkerProfiles(output, 'master', normal, child.pid, false);
                assert.equal(profiles.length, 2); assert.ok(profiles.every(value => value.state === 'disabled'));
                for (const mutate of [copy => {copy.find(row => row.kind === 'exit' && row.pid === child.pid).code = 2;},
                    copy => {copy.find(row => row.kind === 'shutdown' && row.pid === child.pid).forced.push({pid: 1});}]) {
                    const copy = structuredClone(rows); mutate(copy); assert.throws(() => wireReaderShutdownRows(copy, crash, child.pid, state.code, state.signal));
                }
            }
        } else {assert.equal(state.code, 0); assertSuccessfulWorkerShutdown(rows, child.pid, 0, null);}
        assert.deepEqual(rows, original); assert.equal(state.stderr, '');
        result = {passed: true, scenario, native: process.version, realNativeIpcAndProcesses: true,
            controlledParentState: true, rawIntentionalFaultRetained: !!crash, capacityAuthority: false, productionHandoverQualified: false};
    } finally {
        if (!state.exited) {
            if (child.connected) child.send({event: 'qualifier_shutdown'});
            try {await until(() => state.exited, 'native controller cleanup');}
            catch {process.kill(-child.pid, 'SIGKILL'); await until(() => state.exited, 'owned test group fallback cleanup');}
        }
        const resolved = realpathSync(output); assert.equal(dirname(resolved), realpathSync(tmpdir()));
        assert.ok(basename(resolved).startsWith('hapi-reader-controller-')); rmSync(resolved, {recursive: true, force: true});
    }
    console.log(JSON.stringify(result));
}
