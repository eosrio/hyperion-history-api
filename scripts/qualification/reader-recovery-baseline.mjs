/** Reproduce #208 against unmodified methods emitted from the pinned pre-fix commit. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {fork, execFileSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {connect} from 'amqplib';
import {cargo} from 'async';
import {frameProxy} from './reader-recovery.mjs';

const file = fileURLToPath(import.meta.url);
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, ms = 15000) {
    const deadline = Date.now() + ms;
    while (!await predicate()) {assert(Date.now() < deadline, label); await sleep(10);}
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function worker() {
    const {default: StateReader} = await import('../../build/indexer/workers/state-reader.baseline.js');
    const connection = await connect(process.env.READER_RECOVERY_AMQP_URL).then(connection => {
        connection.on('error', () => {}); return connection;
    });
    const ch = await connection.createChannel();
    const publisher = await connection.createConfirmChannel().then(channel => {channel.on('error', () => {}); return channel;});
    const first = Number(process.env.first_block), end = Number(process.env.last_block);
    const reader = Object.assign(Object.create(StateReader.prototype), {
        chain: process.env.READER_RECOVERY_CHAIN, conf: {scaling: {ds_queues: 1, batch_size: 100}},
        ch, cch: publisher, ch_ready: true, cch_ready: true, events: new EventEmitter(), isLiveReader: false,
        currentIdx: 1, drainCount: 0, local_distributed_count: 0, range_size: end - first,
        internalPendingRanges: [], completionSignaled: false, allowRequests: true,
        shipInitStatus: {trace_begin_block: 0}
    });
    reader.stageOneDistQueue = cargo((tasks, callback) => reader.distribute(tasks, callback), 16);
    reader.requestBlockRange = (start, finish) => {
        const sourceHeld = process.env.READER_RECOVERY_HOLD_LATER_ASSIGNMENT === '1' && Number(start) !== first;
        process.send?.({event: 'qualification_assignment', first: start, end: finish, sourceHeld});
        if (sourceHeld) return;
        const blocks = [];
        for (let num = Number(start); num < Number(finish); num++) blocks.push({num, content: Buffer.from(String(num))});
        reader.stageOneDistQueue.push(blocks);
    };
    process.on('message', msg => {
        if (msg.event === 'qualification_stop') process.exit(0);
        else reader.onIpcMessage(msg);
    });
    await reader.assertQueues();
    reader.requestBlockRange(first, end);
}

async function main() {
    const base = '37e3ee6bb897a3647b88d272e55d43240ecf7dc6';
    const url = process.env.READER_RECOVERY_AMQP_URL, run = process.env.READER_RECOVERY_RUN;
    assert(url && run && /^[a-zA-Z0-9_-]{8,64}$/.test(run));
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname));
    const output = resolve(process.argv[2] ?? '');
    assert(process.argv[2] && !existsSync(output));
    mkdirSync(output, {recursive: true});
    const report = {schema: 1, status: 'running', base, runtime: process.version, run, cases: [], children: [],
        boundary: 'Unmodified pre-fix reader/master methods, real broker and worker processes. Synthetic numeric source; process-only failure proof.'};
    report.baselineCompiler = {command: 'npm run build -- --noCheck',
        boundary: 'Emit unmodified historical classes beside current classes without nominal private-member type conflicts. This counterexample does not establish baseline typecheck acceptance; current production is separately fully checked.'};
    const temporarySources = [];
    try {
        for (const relative of ['src/indexer/workers/state-reader.ts', 'src/indexer/modules/master.ts']) {
            const bytes = execFileSync('git', ['show', `${base}:${relative}`], {cwd: repo});
            const temporary = join(repo, relative.replace(/\.ts$/, '.baseline.ts'));
            writeFileSync(temporary, bytes, {flag: 'wx'});
            temporarySources.push(temporary);
            writeFileSync(join(output, relative.endsWith('master.ts') ? 'master.baseline.ts' : 'state-reader.baseline.ts'), bytes);
        }
        try {
            const stdout = execFileSync('npm', ['run', 'build', '--', '--noCheck'], {cwd: repo, stdio: 'pipe'});
            writeFileSync(join(output, 'baseline-compiler.stdout.log'), stdout);
        } catch (error) {
            writeFileSync(join(output, 'baseline-compiler.stdout.log'), error.stdout ?? '');
            writeFileSync(join(output, 'baseline-compiler.stderr.log'), error.stderr ?? '');
            report.status = 'failed'; report.error = `Baseline emission failed: ${error.message}`;
            writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
            throw error;
        }
    } finally {
        for (const source of temporarySources) rmSync(source);
    }
    report.sources = Object.fromEntries(['build/indexer/workers/state-reader.baseline.js', 'build/indexer/modules/master.baseline.js',
        'scripts/qualification/reader-recovery-baseline.mjs', 'scripts/qualification/reader-recovery.mjs', 'package-lock.json'].map(path => {
        const bytes = readFileSync(join(repo, path)); return [path, {bytes: bytes.length, sha256: sha(bytes)}];
    }));
    report.runtimeBinarySha256 = sha(readFileSync(process.execPath));
    const configuration = mkdtempSync(join(tmpdir(), 'hyperion-reader-baseline-'));
    mkdirSync(join(configuration, 'config'));
    writeFileSync(join(configuration, 'chain.json'), JSON.stringify({settings: {chain: 'qualification'}, indexer: {}}));
    writeFileSync(join(configuration, 'config', 'connections.json'), '{}');
    const environment = {...process.env, CONFIG_JSON: join(configuration, 'chain.json'), worker_role: 'reader', worker_id: '1'};
    const queues = [], children = new Set(), clusterWorkers = new Set();
    let connection, channel;
    try {
        connection = await connect(url).then(connection => {connection.on('error', () => {}); return connection;});
        channel = await connection.createChannel().then(channel => {channel.on('error', () => {}); return channel;});
        for (const mode of ['nack', 'lost']) {
            const chain = `qualifier-${run}-${randomUUID().slice(0, 8)}`, queue = `${chain}:blocks:1`;
            queues.push(queue);
            const proxy = await frameProxy(url, mode);
            const messages = [], stdout = [], stderr = [];
            const child = fork(file, ['--baseline-worker'], {cwd: configuration, env: {...environment,
                READER_RECOVERY_CHAIN: chain, READER_RECOVERY_AMQP_URL: proxy.url, first_block: '10', last_block: '11'}, silent: true});
            children.add(child);
            const observation = {pid: child.pid, mode, messages, stdout, stderr, outcome: null};
            report.children.push(observation);
            child.on('message', msg => messages.push(msg));
            child.stdout.on('data', chunk => stdout.push(chunk.toString()));
            child.stderr.on('data', chunk => stderr.push(chunk.toString()));
            child.once('exit', (code, signal) => {observation.outcome = {code, signal}; children.delete(child);});
            try {
                await until(() => messages.some(msg => msg.event === 'qualification_assignment'), 'Baseline worker readiness');
                await until(async () => (await channel.checkQueue(queue)).messageCount === 1, 'Baseline broker accepted input');
                if (mode === 'lost') {
                    await until(() => proxy.held > 0, 'Baseline broker confirm was withheld');
                    proxy.sever();
                }
                await until(() => messages.some(msg => msg.event === 'completed'), 'Expected baseline false completion was not reproduced');
                assert.equal(messages.filter(msg => msg.event === 'read_block').length, 0, 'Baseline unexpectedly had a successful confirm');
                assert.equal(messages.filter(msg => msg.event === 'reader_recovery_required').length, 0);
                child.send({event: 'qualification_stop'});
                await until(() => observation.outcome !== null, 'Baseline worker stop');
                assert.deepEqual(observation.outcome, {code: 0, signal: null});
                report.cases.push({mode, status: 'defect-reproduced', unsupportedCompletion: true,
                    successfulReadReports: 0, brokerMessages: 1, messages});
            } finally {await proxy.close();}
        }
        const {HyperionMaster} = await import('../../build/indexer/modules/master.baseline.js');
        const chain = `qualifier-${run}-${randomUUID().slice(0, 8)}`, queue = `${chain}:blocks:1`;
        queues.push(queue);
        const definition = {worker_id: 1, worker_role: 'reader', first_block: 10, last_block: 13,
            CONFIG_JSON: environment.CONFIG_JSON, READER_RECOVERY_CHAIN: chain, READER_RECOVERY_AMQP_URL: url,
            READER_RECOVERY_HOLD_LATER_ASSIGNMENT: '1'};
        const messages = [], launches = [], exits = [];
        let crashed = false;
        const master = Object.assign(Object.create(HyperionMaster.prototype), {
            workerMap: [definition], activeReadersCount: 1, max_readers: 1, lastAssignedBlock: 13,
            maxBatchSize: 3, head: 16, allowMoreReaders: true, indexerMonitor: {}, dsPoolMap: new Map()
        });
        master.initHandlerMap();
        const onFork = child => {
            clusterWorkers.add(child);
            launches.push({pid: child.process.pid, first: definition.first_block, end: definition.last_block});
            const observation = {pid: child.process.pid, mode: 'historical-restart', messages: [], stdout: [], stderr: [], outcome: null};
            report.children.push(observation);
            child.on('message', msg => {
                observation.messages.push(msg); messages.push(msg);
                if (msg.event === 'qualification_assignment' && msg.first === 13 && !crashed) {
                    assert.equal(msg.sourceHeld, true); crashed = true; child.kill('SIGKILL');
                }
            });
            child.process.stdout?.on('data', chunk => observation.stdout.push(chunk.toString()));
            child.process.stderr?.on('data', chunk => observation.stderr.push(chunk.toString()));
            child.once('exit', (code, signal) => {
                observation.outcome = {code, signal}; clusterWorkers.delete(child); exits.push({pid: child.process.pid, code, signal});
            });
        };
        const onDisconnect = child => master.handleWorkerDisconnect(child);
        cluster.setupPrimary({exec: file, args: ['--baseline-worker'], cwd: configuration, silent: true});
        cluster.on('fork', onFork); cluster.on('disconnect', onDisconnect);
        try {
            master.launchWorkers();
            await until(() => crashed && exits.length === 2, 'Baseline stale assignment restart', 20000);
            assert.deepEqual(launches.map(item => [item.first, item.end]), [[10, 13], [10, 13]]);
            assert.equal(master.activeReadersCount, 0);
            const bodies = [];
            for (;;) {const item = await channel.get(queue, {noAck: true}); if (!item) break; bodies.push(Number(item.content.toString()));}
            const missing = [10, 11, 12, 13, 14, 15].filter(num => !bodies.includes(num));
            assert.deepEqual(missing, [13, 14, 15]);
            report.cases.push({mode: 'historical-later-assignment', status: 'defect-reproduced', launches, exits, messages,
                physicalMessages: bodies.length, missing, unsupportedSchedulerFinished: true});
        } finally {master.shutdownStarted = true; cluster.removeListener('fork', onFork); cluster.removeListener('disconnect', onDisconnect);}
        report.status = 'defects-reproduced';
    } catch (error) {report.status = 'failed'; report.error = error.stack ?? String(error); throw error;}
    finally {
        for (const child of children) child.kill('SIGKILL');
        for (const child of clusterWorkers) child.kill('SIGKILL');
        const cleanup = [];
        try {await until(() => !children.size && !clusterWorkers.size, 'Baseline child cleanup');} catch (error) {cleanup.push(error.message);}
        for (const queue of queues) try {await channel?.deleteQueue(queue);} catch (error) {cleanup.push(error.message);}
        try {await channel?.close();} catch (error) {cleanup.push(error.message);}
        try {await connection?.close();} catch (error) {cleanup.push(error.message);}
        rmSync(configuration, {recursive: true, force: true});
        report.cleanup = {errors: cleanup, childProcessesRemaining: children.size + clusterWorkers.size, queues};
        if (cleanup.length) {report.status = 'failed'; report.error ??= cleanup.join('; ');}
        writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    }
    if (report.status !== 'defects-reproduced') process.exitCode = 1;
    console.log(JSON.stringify({status: report.status, cases: report.cases.length, output}));
}

if (process.argv.includes('--baseline-worker')) await worker();
else await main();
