/** Opt-in fixture observations; never source, checkpoint, test or cleanup authority. */
import {performance} from 'node:perf_hooks';
import {isPromise} from 'node:util/types';
import {LatencyHistogram} from '../../scripts/qualification/portable-state-worker-proof-metrics.mjs';

export const retainedWireStageBounds = Object.freeze({intervalMs: 1000, snapshots: 300,
    rowBytes: 32768, starts: 500000, active: 64, wrappers: 256, wrapperStarts: 50000});
export const retainedWireStageNames = Object.freeze(['fixture.before-source', 'fixture.source-setup', 'fixture.host-setup',
    'source.advance', 'source.frame', 'source.selection', 'source.observation', 'source.link', 'source.admission', 'source.publication',
    'projection.source-frame', 'projection.drain', 'projection.worker-frame', 'projection.recovery', 'projection.raw-admission',
    'projection.apply', 'projection.retire', 'projection.reduce', 'native.factory', 'native.command', 'native.find-one', 'native.write', 'native.cursor', 'native.transaction',
    'native.session-close', 'cleanup.host']);
const data = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
export const sourceBlock = args => data(data(args[0], 'source'), 'blockNum');
const block = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Dependencies are injectable so controls exercise no workload, process or service. */
export function createRetainedWireStageObserver({enabled = false, now = () => process.hrtime.bigint(),
    resources, emit = row => console.log(JSON.stringify(row)), schedule = setInterval, unschedule = clearInterval,
    lifecycle = process} = {}) {
    if (typeof enabled !== 'boolean') throw new Error('Invalid retained Wire observation activation');
    if (!enabled) return {enabled: false, begin: () => () => {}, watch: object => object, unwatch() {}, report() {}, close() {}};
    const started = now(), metrics = Object.fromEntries(retainedWireStageNames.map(name => [name,
        {started: 0, completed: 0, failed: 0, active: 0, lastBlock: null, wall: new LatencyHistogram()}]));
    const active = new Map(), restores = new Set(), watched = new WeakMap();
    let starts = 0, wrapperStarts = 0, omitted = 0, failures = 0, sequence = 0, closed = false, lastTick = started;
    let cpu = process.cpuUsage(), utilization = performance.eventLoopUtilization();
    const readResources = resources ?? (() => {
        const nextCPU = process.cpuUsage(), nextUtilization = performance.eventLoopUtilization();
        const value = {cpuMicros: nextCPU, intervalCpuMicros: {user: nextCPU.user - cpu.user, system: nextCPU.system - cpu.system},
            memoryBytes: process.memoryUsage(), eventLoop: performance.eventLoopUtilization(nextUtilization, utilization)};
        cpu = nextCPU; utilization = nextUtilization; return value;
    });
    const safe = operation => {try {return operation();} catch {failures++;}};
    const begin = (name, number) => safe(() => {
        if (closed) return () => {};
        const metric = metrics[name];
        if (!metric) {failures++; return () => {};}
        if (starts === retainedWireStageBounds.starts || active.size === retainedWireStageBounds.active) {omitted++; return () => {};}
        const frame = {id: ++starts, stage: name, block: block(number), start: now()};
        metric.started++; metric.active++; active.set(frame.id, frame);
        let finished = false;
        return (outcome = 'completed') => safe(() => {
            if (finished || closed) return; finished = true;
            const elapsed = now() - frame.start;
            active.delete(frame.id); metric.active--; metric[outcome === 'failed' ? 'failed' : 'completed']++;
            metric.lastBlock = frame.block; metric.wall.add(elapsed);
        });
    }) ?? (() => {});
    // Audited async fixture/adapter methods return void, booleans or owned plain records.
    // Resolved values/errors, receiver and exact original/shared promise are retained.
    // Reactions settle to undefined; these audited fixture callers await their results.
    const watch = (object, methods) => {
        if (closed) return object;
        let names = watched.get(object); if (!names) watched.set(object, names = new Map());
        for (const [name, stage, inputBlock, onValue] of methods) safe(() => {
            if (names.has(name)) return;
            if (restores.size === retainedWireStageBounds.wrappers || wrapperStarts === retainedWireStageBounds.wrapperStarts) {omitted++; return;}
            let holder = object, descriptor;
            while (holder && !(descriptor = Object.getOwnPropertyDescriptor(holder, name))) holder = Object.getPrototypeOf(holder);
            if (!descriptor || typeof descriptor.value !== 'function' || !metrics[stage]) throw new Error('Missing audited observation seam');
            const own = Object.getOwnPropertyDescriptor(object, name), original = descriptor.value;
            const replacement = function(...args) {
                const finish = begin(stage, safe(() => inputBlock?.(args)));
                const returned = value => {safe(() => onValue?.(value)); finish(); return value;};
                try {
                    const result = Reflect.apply(original, this, args);
                    if (!isPromise(result)) return returned(result);
                    const reaction = safe(() => Promise.prototype.then.call(result,
                        value => {returned(value);}, () => {finish('failed');}));
                    if (reaction) safe(() => Promise.prototype.then.call(reaction, undefined, () => {failures++;}));
                    return result;
                } catch (error) {finish('failed'); throw error;}
            };
            Object.defineProperty(object, name, {value: replacement, writable: true, configurable: true, enumerable: own?.enumerable ?? false});
            const restore = () => {
                if (Object.getOwnPropertyDescriptor(object, name)?.value !== replacement) throw new Error('Observation seam changed before restore');
                if (own) Object.defineProperty(object, name, own); else delete object[name];
                names.delete(name); restores.delete(restore); if (!names.size) watched.delete(object);
            };
            names.set(name, restore); restores.add(restore); wrapperStarts++;
        });
        return object;
    };
    const unwatch = object => {for (const restore of [...(watched.get(object)?.values() ?? [])]) safe(restore);};
    let timer;
    const detach = () => {
        if (timer !== undefined) unschedule(timer);
        lifecycle?.removeListener('beforeExit', beforeExit);
        for (const restore of [...restores].reverse()) safe(restore);
    };
    const report = (boundary = 'interval') => {
        if (closed) return;
        if (!['interval', 'explicit-close', 'process-before-exit'].includes(boundary)) {failures++; return;}
        const at = now(), limit = sequence === retainedWireStageBounds.snapshots - 1;
        const final = boundary !== 'interval' || limit;
        if (final) {closed = true; detach();}
        const row = {kind: 'retained-wire-stage-snapshot/v1', observationOnly: true, sequence: ++sequence,
            boundary: limit ? 'snapshot-bound-censored' : boundary, final, monotonicNs: String(at), elapsedNs: String(at - started),
            intervalDriftNs: boundary === 'interval' && sequence > 1 ? String(at - lastTick - BigInt(retainedWireStageBounds.intervalMs) * 1000000n) : null,
            runtime: {pid: process.pid, parentPid: process.ppid, node: process.version, executable: process.execPath,
                entry: process.argv[1] ?? null, sourceProfile: process.env.HYPERION_NATIVE_SOURCE_PROFILE ?? null},
            resources: safe(readResources) ?? null, starts, wrapperStarts, liveWrappers: restores.size, omitted, observationFailures: failures,
            bounds: retainedWireStageBounds, stages: Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name,
                {...metric, wall: metric.wall.snapshot()}])), active: [...active.values()].map(frame => ({id: frame.id,
                stage: frame.stage, block: frame.block, elapsedNs: String(at - frame.start)})),
            semantics: 'Nested awaited wall spans overlap; process CPU/ELU are interval context, not exclusive stage CPU. No verdict or authority.',
            notExercised: ['DSPool action publication/admission', 'physical database/IPC/services']};
        lastTick = at;
        safe(() => {if (Buffer.byteLength(JSON.stringify(row)) > retainedWireStageBounds.rowBytes) throw new Error('Observation row bound'); emit(row);});
    };
    const beforeExit = () => report('process-before-exit');
    lifecycle?.once('beforeExit', beforeExit);
    timer = schedule(() => safe(() => report()), retainedWireStageBounds.intervalMs); timer?.unref?.();
    report('interval');
    return {enabled: true, begin, watch, unwatch, report, close: () => report('explicit-close')};
}

const activation = process.env.HYPERION_RETAINED_WIRE_STAGES;
if (activation !== undefined && activation !== '1') throw new Error('HYPERION_RETAINED_WIRE_STAGES requires explicit 1');
export const retainedWireStages = createRetainedWireStageObserver({enabled: activation === '1'});
let beforeSource = retainedWireStages.begin('fixture.before-source');
export const beginRetainedWireSource = () => {beforeSource(); beforeSource = () => {}; return retainedWireStages.begin('fixture.source-setup');};

/** Observe the controlled command methods already used by the unchanged native adapter. */
export function observeRetainedWireNativeFixture(client, observer = retainedWireStages) {
    const cursor = value => observer.watch(value, [['toArray', 'native.cursor'], ['close', 'native.cursor', undefined, () => observer.unwatch(value)]]);
    const collection = value => observer.watch(value, [
        ['findOne', 'native.find-one'], ['countDocuments', 'native.command'], ['options', 'native.command'],
        ...['insertOne', 'updateOne', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany'].map(name => [name, 'native.write']),
        ['find', 'native.factory', undefined, cursor]]);
    const db = value => observer.watch(value, [['createCollection', 'native.command'],
        ['admin', 'native.factory', undefined, admin => observer.watch(admin, [['command', 'native.command']])],
        ['collection', 'native.factory', undefined, collection]]);
    const session = value => observer.watch(value, [['withTransaction', 'native.transaction'],
        ['endSession', 'native.session-close', undefined, () => observer.unwatch(value)]]);
    return observer.watch(client, [['db', 'native.factory', undefined, db], ['startSession', 'native.factory', undefined, session]]);
}
