import nodeAssert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import cluster from 'node:cluster';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Run after npm run build. No Docker or external services: the only listener is
// an owned loopback HTTP stub, and the actual worker/manager methods stay intact.
const mode = process.env.ES198_OBSERVER_CHECK_MODE;
let assertions = 0;
const assert = new Proxy(nodeAssert, { get(target, property) {
    const value = target[property];
    return typeof value === 'function' ? (...args) => { assertions++; return value(...args); } : value;
} });
const observer = fileURLToPath(new URL('./es955-worker-observer.mjs', import.meta.url));
const source = fileURLToPath(import.meta.url);
const url = path => new URL(`../../${path}`, import.meta.url).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

if (mode === 'master') {
    cluster.setupPrimary({ exec: source, execArgv: process.execArgv });
    const worker = cluster.fork({ ES198_OBSERVER_CHECK_MODE: 'worker', worker_role: 'reader', worker_id: '1' });
    // Capture one-time readiness before imports or queue HTTP can yield to it.
    const ready = new Promise((resolve, reject) => {
        const cleanup = () => {
            worker.off('message', onMessage);
            worker.off('exit', onExit);
            worker.off('error', onError);
        };
        const onMessage = message => {
            if (message?.event === 'ready') { cleanup(); resolve(message); }
        };
        const onExit = (code, signal) => { cleanup(); reject(new Error(`Worker exited before ready: ${code}/${signal}`)); };
        const onError = error => { cleanup(); reject(error); };
        worker.on('message', onMessage);
        worker.once('exit', onExit);
        worker.once('error', onError);
    });
    // Surface readiness failure at the await below, without an intervening
    // unhandled rejection while the deterministic slow queue request runs.
    void ready.catch(() => {});
    // Hyperion assigns stable slot IDs; wrappers must preserve identity after that change.
    worker.id = 17;
    process.prependListener('message', message => {
        if (message?.event === 'qualifier_shutdown' && process.env.ES198_OBSERVER_CHECK_CASE === 'signal-after-flush') {
            worker.kill('SIGKILL');
        }
        if (message?.event === 'fixture_exit_child') {
            worker.once('exit', (code, signal) => process.send({event: 'fixture_child_exited', code, signal}));
            if (message.signal) worker.kill('SIGKILL');
            else worker.send({event: 'fixture_exit', code: 7});
        }
    });
    if (process.env.ES198_LATE_TEST === '1') process.on('message', message => {
        if (message?.event === 'qualifier_shutdown') setTimeout(() => {
            cluster.fork({ ES198_OBSERVER_CHECK_MODE: 'worker', worker_role: 'reader', worker_id: '2' });
        }, 25);
    });
    const { ConnectionManager } = await import(url('build/indexer/connections/manager.class.js'));
    const queue = await ConnectionManager.prototype.checkQueueSize.call({ conn: { amqp: {
        protocol: 'http', api: `127.0.0.1:${process.env.ES198_HTTP_PORT}`, user: 'fixture', pass: 'fixture', vhost: '/'
    } } }, 'fixture:queue');
    assert.equal(queue, 7);
    await ready;
    const sent = worker.send({ event: 'pause', marker: 'unchanged' }, undefined, undefined, error => {
        assert.ifError(error);
        process.send({ event: 'master_ready', queue, sendReturnBoolean: typeof sent === 'boolean' });
    });
    setInterval(() => {}, 1000);
} else if (mode === 'worker') {
    const { default: StateReader } = await import(url('build/indexer/workers/state-reader.js'));
    const reader = { baseRequest: {}, shipRev: 'v0', ship: { connected: false } };
    const returned = StateReader.prototype.requestBlockRange.call(reader, '17', '25');
    assert.equal(returned, undefined);
    assert.equal(reader.baseRequest.start_block_num, 17);
    assert.equal(reader.baseRequest.end_block_num, 25);
    process.prependListener('message', message => {
        if (message.event === 'fixture_exit' || (message.event === 'qualifier_shutdown' &&
            process.env.ES198_OBSERVER_CHECK_CASE === 'nonzero-after-flush')) process.exit(7);
    });
    process.on('message', message => {
        if (message.event === 'qualifier_shutdown' && process.env.ES198_LATE_TEST === '1' && process.env.worker_id === '1') {
            const until = Date.now() + 200;
            while (Date.now() < until) {}
        }
        if (message.event === 'pause') {
            assert.equal(message.marker, 'unchanged');
            process.send({ event: 'read_block', block_num: 17, id: '1' });
        }
    });
    process.send({ event: 'ready' });
    process.send({ event: 'read_block', block_num: 17171, id: '1' });
    setInterval(() => {}, 1000);
} else {
    const negative = spawnSync(process.execPath,
        ['--import', pathToFileURL(observer).href, '--eval', ''], {
            env: {...process.env, ES198_OBSERVER_DIR: 'relative-path'},
            encoding: 'utf8', timeout: 5000
        });
    assert.equal(negative.error, undefined);
    assert.notEqual(negative.status, 0);
    assert.match(negative.stderr, /must name an existing absolute qualification directory/);
    const cases = [];
    const caseNames = ['normal', 'late-child-shutdown', 'ready-before-queue-response',
        'nonzero-after-flush', 'signal-after-flush', 'nonzero-before-shutdown', 'signal-before-shutdown'];
    const selected = process.env.ES198_CHECK_CASE;
    if (selected) assert.ok(caseNames.includes(selected));
    for (const name of selected ? [selected] : caseNames) cases.push(await runCase(name));
    console.log(JSON.stringify({status: 'passed', runtime: process.version, assertions,
        relativeDirectoryGuard: 'passed', cases, realDockerCalls: 0, externalNetworkCalls: 0}));
}

async function runCase(name) {
    const late = name === 'late-child-shutdown';
    const abnormal = /^(nonzero|signal)-/.test(name);
    const signalExit = name.startsWith('signal-');
    const beforeShutdown = name.endsWith('-before-shutdown');
    const beforeAssertions = assertions;
    const temporaryRoot = realpathSync(tmpdir());
    const directory = mkdtempSync(join(temporaryRoot, 'hyperion-worker-observer-check-'));
    const configDirectory = join(directory, 'config');
    mkdirSync(configDirectory);
    const config = join(directory, 'fixture.json');
    writeFileSync(config, JSON.stringify({ settings: { chain: 'fixture', parser: '3.2' }, indexer: {}, scaling: {}, plugins: {} }));
    writeFileSync(join(configDirectory, 'connections.json'), JSON.stringify({ chains: { fixture: { chain_id: '0'.repeat(64) } } }));
    let requests = 0;
    let serverError;
    const server = http.createServer(async (request, response) => {
        try {
        assert.equal(request.url, '/api/queues/%2F/fixture%3Aqueue');
        requests++;
        if (name === 'ready-before-queue-response') {
            // The following FIFO IPC message proves ready was already delivered
            // while the production manager still awaits this HTTP response.
            const deadline = Date.now() + 5000;
            let delivered = false;
            while (!delivered && Date.now() < deadline) {
                delivered = readdirSync(directory).filter(file => file.endsWith('.jsonl')).some(file =>
                    (() => {
                        const text = readFileSync(join(directory, file), 'utf8');
                        return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
                    })().some(line => {
                        const row = JSON.parse(line);
                        return row.kind === 'ipc_receive' && row.direction === 'master_incoming' &&
                            row.message?.event === 'read_block' && row.message?.block_num === 17171;
                    }));
                if (!delivered) await sleep(10);
            }
            assert.ok(delivered, 'worker ready did not arrive before queue HTTP response');
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ messages: 7 }));
        } catch (error) {
            serverError = error;
            response.writeHead(500, {'Content-Type': 'application/json'});
            response.end(JSON.stringify({error: error.message}));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const child = fork(source, [], {
        cwd: directory, execArgv: ['--import', pathToFileURL(observer).href],
        execPath: process.execPath,
        env: { ...process.env, ES198_OBSERVER_CHECK_MODE: 'master', ES198_OBSERVER_DIR: directory,
            ES198_LATE_TEST: late ? '1' : '0', ES198_CPU_PROFILE: '1', ES198_PROFILE_MAX_MS: '30000',
            ES198_OBSERVER_CHECK_CASE: name,
            CONFIG_JSON: config, ES198_HTTP_PORT: String(server.address().port), worker_role: '', worker_id: '' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.resume();
    const messages = [];
    child.on('message', message => messages.push(message));
    const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 15000;
    try {
        while (!messages.some(message => message.event === 'master_ready') && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        const ready = messages.find(message => message.event === 'master_ready');
        assert.ok(ready, serverError?.stack || stderr);
        assert.equal(ready.sendReturnBoolean, true);
        await new Promise(resolve => setTimeout(resolve, 2300));
        child.send({ event: 'qualifier_flush', requestId: 'smoke-flush' });
        while (readdirSync(directory).filter(name => name.endsWith('.cpuprofile')).length < 2 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (beforeShutdown) {
            child.send({event: 'fixture_exit_child', signal: signalExit});
            while (!messages.some(message => message.event === 'fixture_child_exited') && Date.now() < deadline) await sleep(10);
            const outcome = messages.find(message => message.event === 'fixture_child_exited');
            assert.ok(outcome, 'child did not exit before master shutdown');
            if (signalExit) assert.equal(outcome.signal, 'SIGKILL');
            else assert.equal(outcome.code, 7);
        }
        child.send({ event: 'qualifier_shutdown', requestId: 'smoke-shutdown' });
        const exited = await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('Shutdown timeout')), 10000).unref())]);
        assert.deepEqual(exited, { code: abnormal ? 1 : 0, signal: null }, stderr);
        assert.equal(requests, 1);
        const files = readdirSync(directory).filter(name => name.endsWith('.jsonl'));
        const expectedProcesses = late ? 3 : 2;
        assert.equal(files.length, expectedProcesses);
        const records = files.flatMap(name => readFileSync(join(directory, name), 'utf8').trim().split('\n').map(JSON.parse));
        const starts = records.filter(row => row.kind === 'start');
        assert.equal(starts.length, expectedProcesses);
        assert.ok(starts.every(row => row.executable === process.execPath));
        for (const start of starts) {
            const own = records.filter(row => row.pid === start.pid);
            assert.ok(own.some(row => row.kind === 'sample' && Number.isFinite(row.memory.rss)));
            assert.ok(own.some(row => row.kind === 'profile_saved'));
            assert.ok(own.some(row => row.kind === 'flush' && row.success && row.profileState === 'saved'));
            if (start.role === 'master') {
                const shutdown = own.find(row => row.kind === 'shutdown');
                assert.equal(shutdown?.success, !abnormal);
                assert.ok(own.some(row => row.kind === 'exit' && row.code === (abnormal ? 1 : 0)));
                assert.equal(shutdown.children, late ? 2 : 1);
                assert.equal(shutdown.exited, late ? 2 : 1);
                assert.equal(shutdown.failedChildren.length, abnormal ? 1 : 0);
                if (abnormal) {
                    assert.equal(shutdown.childExits.length, 1);
                    assert.equal(shutdown.childExits[0].code, signalExit ? null : 7);
                    assert.equal(shutdown.childExits[0].signal, signalExit ? 'SIGKILL' : null);
                }
            } else if (!abnormal) {
                assert.ok(own.some(row => row.kind === 'shutdown' && row.success));
                assert.ok(own.some(row => row.kind === 'exit' && row.code === 0));
            }
        }
        assert.ok(records.every(row => Number.isFinite(row.at)));
        assert.ok(records.some(row => row.kind === 'queue_sample' && row.queue === 'fixture:queue' && row.size === 7));
        assert.ok(records.some(row => row.kind === 'ipc_send' && row.event === 'pause' && row.role === 'reader'));
        assert.ok(records.some(row => row.kind === 'ipc_receive' && row.event === 'read_block' && row.role === 'reader'));
        assert.ok(records.some(row => row.kind === 'ship_range_request' && row.role === 'reader' && row.first_block === '17' && row.last_block === '25'));
        if (late) {
            assert.ok(records.some(row => row.kind === 'shutdown_late_child'));
            assert.ok(records.some(row => row.kind === 'shutdown' && row.role === 'master' && row.children === 2 && row.exited === 2 && row.unresolved.length === 0));
        }
        const profiles = readdirSync(directory).filter(name => name.endsWith('.cpuprofile'));
        assert.equal(profiles.length, expectedProcesses);
        for (const name of profiles) {
            const profile = JSON.parse(readFileSync(join(directory, name), 'utf8'));
            assert.ok(profile.nodes.length > 0);
            assert.ok(profile.endTime >= profile.startTime);
            // A newly spawned child can stop before its first 10 ms sample on
            // fast hosts. Its inspector profile is valid, but not a CPU finding.
            if (!late || !name.includes(String(starts.find(row => row.workerId === '2')?.pid))) {
                assert.ok(profile.samples.length > 0);
            }
        }
        assert.ok(!records.some(row => row.kind === 'observer_error'));
        assert.equal(stderr, '');
        return {case: name, assertions: assertions - beforeAssertions,
            processes: expectedProcesses, profiles: profiles.length, requests, records: records.length};
    } finally {
        if (child.exitCode === null) {
            try { child.send({event: 'qualifier_shutdown'}); } catch {}
            await Promise.race([exit, sleep(10000)]);
            if (child.exitCode === null) child.kill('SIGKILL');
        }
        // On a failed smoke, only reap PIDs identified by a start record in this
        // fresh owned directory and linked to our exact spawned master PID.
        const owned = new Set([child.pid]);
        for (const name of readdirSync(directory).filter(name => /^worker-\d+\.jsonl$/.test(name))) {
            const first = readFileSync(join(directory, name), 'utf8').split('\n')[0];
            if (!first) continue;
            const start = JSON.parse(first);
            if (start.kind === 'start' && Number.isSafeInteger(start.pid) && start.pid > 0 &&
                name === `worker-${start.pid}.jsonl` &&
                ((start.pid === child.pid && start.parentPid === process.pid) || start.parentPid === child.pid)) {
                owned.add(start.pid);
            }
        }
        for (const pid of owned) {
            assert.notEqual(pid, process.pid);
            if (alive(pid)) {
                try { process.kill(pid, 'SIGKILL'); }
                catch (error) { if (error.code !== 'ESRCH') throw error; }
            }
        }
        const reapedBy = Date.now() + 2000;
        while ([...owned].some(alive) && Date.now() < reapedBy) await sleep(25);
        assert.ok(![...owned].some(alive), 'owned observer checker process did not exit');
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        // This is the exact fresh mkdtemp directory, beneath the resolved temp
        // root. Validate it again before recursive cleanup on any platform.
        const resolved = realpathSync(directory);
        assert.equal(dirname(resolved), temporaryRoot);
        assert.ok(basename(resolved).startsWith('hyperion-worker-observer-check-'));
        rmSync(resolved, {recursive: true, force: true});
    }
}
