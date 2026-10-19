/** Qualification-only preload. Observe production methods without changing their arguments or results. */
import cluster from 'node:cluster';
import { openSync, closeSync, writeSync, fsyncSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const directoryArgument = process.env.ES198_OBSERVER_DIR;
if (!directoryArgument || !isAbsolute(directoryArgument)) {
    throw new Error('ES198_OBSERVER_DIR must name an existing absolute qualification directory');
}
const directory = realpathSync(directoryArgument);
if (!statSync(directory).isDirectory()) throw new Error('ES198_OBSERVER_DIR must be a directory');
const logfile = join(directory, `worker-${process.pid}.jsonl`);
const descriptor = openSync(logfile, 'wx');
const maxLogBytes = 24 * 1024 * 1024;
const reservedFinalBytes = 64 * 1024;
const maxProfileBytes = 32 * 1024 * 1024;
let writtenBytes = 0;
let droppedRecords = 0;
let observerError;
let closed = false;
let sequence = 0;
const role = process.env.worker_role || (cluster.isPrimary ? 'master' : 'unknown');
const workerId = process.env.worker_id || null;
const started = process.hrtime.bigint();
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let previousCpu = process.cpuUsage();
let previousSampleAt = started;
let profileSession;
let profileTimer;
let profileState = process.env.ES198_CPU_PROFILE === '1' ? 'starting' : 'disabled';
let flushPromise;
let shutdownPromise;
// Hyperion reassigns Worker.id to its stable slot ID on respawn; key identity by the object.
const childIdentities = new WeakMap();
const ownedWorkers = new Set();
const childExitOutcomes = new WeakMap();
const watchedWorkers = new WeakSet();
let shutdownSignal;

function safeString(value, limit = 256) {
    return typeof value === 'string' ? value.slice(0, limit) : value;
}

function errorText(error) {
    return String(error?.stack || error).slice(0, 4096);
}

function record(kind, data = {}, final = false) {
    if (closed) return;
    try {
        const line = JSON.stringify({
            kind, sequence: ++sequence, at: Date.now(), isoAt: new Date().toISOString(),
            monotonicMs: Number(process.hrtime.bigint() - started) / 1e6,
            pid: process.pid, role, workerId, ...data
        }) + '\n';
        const bytes = Buffer.byteLength(line);
        if (writtenBytes + bytes > maxLogBytes - (final ? 0 : reservedFinalBytes)) {
            droppedRecords++;
            return;
        }
        writeSync(descriptor, line);
        writtenBytes += bytes;
    } catch (error) {
        observerError = errorText(error);
        try { process.stderr.write(`[ES198 observer] ${observerError}\n`); } catch {}
    }
}

function sample(reason = 'interval') {
    const now = process.hrtime.bigint();
    const cpu = process.cpuUsage();
    const elapsedMs = Number(now - previousSampleAt) / 1e6;
    record('sample', {
        reason, elapsedMs,
        cpuDeltaMicros: { user: cpu.user - previousCpu.user, system: cpu.system - previousCpu.system },
        cpuTotalMicros: cpu,
        memory: process.memoryUsage(),
        resourceUsage: process.resourceUsage(),
        eventLoopDelayMs: {
            min: Number.isFinite(loopDelay.min) && loopDelay.count > 0 ? loopDelay.min / 1e6 : null,
            max: Number.isFinite(loopDelay.max) && loopDelay.count > 0 ? loopDelay.max / 1e6 : null,
            mean: Number.isFinite(loopDelay.mean) ? loopDelay.mean / 1e6 : null,
            p50: loopDelay.count > 0 ? loopDelay.percentile(50) / 1e6 : null,
            p99: loopDelay.count > 0 ? loopDelay.percentile(99) / 1e6 : null,
            count: loopDelay.count
        }
    }, reason !== 'interval');
    previousCpu = cpu;
    previousSampleAt = now;
    loopDelay.reset();
}

record('start', {
    parentPid: process.ppid, clusterId: cluster.worker?.id ?? null,
    runtime: { version: process.version, versions: process.versions, platform: process.platform, arch: process.arch },
    cwd: process.cwd(), executable: process.execPath, execArgv: process.execArgv,
    argv: process.argv, observerPath: fileURLToPath(import.meta.url),
    repository: resolve(fileURLToPath(new URL('../..', import.meta.url))),
    configPath: process.env.CONFIG_JSON || null, chain: process.env.CHAIN_NAME || null,
    queue: process.env.queue || null, type: process.env.type || null,
    httpConnection: process.env.ES_HTTP_CONNECTION ?? 'automatic',
    limits: { sampleIntervalMs: 1000, eventLoopResolutionMs: 20, maxLogBytes, maxProfileBytes },
    qualificationOnly: true
});

const selectedEvents = new Set([
    'pause', 'resume', 'new_range', 'read_block', 'consumed_block', 'completed',
    'add_index', 'indexer_paused', 'indexer_pause_failed', 'indexer_resumed',
    'indexer-resume-failed', 'profiling_report', 'qualifier_flushed'
]);

function ipcSummary(message) {
    const summary = {};
    for (const key of ['event', 'id', 'target', 'mId', 'block_num', 'block_id', 'size', 'live',
        'worker_id', 'worker_role', 'complete', 'success', 'logfile', 'profilePath', 'error']) {
        const value = message[key];
        if (['string', 'boolean', 'number'].includes(typeof value)) summary[key] = safeString(value);
    }
    if (message.event === 'new_range' && message.data) {
        summary.range = { first_block: message.data.first_block, last_block: message.data.last_block };
    }
    if (message.event === 'profiling_report' && message.metrics && typeof message.metrics === 'object') {
        summary.metrics = Object.fromEntries(Object.entries(message.metrics).slice(0, 32).map(([name, metric]) => [
            name.slice(0, 80), { totalTimeMs: metric?.totalTimeMs, count: metric?.count }
        ]));
    }
    return summary;
}

function observeIpc(direction, message, peer = {}) {
    try {
        if (message && typeof message === 'object' && selectedEvents.has(message.event)) {
            const effectiveRole = peer.role || role;
            record(direction.endsWith('outgoing') ? 'ipc_send' : 'ipc_receive', {
                direction, observerRole: role, role: effectiveRole,
                workerId: peer.workerId || workerId,
                live: effectiveRole === 'continuous_reader',
                event: message.event, peer, message: ipcSummary(message)
            });
        }
    } catch (error) { record('observer_error', { operation: 'ipc_summary', error: errorText(error) }); }
}

// Keep the original IPC callback, send handle, options and return value intact.
if (typeof process.send === 'function') {
    const originalSend = process.send;
    process.send = function (...args) {
        observeIpc('process_outgoing', args[0]);
        return Reflect.apply(originalSend, this, args);
    };
}

function trackWorker(worker) {
    ownedWorkers.add(worker);
    if (watchedWorkers.has(worker)) return;
    watchedWorkers.add(worker);
    // Install immediately after fork, retaining outcomes even when the worker
    // is already absent from cluster.workers by the time shutdown starts.
    worker.once('exit', (code, signal) => {
        childExitOutcomes.set(worker, {code, signal: signal ?? null});
        record('worker_exit', {
            childClusterId: worker.id, childPid: worker.process?.pid, code, signal: signal ?? null
        }, true);
    });
    if (worker.isDead()) {
        childExitOutcomes.set(worker, {
            code: worker.process?.exitCode ?? null, signal: worker.process?.signalCode ?? null
        });
    }
}

if (cluster.isPrimary) {
    const originalFork = cluster.fork;
    cluster.fork = function (...args) {
        const worker = Reflect.apply(originalFork, this, args);
        childIdentities.set(worker, {
            role: args[0]?.worker_role || 'unknown', workerId: args[0]?.worker_id || null
        });
        trackWorker(worker);
        if (shutdownSignal) {
            record('shutdown_late_child', { childClusterId: worker.id, childPid: worker.process?.pid }, true);
        }
        return worker;
    };
    const originalSend = cluster.Worker.prototype.send;
    cluster.Worker.prototype.send = function (...args) {
        observeIpc('master_outgoing', args[0], {
            clusterId: this.id, pid: this.process?.pid, ...childIdentities.get(this)
        });
        return Reflect.apply(originalSend, this, args);
    };
    cluster.on('fork', worker => {
        trackWorker(worker);
        record('worker_fork', { childClusterId: worker.id, childPid: worker.process?.pid });
        worker.on('message', message => observeIpc('master_incoming', message, {
            clusterId: worker.id, pid: worker.process?.pid, ...childIdentities.get(worker)
        }));
        worker.on('disconnect', () => record('worker_disconnect', {
            childClusterId: worker.id, childPid: worker.process?.pid
        }));
    });

    // Importing the manager installs no connections: its constructor is run by production code.
    const { ConnectionManager } = await import('../../build/indexer/connections/manager.class.js');
    const originalCheck = ConnectionManager.prototype.checkQueueSize;
    ConnectionManager.prototype.checkQueueSize = async function (...args) {
        const begin = process.hrtime.bigint();
        try {
            const size = await Reflect.apply(originalCheck, this, args);
            record('queue_sample', {
                queue: safeString(args[0]), size,
                elapsedMs: Number(process.hrtime.bigint() - begin) / 1e6
            });
            return size;
        } catch (error) {
            record('queue_sample', {
                queue: safeString(args[0]), error: errorText(error),
                elapsedMs: Number(process.hrtime.bigint() - begin) / 1e6
            });
            throw error;
        }
    };
}

if (['reader', 'continuous_reader', 'repair_reader'].includes(role)) {
    const { default: StateReader } = await import('../../build/indexer/workers/state-reader.js');
    const originalRequest = StateReader.prototype.requestBlockRange;
    if (typeof originalRequest !== 'function') throw new Error('StateReader requestBlockRange observation seam unavailable');
    StateReader.prototype.requestBlockRange = function (...args) {
        record('ship_range_request', {
            first_block: args[0], last_block: args[1],
            live: role === 'continuous_reader',
            boundary: 'StateReader.requestBlockRange invocation; not a wire-send confirmation'
        });
        return Reflect.apply(originalRequest, this, args);
    };
    const originalFinish = StateReader.prototype.finishReader;
    if (typeof originalFinish === 'function') {
        StateReader.prototype.finishReader = async function (...args) {
            const result = await Reflect.apply(originalFinish, this, args);
            // Production IPC exits immediately after this promise resolves.
            // Keep profiling through its confirmed drain and channel cleanup.
            await flush('worker_finished');
            return result;
        };
    }
}

function inspectorPost(method, params = {}) {
    return new Promise((resolvePost, reject) => profileSession.post(method, params, (error, result) => {
        if (error) reject(error); else resolvePost(result);
    }));
}

if (profileState === 'starting') {
    try {
        if (process.versions.bun) throw new Error('Node inspector CPU profiling is unsupported by this observer on Bun');
        const { Session } = await import('node:inspector');
        profileSession = new Session();
        profileSession.connect();
        await inspectorPost('Profiler.enable');
        await inspectorPost('Profiler.setSamplingInterval', { interval: 10000 });
        await inspectorPost('Profiler.start');
        profileState = 'recording';
        const maxDuration = Number(process.env.ES198_PROFILE_MAX_MS ?? 300000);
        if (!Number.isSafeInteger(maxDuration) || maxDuration < 1000 || maxDuration > 900000) {
            throw new Error('ES198_PROFILE_MAX_MS must be 1000 through 900000');
        }
        record('profile_started', { samplingIntervalMicros: 10000, maximumDurationMs: maxDuration });
        profileTimer = setTimeout(() => { void flush('profile_time_limit'); }, maxDuration);
        profileTimer.unref();
    } catch (error) {
        profileState = 'failed';
        observerError = errorText(error);
        try { profileSession?.disconnect(); } catch {}
        profileSession = undefined;
        record('observer_error', { operation: 'profile_start', error: observerError });
    }
}

const interval = setInterval(() => sample(), 1000);
interval.unref();

async function flush(reason, requestId) {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
        clearTimeout(profileTimer);
        clearInterval(interval);
        sample('flush');
        loopDelay.disable();
        let profilePath = null;
        if (profileState === 'recording' && profileSession) {
            try {
                const { profile } = await inspectorPost('Profiler.stop');
                const serialized = JSON.stringify(profile);
                const bytes = Buffer.byteLength(serialized);
                if (bytes > maxProfileBytes) throw new Error(`CPU profile exceeds ${maxProfileBytes} byte bound`);
                profilePath = join(directory, `worker-${process.pid}.cpuprofile`);
                const profileDescriptor = openSync(profilePath, 'wx');
                try {
                    writeFileSync(profileDescriptor, serialized);
                    fsyncSync(profileDescriptor);
                } finally { closeSync(profileDescriptor); }
                profileState = 'saved';
                record('profile_saved', { profilePath, bytes }, true);
            } catch (error) {
                profileState = 'failed';
                observerError = errorText(error);
                record('observer_error', { operation: 'profile_stop', error: observerError }, true);
            } finally {
                try { profileSession.disconnect(); } catch {}
                profileSession = undefined;
            }
        }
        const result = {
            event: 'qualifier_flushed', reason, requestId: requestId ?? null,
            logfile, profilePath, profileState, droppedRecords,
            success: !observerError && droppedRecords === 0,
            error: observerError ?? null
        };
        record('flush', result, true);
        try { fsyncSync(descriptor); } catch (error) {
            result.success = false;
            result.error = errorText(error);
        }
        if (typeof process.send === 'function' && process.connected) {
            try { process.send(result); } catch (error) {
                record('observer_error', { operation: 'flush_ipc', error: errorText(error) }, true);
            }
        }
        return result;
    })();
    return flushPromise;
}

process.on('message', message => {
    observeIpc('process_incoming', message);
    if (!message || !['qualifier_flush', 'qualifier_shutdown'].includes(message.event)) return;
    if (message.event === 'qualifier_shutdown') {
        void shutdown(message);
        return;
    }
    if (cluster.isPrimary) {
        for (const worker of Object.values(cluster.workers || {})) {
            if (worker?.isConnected()) {
                try { worker.send(message); } catch (error) {
                    record('observer_error', { operation: 'flush_propagate', error: errorText(error) }, true);
                }
            }
        }
    }
    void flush('qualifier_flush', message.requestId);
});

async function shutdown(message) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
        shutdownSignal = message;
        const children = new Set();
        const exited = new Set();
        const sent = new Set();
        const discoverChildren = () => {
            if (!cluster.isPrimary) return;
            for (const worker of Object.values(cluster.workers || {}).filter(Boolean)) trackWorker(worker);
            for (const worker of ownedWorkers) {
                children.add(worker);
                if (childExitOutcomes.has(worker)) exited.add(worker);
                else if (!sent.has(worker) && worker.isConnected()) {
                    try { worker.send(message); sent.add(worker); } catch (error) {
                        record('observer_error', { operation: 'shutdown_propagate', error: errorText(error) }, true);
                    }
                }
            }
        };
        discoverChildren();
        const result = await flush('qualifier_shutdown', message.requestId);
        const deadline = Date.now() + 5000;
        while (true) {
            discoverChildren();
            if (exited.size === children.size || Date.now() >= deadline) break;
            await new Promise(resolveWait => setTimeout(resolveWait, 25));
        }
        const forced = new Set();
        const forceRemaining = () => {
            discoverChildren();
            for (const worker of children) {
                if (exited.has(worker) || forced.has(worker)) continue;
                forced.add(worker);
                record('shutdown_force_child', { childClusterId: worker.id, childPid: worker.process?.pid }, true);
                try { worker.kill('SIGKILL'); } catch (error) {
                    record('observer_error', { operation: 'shutdown_kill', error: errorText(error) }, true);
                }
            }
        };
        forceRemaining();
        const killDeadline = Date.now() + 2000;
        while (exited.size < children.size && Date.now() < killDeadline) {
            await new Promise(resolveWait => setTimeout(resolveWait, 25));
            forceRemaining();
        }
        discoverChildren();
        const childExits = [...children].map(worker => ({
            clusterId: worker.id, pid: worker.process?.pid,
            code: childExitOutcomes.get(worker)?.code ?? null,
            signal: childExitOutcomes.get(worker)?.signal ?? null
        }));
        const failedChildren = childExits.filter(outcome => outcome.code !== 0 || outcome.signal !== null);
        const success = result.success && exited.size === children.size && forced.size === 0 &&
            failedChildren.length === 0;
        record('shutdown', {
            success, requestId: message.requestId ?? null,
            children: children.size, exited: exited.size,
            childExits, failedChildren,
            forced: [...forced].map(worker => ({ clusterId: worker.id, pid: worker.process?.pid })),
            unresolved: [...children].filter(worker => !exited.has(worker)).map(worker => ({
                clusterId: worker.id, pid: worker.process?.pid
            }))
        }, true);
        try { fsyncSync(descriptor); } catch {}
        process.exit(success ? 0 : 1);
    })();
    return shutdownPromise;
}

// This records unflushed shutdown explicitly. Saving a profile is only claimed by flush above.
process.on('exit', code => {
    if (closed) return;
    sample('exit');
    record('exit', { code, profileState, flushed: Boolean(flushPromise), droppedRecords }, true);
    try { fsyncSync(descriptor); } catch {}
    try { closeSync(descriptor); } catch {}
    closed = true;
});
