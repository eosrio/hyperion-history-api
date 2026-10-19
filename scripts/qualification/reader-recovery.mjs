/** Disposable-broker reader recovery qualification. No default server or queue. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {fork} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createServer, connect as tcpConnect} from 'node:net';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, createHash} from 'node:crypto';
import {connect} from 'amqplib';
import {cargo} from 'async';

const file = fileURLToPath(import.meta.url);
const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, ms = 15000) {
    const deadline = Date.now() + ms;
    while (!await predicate()) {
        assert(Date.now() < deadline, `Deadline exceeded: ${label}`);
        await sleep(10);
    }
}

async function readerWorker() {
    const {default: StateReader} = await import('../../build/indexer/workers/state-reader.js');
    const {ReaderConfirmRange} = await import('../../build/indexer/helpers/reader-progress.js');
    const connection = await connect(process.env.READER_RECOVERY_AMQP_URL).then(connection => {
        connection.on('error', () => {}); return connection;
    });
    const ch = await connection.createChannel();
    let publisher = await connection.createConfirmChannel().then(channel => {
        channel.on('error', () => {}); return channel;
    });
    const first = Number(process.env.first_block), end = Number(process.env.last_block);
    const reader = Object.assign(Object.create(StateReader.prototype), {
        chain: process.env.READER_RECOVERY_CHAIN, conf: {scaling: {ds_queues: 1, batch_size: 100}},
        ch, cch: publisher, ch_ready: true, cch_ready: true, events: new EventEmitter(), isLiveReader: false,
        currentIdx: 1, drainCount: 0, local_distributed_count: 0, range_size: end - first,
        confirmRange: new ReaderConfirmRange(first, end), assignmentId: process.env.reader_assignment,
        publications: new Map(), internalPendingRanges: [], completionSignaled: false, allowRequests: true,
        profiler: {stopReporting() {}},
        shipInitStatus: {trace_begin_block: 0}, ship: {close() {}}
    });
    reader.stageOneDistQueue = cargo((tasks, callback) => reader.distribute(tasks, callback), 16);
    reader.blockReadingQueue = {pause() {}, idle() {return true;}};
    reader.requestBlockRange = (start, finish) => {
        const sourceHeld = process.env.READER_RECOVERY_HOLD_LATER_ASSIGNMENT === '1' && Number(start) !== first;
        process.send?.({event: 'qualification_assignment', first: start, end: finish, assignment: reader.assignmentId, sourceHeld});
        // The crash must precede every publication from the later range. The
        // replacement's startup range is allowed through, proving its replay
        // supplies input that could not have reached the broker beforehand.
        if (sourceHeld) return;
        const blocks = [];
        for (let num = Number(start); num < Number(finish); num++) blocks.push({num, content: Buffer.from(String(num))});
        reader.stageOneDistQueue.push(blocks);
    };
    process.on('message', async msg => {
        if (msg.event === 'qualification_channel_close') await publisher.close();
        else if (msg.event === 'qualification_replace') {
            publisher = await connection.createConfirmChannel().then(channel => {
                channel.on('error', () => {}); return channel;
            });
            reader.cch = publisher;
            await reader.assertQueues();
        } else if (msg.event === 'qualification_stop') process.exit(0);
        else reader.onIpcMessage(msg);
    });
    await reader.assertQueues();
    if (process.env.worker_role === 'repair_reader') process.send?.({event: 'repair_reader_ready'});
    else reader.requestBlockRange(first, end);
}

export async function frameProxy(url, mode) {
    const upstream = new URL(url);
    const brokerHost = upstream.hostname, brokerPort = Number(upstream.port || 5672);
    const sockets = new Set();
    const held = [];
    let confirms = 0, injectedNacks = 0;
    const server = createServer(client => {
        const broker = tcpConnect({host: brokerHost, port: brokerPort});
        sockets.add(client); sockets.add(broker);
        client.on('error', () => {}); broker.on('error', () => {});
        client.on('close', () => {sockets.delete(client); broker.destroy();});
        broker.on('close', () => {sockets.delete(broker); client.destroy();});
        client.pipe(broker);
        let buffer = Buffer.alloc(0);
        broker.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 7) {
                const length = buffer.readUInt32BE(3) + 8;
                assert(length <= 16 * 1024 * 1024, 'Unexpected AMQP frame size');
                if (buffer.length < length) break;
                let frame = buffer.subarray(0, length);
                buffer = buffer.subarray(length);
                const confirm = frame[0] === 1 && frame.length >= 20 && frame.readUInt16BE(7) === 60 &&
                    (frame.readUInt16BE(9) === 80 || frame.readUInt16BE(9) === 120);
                if (confirm) {
                    confirms++;
                    if (mode === 'nack') {
                        if (injectedNacks++) continue;
                        frame = Buffer.from(frame);
                        frame.writeUInt16BE(120, 9); // basic.ack -> basic.nack; same encoded fields
                    } else if (mode !== 'normal') {held.push({client, frame: Buffer.from(frame)}); continue;}
                }
                client.write(frame);
            }
        });
    });
    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
    upstream.hostname = '127.0.0.1'; upstream.port = String(server.address().port);
    return {url: upstream.href, get confirms() {return confirms;}, get held() {return held.length;},
        get injectedNacks() {return injectedNacks;},
        sever() {for (const socket of sockets) socket.destroy();},
        release() {for (const item of held.splice(0)) if (!item.client.destroyed) item.client.write(item.frame);},
        async close() {for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));}
    };
}

async function collectQueue(channel, queue) {
    const bodies = [];
    for (;;) {
        const item = await channel.get(queue, {noAck: true});
        if (!item) return bodies;
        bodies.push(Number(item.content.toString()));
    }
}

async function main() {
    const url = process.env.READER_RECOVERY_AMQP_URL;
    const run = process.env.READER_RECOVERY_RUN;
    assert(url && run && /^[a-zA-Z0-9_-]{8,64}$/.test(run), 'Explicit owned AMQP URL and fixture run ID are required');
    const endpoint = new URL(url);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'Run on the fixture host against its loopback publication');
    const output = resolve(process.argv[2] ?? '');
    assert(process.argv[2] && !existsSync(output), 'A new evidence output directory is required');
    mkdirSync(output, {recursive: true});
    const configuration = mkdtempSync(join(tmpdir(), 'hyperion-reader-recovery-'));
    mkdirSync(join(configuration, 'config'));
    writeFileSync(join(configuration, 'chain.json'), JSON.stringify({settings: {chain: 'qualification'}, indexer: {}}));
    writeFileSync(join(configuration, 'config', 'connections.json'), '{}');
    const environment = {...process.env, CONFIG_JSON: join(configuration, 'chain.json'), worker_role: 'reader', worker_id: '1'};
    let connection, channel;
    const queues = [], children = new Set(), clusterWorkers = new Set();
    const report = {schema: 1, status: 'running', run, runtime: process.version, startedAt: new Date().toISOString(),
        boundary: 'Actual AMQP broker and Node worker processes with emitted StateReader publication methods; deterministic numeric source payloads, not SHIP decoding or Elasticsearch durability.', cases: [], children: [], amqpErrors: []};
    report.sources = Object.fromEntries(['src/indexer/helpers/reader-progress.ts', 'src/indexer/workers/state-reader.ts',
        'src/indexer/modules/master.ts', 'build/indexer/helpers/reader-progress.js', 'build/indexer/workers/state-reader.js',
        'build/indexer/modules/master.js', 'scripts/qualification/reader-recovery.mjs', 'package-lock.json'].map(path => {
        const bytes = readFileSync(join(repository, path));
        return [path, {bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')}];
    }));
    report.runtimeBinarySha256 = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
    async function spawnReader(chain, publisherUrl, assignment, first = 10, end = 13) {
        const messages = [], stderr = [], stdout = [];
        const child = fork(file, ['--reader-worker'], {cwd: configuration, env: {...environment,
            READER_RECOVERY_CHAIN: chain, READER_RECOVERY_AMQP_URL: publisherUrl,
            reader_assignment: assignment, first_block: String(first), last_block: String(end)}, silent: true});
        children.add(child);
        const observation = {pid: child.pid, chain, assignment, first, end, messages, stdout, stderr,
            outcome: null};
        report.children.push(observation);
        child.on('message', msg => messages.push(msg));
        child.stdout.on('data', chunk => stdout.push(chunk.toString()));
        child.stderr.on('data', chunk => stderr.push(chunk.toString()));
        const exited = new Promise(resolve => child.once('exit', (code, signal) => {
            observation.outcome = {code, signal}; children.delete(child); resolve({code, signal});
        }));
        return {child, messages, exited, stderr, stdout};
    }
    async function scheduledReplay(repair) {
        const {HyperionMaster} = await import('../../build/indexer/modules/master.js');
        const chain = `qualifier-${run}-${randomUUID().slice(0, 8)}`;
        const queue = `${chain}:blocks:1`;
        queues.push(queue);
        const initial = repair ? 100 : 10, later = repair ? 200 : 13;
        const definition = {worker_id: 1, worker_role: repair ? 'repair_reader' : 'reader',
            first_block: initial, last_block: initial + 3, reader_assignment: 'initial-assignment',
            CONFIG_JSON: environment.CONFIG_JSON, READER_RECOVERY_CHAIN: chain, READER_RECOVERY_AMQP_URL: url};
        definition.READER_RECOVERY_HOLD_LATER_ASSIGNMENT = '1';
        const messages = [], exits = [], launches = [];
        let crashed = false, repairFinished = false;
        const master = Object.assign(Object.create(HyperionMaster.prototype), {
            workerMap: [definition], activeReadersCount: 1, max_readers: 1, lastAssignedBlock: 13,
            maxBatchSize: 3, head: 16, allowMoreReaders: true, indexerMonitor: {}, dsPoolMap: new Map(),
            pendingRepairRanges: repair ? [{start: 200, end: 202}] : [], repairReader: repair ? definition : undefined,
            connectedController: {send(body) {if (JSON.parse(body).event === 'repair_completed') repairFinished = true;}}
        });
        master.initHandlerMap();
        const onFork = worker => {
            clusterWorkers.add(worker);
            launches.push({pid: worker.process.pid, first: definition.first_block, end: definition.last_block,
                assignment: definition.reader_assignment});
            worker.on('error', error => messages.push({event: 'qualification_worker_error', error: error.message}));
            worker.on('message', msg => {
                messages.push({pid: worker.process.pid, ...msg});
                if (msg.event === 'qualification_assignment' && msg.first === later && !crashed) {
                    assert.equal(msg.sourceHeld, true, 'Later range published before the crash boundary');
                    crashed = true;
                    worker.kill('SIGKILL');
                }
            });
            worker.once('exit', (code, signal) => {
                clusterWorkers.delete(worker); exits.push({pid: worker.process.pid, code, signal});
            });
            worker.process.stdout?.on('data', chunk => writeFileSync(join(output, `${repair ? 'repair' : 'history'}-${worker.process.pid}.stdout.log`), chunk, {flag: 'a'}));
            worker.process.stderr?.on('data', chunk => writeFileSync(join(output, `${repair ? 'repair' : 'history'}-${worker.process.pid}.stderr.log`), chunk, {flag: 'a'}));
        };
        const onDisconnect = worker => master.handleWorkerDisconnect(worker);
        cluster.setupPrimary({exec: file, args: ['--reader-worker'], cwd: configuration, silent: true});
        cluster.on('fork', onFork);
        cluster.on('disconnect', onDisconnect);
        try {
            master.launchWorkers();
            await until(() => crashed && launches.length === 2, 'supervised current-assignment replacement', 20000);
            assert.deepEqual(launches.map(item => [item.first, item.end]), [[initial, initial + 3], [later, later + 3]]);
            assert.notEqual(launches[0].assignment, launches[1].assignment);
            await until(() => repair ? repairFinished : master.activeReadersCount === 0, 'replayed range completion');
            if (repair) {
                master.shutdownStarted = true;
                definition.wref.send({event: 'finish', target: '1'});
            }
            await until(() => exits.length === 2 && clusterWorkers.size === 0, 'all scheduled worker exits');
            assert.deepEqual(exits.map(item => ({code: item.code, signal: item.signal})), [
                {code: null, signal: 'SIGKILL'}, {code: 0, signal: null}
            ]);
            const bodies = await collectQueue(channel, queue);
            const expected = [initial, initial + 1, initial + 2, later, later + 1, later + 2];
            assert.deepEqual([...new Set(bodies)].sort((a, b) => a - b), expected);
            assert.equal(bodies.length, 6, 'Held later range was published before replacement or replay duplicated the wrong assignment');
            report.cases.push({mode: repair ? 'repair-assignment-replay' : 'historical-later-assignment-replay',
                status: 'passed', launches, exits, messages, logicalInputs: 6, physicalMessages: bodies.length,
                intentionalReplayDuplicates: bodies.length - 6});
        } finally {
            master.shutdownStarted = true;
            cluster.removeListener('fork', onFork); cluster.removeListener('disconnect', onDisconnect);
            for (const worker of clusterWorkers) worker.kill('SIGKILL');
            await until(() => clusterWorkers.size === 0, 'scheduled worker cleanup');
        }
    }
    try {
        connection = await connect(url).then(connection => {
            connection.on('error', error => report.amqpErrors.push({source: 'connection', error: error.message}));
            return connection;
        });
        channel = await connection.createChannel().then(channel => {
            channel.on('error', error => report.amqpErrors.push({source: 'oracle-channel', error: error.message}));
            return channel;
        });
        for (const mode of ['normal', 'nack', 'lost', 'channel', 'replace']) {
            const chain = `qualifier-${run}-${randomUUID().slice(0, 8)}`;
            const queue = `${chain}:blocks:1`;
            queues.push(queue);
            const proxy = await frameProxy(url, mode);
            const reader = await spawnReader(chain, proxy.url, `assignment-${mode}`);
            try {
                await until(() => {
                    assert(reader.child.exitCode === null && reader.child.signalCode === null,
                        `${mode} worker exited before readiness: ${reader.stderr.join('')} ${reader.stdout.join('')}`);
                    return reader.messages.some(msg => msg.event === 'qualification_assignment');
                }, `${mode} queue and worker ready`);
                await until(async () => {
                    return (await channel.checkQueue(queue)).messageCount === 3;
                }, `${mode} durable broker queue contains all accepted inputs`);
                if (mode === 'normal') {
                    await until(() => reader.messages.some(msg => msg.event === 'completed'), 'healthy range completion');
                    reader.child.send({event: 'qualification_stop'});
                } else if (mode !== 'nack') {
                    await until(() => proxy.held > 0, `${mode} held broker confirms`);
                    if (mode === 'lost') proxy.sever();
                    else reader.child.send({event: mode === 'channel' ? 'qualification_channel_close' : 'qualification_replace'});
                }
                let outcome;
                await until(async () => {
                    const state = await Promise.race([reader.exited, sleep(5).then(() => null)]);
                    if (state) {outcome = state; return true;} return false;
                }, `${mode} worker exit`);
                assert.deepEqual(outcome, {code: mode === 'normal' ? 0 : 1, signal: null});
                assert.equal(reader.messages.filter(msg => msg.event === 'completed').length, mode === 'normal' ? 1 : 0);
                if (mode !== 'normal') assert.equal(reader.messages.filter(msg => msg.event === 'reader_recovery_required').length, 1);
                if (mode !== 'normal') {
                    proxy.release();
                    const replay = await spawnReader(chain, url, `replay-${mode}`);
                    await until(() => replay.messages.some(msg => msg.event === 'completed'), `${mode} replay completion`);
                    replay.child.send({event: 'qualification_stop'});
                    assert.deepEqual(await replay.exited, {code: 0, signal: null});
                    assert.equal(replay.messages.filter(msg => msg.event === 'read_block').length, 3);
                }
                const bodies = await collectQueue(channel, queue);
                assert.deepEqual([...new Set(bodies)].sort((a, b) => a - b), [10, 11, 12]);
                assert.equal(bodies.length, mode === 'normal' ? 3 : 6);
                report.cases.push({mode, status: 'passed', outcome, brokerConfirmsObserved: proxy.confirms,
                    brokerConfirmsHeld: proxy.held, injectedNackFrames: mode === 'nack' ? 1 : 0,
                    messages: reader.messages, logicalInputs: 3, physicalMessages: bodies.length,
                    intentionalReplayDuplicates: bodies.length - 3, stderr: reader.stderr.join(''), stdout: reader.stdout.join('')});
            } finally {await proxy.close();}
        }
        await scheduledReplay(false);
        await scheduledReplay(true);
        report.status = 'passed';
    } catch (error) {report.status = 'failed'; report.error = error.stack ?? String(error); throw error;}
    finally {
        for (const child of children) child.kill('SIGKILL');
        const cleanupErrors = [];
        try {await until(() => children.size === 0, 'owned worker cleanup');} catch (error) {cleanupErrors.push(error.message);}
        const cleanup = [];
        for (const queue of queues) {
            try {cleanup.push({queue, result: await channel?.deleteQueue(queue)});} catch (error) {
                cleanup.push({queue, error: error.message}); cleanupErrors.push(error.message);
            }
        }
        try {await channel?.close();} catch (error) {cleanupErrors.push(error.message);}
        try {await connection?.close();} catch (error) {cleanupErrors.push(error.message);}
        try {rmSync(configuration, {recursive: true, force: true});} catch (error) {cleanupErrors.push(error.message);}
        report.cleanup = {queues: cleanup, childProcessesRemaining: children.size, errors: cleanupErrors};
        if (cleanupErrors.length || report.amqpErrors.length) {
            report.status = 'failed'; report.error ??= [...cleanupErrors, ...report.amqpErrors.map(item => item.error)].join('; ');
        }
        report.finishedAt = new Date().toISOString();
        writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    }
    if (report.status !== 'passed') process.exitCode = 1;
    console.log(JSON.stringify({status: report.status, cases: report.cases.length, output}));
}

if (resolve(process.argv[1] ?? '') === file) {
    if (process.argv.includes('--reader-worker')) await readerWorker();
    else await main();
}
