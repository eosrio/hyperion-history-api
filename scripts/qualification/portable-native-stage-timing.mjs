/** Private qualification observations of fixed original methods. Never completion authority. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {isPromise} from 'node:util/types';
import {LatencyHistogram} from './portable-state-worker-proof-metrics.mjs';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {ProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';
import {ProtocolNativeActionReader} from '../../build/indexer/protocol/native-authorization.js';
import {ProtocolNativeObservationStore} from '../../build/indexer/protocol/native-observation-store.js';
import {ProtocolAbiProofReader} from '../../build/indexer/protocol/abi-proof.js';
import {ActionSourceAdmissionStore} from '../../build/indexer/history/action-source-admission.js';
import DSPool from '../../build/indexer/workers/ds-pool.js';

export const nativeStageTimingBounds = Object.freeze({maximumStarts: 250000, maximumActive: 128,
    maximumTail: 64, maximumRowBytes: 2048, maximumSnapshotBytes: 512 * 1024});
let installed = false;
const data = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const label = value => typeof value === 'string' && value.length <= 256 ? value
    : typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
const fields = (value, names) => Object.fromEntries(names.map(key => [key, label(data(value, key))]));
const nextCount = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
const increment = (value, key) => {value[key] = nextCount(value[key]);};

/** Off unless explicitly installed by the guarded native qualification preload or component tests.
 * Fixed stage inventory and bounded records. See the finite return/identity audit in the qualification doc.
 */
export function installNativeWorkerStageTimings({enabled = false, maximumStarts = nativeStageTimingBounds.maximumStarts,
    maximumActive = nativeStageTimingBounds.maximumActive, maximumTail = nativeStageTimingBounds.maximumTail} = {}) {
    if (typeof enabled !== 'boolean') throw new Error('Invalid native stage diagnostic activation');
    if (!enabled) return {snapshot: () => ({enabled: false, observationOnly: true}), restore() {}};
    for (const [key, value] of Object.entries({maximumStarts, maximumActive, maximumTail}))
        if (!Number.isSafeInteger(value) || value < 1 || value > nativeStageTimingBounds[key]) throw new Error('Invalid native stage diagnostic bound');
    if (installed) throw new Error('Native stage timings already installed');
    installed = true;
    const context = new AsyncLocalStorage(), active = new Map(), tail = [], stages = {}, restores = [];
    let starts = 0, omittedStarts = 0, reportFailures = 0, unavailableIdentities = 0;
    const observe = work => {try {return work();} catch {reportFailures = nextCount(reportFailures);}};
    const attempt = (client, handle) => {
        const local = client.attempts.get(handle);
        return local ? {client, handle, scope: local.scope} : undefined;
    };
    const origin = frame => {
        const description = frame.attempt?.client.describe(frame.attempt.handle);
        return {attemptId: label(description?.attemptId), mode: label(description?.mode), attemptRole: label(frame.attempt?.client.role),
            descriptor: fields(description?.descriptor, ['kind', 'receiptId', 'payloadSha256', 'headersSha256', 'consumerId', 'publisherId', 'queue', 'deliveryTag']),
            binding: fields(description?.binding, ['blockNum', 'blockId', 'selectionId', 'admissionId', 'traceOrdinal', 'projectionId']),
            input: structuredClone(frame.input)};
    };
    const row = (frame, extra) => {
        const value = {spanId: frame.id, parentSpanId: frame.parent?.id ?? null, stage: frame.stage,
            startedNs: String(frame.start), ...origin(frame), ...extra};
        if (Buffer.byteLength(JSON.stringify(value)) <= nativeStageTimingBounds.maximumRowBytes) return value;
        unavailableIdentities = nextCount(unavailableIdentities);
        return {spanId: frame.id, parentSpanId: frame.parent?.id ?? null, stage: frame.stage,
            startedNs: String(frame.start), identityUnavailable: true, ...extra};
    };
    const begin = (stage, ownAttempt, input) => {
        const metric = stages[stage];
        if (starts >= maximumStarts || active.size >= maximumActive) {
            increment(metric, 'omittedStarts'); omittedStarts = nextCount(omittedStarts); return;
        }
        const parent = context.getStore(), frame = {id: ++starts, stage, parent, start: process.hrtime.bigint(),
            attempt: ownAttempt ?? parent?.attempt, input: input ?? null, settlement: 'pending'};
        increment(metric, 'started'); increment(metric, 'active'); active.set(frame.id, frame); return frame;
    };
    const finish = (frame, error, rejected) => observe(() => {
        const metric = stages[frame.stage], signal = frame.attempt?.scope.signal;
        const cancelled = rejected && !!frame.attempt?.scope.ownsFenceError(error);
        const outcome = rejected ? cancelled ? 'cancelled' : 'failed' : 'completed';
        const elapsed = process.hrtime.bigint() - frame.start;
        frame.settlement = 'settled'; active.delete(frame.id); metric.active--; increment(metric, outcome);
        metric.wall.add(elapsed); metric[outcome + 'Wall'].add(elapsed);
        const late = frame.parent?.settlement === 'unobservable' ? null : frame.parent?.settlement === 'settled';
        if (late) increment(metric, 'settledAfterParent');
        const record = row(frame, {elapsedNs: String(elapsed), outcome, settledAfterParent: late,
            scopeAborted: signal?.aborted ?? null,
            ...(rejected ? {error: fields(error, ['name', 'code'])} : {})});
        tail.push(record); if (tail.length > maximumTail) tail.shift();
    });
    const unobservable = frame => observe(() => {
        const metric = stages[frame.stage];
        frame.settlement = 'unobservable'; active.delete(frame.id); metric.active--; increment(metric, 'unobservable');
        tail.push(row(frame, {outcome: 'unobservable', elapsedNs: null, settledAfterParent: null,
            reason: 'generic-result-promise-not-observed'}));
        if (tail.length > maximumTail) tail.shift();
    });
    const follow = (frame, result, policy) => {
        if (!isPromise(result)) {finish(frame, undefined, false); return result;}
        if (policy === 'unobservable') {unobservable(frame); return result;}
        if (policy === 'already-handled') {
            // Only accepted and Scope.run: their ORIGINAL bodies already attach catch before returning.
            // Keep the shared original promise. This detached reaction must never rethrow.
            observe(() => Promise.prototype.then.call(result,
                () => {finish(frame, undefined, false);}, error => {finish(frame, error, true);}));
            return result;
        }
        // Audited void/boolean/owned plain-record returns only. The caller receives this reaction;
        // ignoring it still exposes the exact original rejection, while handling it creates no orphan.
        const followed = observe(() => Promise.prototype.then.call(result,
            value => {finish(frame, undefined, false); return value;}, error => {finish(frame, error, true); throw error;}));
        if (followed) return followed;
        unobservable(frame); // A diagnostic failure never substitutes the original method result.
        return result;
    };
    const metric = name => stages[name] ??= {started: 0, completed: 0, failed: 0, cancelled: 0, active: 0,
        omittedStarts: 0, unobservable: 0, settledAfterParent: 0, wall: new LatencyHistogram(), completedWall: new LatencyHistogram(),
        failedWall: new LatencyHistogram(), cancelledWall: new LatencyHistogram()};
    const patch = (prototype, name, stage, details, policy) => {
        const original = prototype[name];
        if (typeof original !== 'function') throw new Error('Original native stage method unavailable: ' + name);
        metric(stage);
        prototype[name] = function(...args) {
            const detail = observe(() => details?.call(this, args)), frame = observe(() => begin(stage, detail?.attempt, detail?.input));
            if (!frame) return original.apply(this, args);
            try {return follow(frame, context.run(frame, () => original.apply(this, args)), policy);}
            catch (error) {finish(frame, error, true); throw error;}
        };
        restores.push(() => {prototype[name] = original;});
    };
    // Registration begins at physical capture, before a cargo root can run. Observe its real accepted promise.
    const capture = WorkerAttemptClient.prototype.capture;
    metric('attempt.admission');
    WorkerAttemptClient.prototype.capture = function(...args) {
        const frame = observe(() => begin('attempt.admission'));
        try {
            const handle = capture.apply(this, args);
            if (frame) observe(() => {frame.attempt = attempt(this, handle); follow(frame, this.attempts.get(handle).accepted, 'already-handled');});
            return handle;
        } catch (error) {if (frame) finish(frame, error, true); throw error;}
    };
    restores.push(() => {WorkerAttemptClient.prototype.capture = capture;});
    patch(WorkerAttemptClient.prototype, 'run', 'attempt.run', function(args) {return {attempt: attempt(this, args[0])};}, 'unobservable');
    patch(ProofConsumerScope.prototype, 'run', 'attempt.root', undefined, 'already-handled');
    patch(WorkerAttemptClient.prototype, 'boundedDrain', 'attempt.drain');
    patch(WorkerAttemptClient.prototype, 'bind', 'attempt.bind');
    patch(WorkerAttemptClient.prototype, 'observeFreshActionWrite', 'attempt.fresh-write-observation');
    // The other requests remain inside their existing admission/binding/operation stages.
    const request = WorkerAttemptClient.prototype.request;
    metric('attempt.end');
    WorkerAttemptClient.prototype.request = function(...args) {
        if (data(args[0], 'operation') !== 'end') return request.apply(this, args);
        const frame = observe(() => begin('attempt.end'));
        if (!frame) return request.apply(this, args);
        try {return follow(frame, context.run(frame, () => request.apply(this, args)));}
        catch (error) {finish(frame, error, true); throw error;}
    };
    restores.push(() => {WorkerAttemptClient.prototype.request = request;});
    const source = args => ({input: {source: fields(args[0], ['chainId', 'blockNum', 'blockId']), selectionId: label(args[1])}});
    patch(ProtocolNativeActionReader.prototype, 'openSelected', 'native.paired-or-standalone-open', args => ({
        input: {...source(args).input, paired: typeof args[4] === 'function'}}));
    patch(ProtocolAbiProofReader.prototype, 'open', 'canonical.open', source);
    patch(ProtocolAbiProofReader.prototype, 'revalidateOpening', 'canonical.opening-recheck');
    patch(ProtocolNativeObservationStore.prototype, 'readSelection', 'native.retained-inventory', args => ({input: {selectionId: label(args[0])}}));
    patch(ProtocolNativeActionReader.prototype, 'revalidateIssued', 'native.issued-revalidation');
    for (const [name, stage] of [['beginActionAdmission', 'action.admission'], ['processTraces', 'action.trace-including-publication'],
        ['revalidateProtocolDeliveryNativeOutputs', 'action.native-revalidation'], ['assertActionHandoffCurrent', 'action.handoff-current'],
        ['assertActionAttemptCurrent', 'action.attempt-current'], ['flushRedisBatch', 'action.redis-flush']]) patch(DSPool.prototype, name, stage);
    for (const [name, stage] of [['trySeal', 'action.seal'], ['recordConfirmedHandoff', 'action.confirmed-handoff-persistence'],
        ['prepareContractAttemptDisposition', 'action.contract-disposition-preparation'],
        ['prepareRawIncompleteAttemptDisposition', 'action.raw-disposition-preparation'],
        ['recordAttemptDisposition', 'action.disposition-persistence']]) patch(ActionSourceAdmissionStore.prototype, name, stage);
    return {snapshot() {
        const now = process.hrtime.bigint(), value = {enabled: true, observationOnly: true,
            semantics: 'Nested awaited wall times overlap; labels and outcomes confer no source or completion authority.',
            bounds: {...nativeStageTimingBounds, maximumStarts, maximumActive, maximumTail},
            starts, omittedStarts, reportFailures, unavailableIdentities,
            runtime: {pid: process.pid, parentPid: process.ppid, node: process.version, executable: process.execPath,
                role: process.env.worker_role ?? 'master', cpuMicros: process.cpuUsage(), memoryBytes: process.memoryUsage()},
            stages: Object.fromEntries(Object.entries(stages).map(([name, m]) => [name, {...m,
                wall: m.wall.snapshot(), completedWall: m.completedWall.snapshot(), failedWall: m.failedWall.snapshot(), cancelledWall: m.cancelledWall.snapshot()}])),
            active: [...active.values()].map(frame => row(frame, {outcome: 'active', elapsedNs: String(now - frame.start),
                scopeAborted: frame.attempt?.scope.signal.aborted ?? null})), tail: structuredClone(tail)};
        if (Buffer.byteLength(JSON.stringify(value)) > nativeStageTimingBounds.maximumSnapshotBytes) throw new Error('Native stage snapshot byte bound exceeded');
        return value;
    }, restore() {for (const restore of restores.reverse()) restore(); installed = false;}};
}
