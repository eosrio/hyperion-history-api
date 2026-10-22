/** Opt-in qualification observation. Application arguments, results and native callbacks are forwarded unchanged. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {openSync, writeSync, fsyncSync, closeSync, readFileSync, lstatSync, realpathSync} from 'node:fs';
import {isAbsolute, resolve, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isPromise, isProxy} from 'node:util/types';
import {projectionMeasurementPhases} from './projection-validation-phase.mjs';

const OPERATIONS = ['initialize', 'open', 'recovery', 'retainedCheckpoints', 'markIncomplete', 'apply', 'rollback', 'query'];
const nativeThen = Promise.prototype.then;
export const projectionObserverLimits = Object.freeze({maxSpans: 50000, maxCounters: 512, maxErrors: 32,
    maxAttachments: 4, maxReportBytes: 24 * 1024 * 1024, sealTimeoutMS: 5000});

function method(object, name) {
    for (let selected = object, depth = 0; selected && depth < 12; selected = Object.getPrototypeOf(selected), depth++) {
        const descriptor = Object.getOwnPropertyDescriptor(selected, name);
        if (descriptor) return typeof descriptor.value === 'function' ? descriptor.value : undefined;
    }
}
const own = (object, name) => object && Object.getOwnPropertyDescriptor(object, name)?.value;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function validatedUndoCount(value) {
    if (!value || typeof value !== 'object' || isProxy(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'undo');
    const undo = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    if (!Array.isArray(undo) || isProxy(undo)) return null;
    const count = Object.getOwnPropertyDescriptor(undo, 'length')?.value;
    return Number.isSafeInteger(count) && count >= 0 && count <= 4096 ? count : null;
}

/** Service-free collector interface used by the actual preload and differential controls. */
export function createProjectionValidationObserver(options) {
    const identity = options.identity;
    if (!identity || !['projection', 'api'].includes(identity.role) || !Number.isSafeInteger(identity.pid) || identity.pid < 1
        || !Number.isSafeInteger(identity.parentPid) || identity.parentPid < 1 || !/^v(?:22|24)\./.test(identity.node))
        throw new Error('Qualification observer requires an owned native Node22/24 identity');
    const limits = {...projectionObserverLimits, ...options.limits};
    for (const key of Object.keys(limits)) if (!Object.hasOwn(projectionObserverLimits, key) || !Number.isSafeInteger(limits[key]) || limits[key] < 1
        || limits[key] > projectionObserverLimits[key]) throw new Error('Observer limits cannot be raised');
    const clock = options.clock ?? (() => process.hrtime.bigint()), wallBefore = Date.now(), began = clock(), wallAfter = Date.now(), context = new AsyncLocalStorage();
    const at = () => clock() - began;
    const spans = [], active = new Map(), counters = new Map(), attachments = [], attached = new WeakMap();
    const errors = [], errorCodes = new Set(), phases = [], requests = new Map(), restores = [];
    const clients = new WeakSet(), collections = new WeakSet(), sessions = new WeakSet(), attempted = new WeakSet();
    let sequence = 0, currentPhase = 'startup', sealing = false, sealed = false, sealTimedOut = false;
    let droppedSpans = 0, suppressedRootSpans = 0;
    const fail = (code, message) => {
        if (!errorCodes.has(code)) {errorCodes.add(code); if (errors.length < limits.maxErrors) errors.push({code, message});}
    };
    const safe = action => {try {return action();} catch {fail('observer-internal', 'Observation bookkeeping failed');}};
    const patch = (object, name, value) => {
        const before = Object.getOwnPropertyDescriptor(object, name);
        Object.defineProperty(object, name, before ? {...before, value} : {value, configurable: true, writable: true});
        restores.push(() => before ? Object.defineProperty(object, name, before) : Reflect.deleteProperty(object, name));
    };
    function observe(kind, name, original, receiver, args, attachmentId) {
        const preceding = context.getStore();
        if (preceding?.suppressed) return Reflect.apply(original, receiver, args);
        const parent = preceding && (active.has(preceding.id) || active.has(preceding.rootId)) ? preceding : undefined;
        if (sealing && !parent) {
            suppressedRootSpans++;
            return context.run({suppressed: true}, () => Reflect.apply(original, receiver, args));
        }
        if (spans.length + active.size >= limits.maxSpans) {
            droppedSpans++; fail('span-budget', 'Raw span budget exceeded');
            return context.run({suppressed: true}, () => Reflect.apply(original, receiver, args));
        }
        const id = ++sequence, operation = kind === 'operation' ? name : parent?.operation ?? null;
        const entry = {id, parentId: parent?.id ?? null, rootId: parent?.rootId ?? id, kind, name, operation,
            operationId: kind === 'operation' ? id : parent?.operationId ?? null, attachmentId,
            startPhase: currentPhase, startNs: at().toString(),
            ...(['load', 'validation'].includes(kind) ? {undoDescriptorCount: null} : {})};
        const key = JSON.stringify([kind, name, operation, currentPhase]);
        let counter = counters.get(key);
        if (!counter) {
            if (counters.size >= limits.maxCounters) {
                droppedSpans++; fail('counter-budget', 'Counter budget exceeded');
                return context.run({suppressed: true}, () => Reflect.apply(original, receiver, args));
            }
            counter = {kind, name, operation, phase: currentPhase, started: 0, settled: 0, failed: 0,
                totalDurationNs: 0n, minimumDurationNs: null, maximumDurationNs: 0n,
                ...(['load', 'validation'].includes(kind) ? {undoDescriptorVisits: 0, undoCardinalityAvailable: 0, undoCardinalityUnavailable: 0} : {})}; counters.set(key, counter);
        }
        counter.started++; active.set(id, entry);
        const finish = (outcome, value) => safe(() => {
            if (!active.delete(id)) return;
            const end = at(), duration = end - BigInt(entry.startNs);
            if (duration < 0n) {fail('clock-regression', 'Observer monotonic clock regressed'); return;}
            counter.settled++; if (outcome === 'rejected' || outcome === 'threw') counter.failed++;
            counter.totalDurationNs += duration;
            counter.minimumDurationNs = counter.minimumDurationNs === null || duration < counter.minimumDurationNs ? duration : counter.minimumDurationNs;
            if (duration > counter.maximumDurationNs) counter.maximumDurationNs = duration;
            if (kind === 'load' || kind === 'validation') {
                entry.undoDescriptorCount = outcome === 'returned' || outcome === 'fulfilled' ? validatedUndoCount(value) : null;
                if (entry.undoDescriptorCount === null) counter.undoCardinalityUnavailable++;
                else {counter.undoCardinalityAvailable++; counter.undoDescriptorVisits += entry.undoDescriptorCount;}
            }
            spans.push({...entry, endPhase: currentPhase, endNs: end.toString(), durationNs: duration.toString(), outcome});
        });
        let result;
        try {result = context.run(entry, () => Reflect.apply(original, receiver, args));}
        catch (error) {finish('threw'); throw error;}
        if (isPromise(result)) {
            // Observe settlement, returning the exact original Promise. Neither handler throws or creates an unhandled rejection.
            nativeThen.call(result, value => {finish('fulfilled', value);}, () => {finish('rejected');});
        } else finish('returned', result);
        return result;
    }
    const wrap = (object, name, kind, attachmentId, after) => {
        const original = method(object, name);
        if (!original) throw new Error('Expected ordinary qualification method: ' + name);
        patch(object, name, function (...args) {
            const result = observe(kind, name, original, this, args, attachmentId);
            if (after) safe(() => after(result));
            return result;
        });
    };
    function attachAdapter(adapter, mode) {
        if (attached.has(adapter)) return true;
        if (!adapter || typeof adapter !== 'object' || attempted.has(adapter)) return false;
        attempted.add(adapter);
        const checkpoint = restores.length;
        try {
            if (!['owner', 'api-discovery'].includes(mode) || attachments.length >= limits.maxAttachments)
                throw new Error('Invalid attachment');
            const metadata = own(adapter, 'metadata'), client = own(adapter, 'client');
            if (!metadata || !client || typeof own(adapter, 'validate') !== 'function'
                || !method(adapter, 'transaction') || OPERATIONS.some(name => !method(adapter, name))) throw new Error('Unexpected adapter shape');
            const attachmentId = attachments.length + 1;
            // The ordinary parameter property retains the exact captured lexical validator/policy.
            wrap(adapter, 'validate', 'validation', attachmentId);
            wrap(adapter, 'transaction', 'transaction', attachmentId);
            for (const name of OPERATIONS) wrap(adapter, name, 'operation', attachmentId);
            if (!collections.has(metadata)) {collections.add(metadata); wrap(metadata, 'findOne', 'metadata-read', attachmentId);}
            if (!clients.has(client)) {
                clients.add(client);
                wrap(client, 'startSession', 'session-create', attachmentId, session => {
                    if (!session || isPromise(session) || sessions.has(session)) return;
                    sessions.add(session);
                    for (const name of ['startTransaction', 'commitTransaction', 'abortTransaction'])
                        wrap(session, name, name === 'startTransaction' ? 'transaction-start' : name === 'commitTransaction' ? 'commit' : 'abort', attachmentId);
                });
            }
            attached.set(adapter, attachmentId);
            attachments.push({id: attachmentId, mode, atNs: at().toString(), initialPublicOperationUnobserved: mode === 'api-discovery'});
            return true;
        } catch {
            while (restores.length > checkpoint) {try {restores.pop()();} catch {fail('restore-failed', 'A failed attachment could not be fully restored');}}
            fail('attachment-failed', 'The actual adapter could not be completely instrumented'); return false;
        }
    }
    function observeLoad(adapter, original, args, discover = false) {
        if (discover && !attached.has(adapter)) attachAdapter(adapter, 'api-discovery');
        const attachmentId = attached.get(adapter);
        return attachmentId ? observe('load', 'load', original, adapter, args, attachmentId) : Reflect.apply(original, adapter, args);
    }
    function report() {
        return {schemaVersion: 1, qualificationOnly: true, enabled: true, ...identity,
            clockOrigin: {monotonicOriginNs: began.toString(), wallBefore, wallAfter,
                units: 'Span and phase ns are relative to this process.hrtime.bigint origin; wall stamps only bracket its observation.',
                limitation: 'No V8-profiler epoch equivalence or exact cross-process clock alignment is inferred.'},
            observer: options.observer ?? {limits}, runtime: options.runtime ?? {platform: process.platform, arch: process.arch},
            modules: options.modules ?? [], attachments: attachments.map(row => ({...row})), phases: phases.map(row => ({...row})),
            errors: errors.map(row => ({...row})), droppedSpans, spans: spans.map(row => ({...row})), inFlight: [...active.values()].map(row => ({...row})),
            counters: [...counters.values()].map(row => ({...row, totalDurationNs: row.totalDurationNs.toString(),
                minimumDurationNs: row.minimumDurationNs?.toString() ?? null, maximumDurationNs: row.maximumDurationNs.toString()})),
            sealed, sealTimedOut, suppressedRootSpans,
            coverage: {logicalMethods: OPERATIONS, loadValidation: 'The storage instance validate callback only; includes its complete synchronous subtree.',
                directMetadataReads: 'The actual metadata collection findOne, including initialization reads.',
                undoCardinality: 'Successful ordinary validated result own-data undo.length only. Null means failed/unavailable. Load and validation visits are nested scopes; never add them.',
                transactionAttempts: 'Successful startTransaction entries count body attempts; commit methods and wire retries are separate.',
                unobserved: ['Direct initialization/admission lexical validators', 'Candidate-state lexical validation', 'Individual SDK/copy/encoding calls'],
                time: 'Nested asynchronous wall spans overlap. Synchronous validation spans are elapsed time, not sampled or process CPU.',
                overhead: 'Wrappers, ALS and settlement handlers add unquantified overhead and observe original Promise rejection bookkeeping.'}};
    }
    function handlePhase(message) {
        const requestId = typeof message?.requestId === 'string' && /^[a-zA-Z0-9-]{1,96}$/.test(message.requestId) ? message.requestId : null;
        const name = message?.phase, cached = requestId && requests.get(requestId);
        const acknowledgment = error => ({event: 'qualifier_projection_phase_ack', requestId, phase: name,
            pid: identity.pid, parentPid: identity.parentPid, role: identity.role, attached: attachments.length > 0,
            ...(error ? {error} : {})});
        if (message?.event === 'qualifier_projection_phase' && cached && cached.phase === name) return cached.promise;
        const expected = projectionMeasurementPhases[phases.length];
        if (message?.event !== 'qualifier_projection_phase' || !requestId || cached || name !== expected || !attachments.length) {
            fail('phase-invalid', 'Phase order, request identity or real adapter attachment was invalid');
            return Promise.resolve(acknowledgment('Invalid phase or adapter attachment'));
        }
        currentPhase = name; phases.push({requestId, phase: name, sequence: phases.length + 1, atNs: at().toString()});
        const promise = (async () => {
            if (name === 'shutdown') {
                sealing = true;
                const deadline = Date.now() + limits.sealTimeoutMS;
                while (active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
                sealed = active.size === 0; sealTimedOut = !sealed;
                if (!sealed) fail('seal-timeout', 'Tracked operations did not settle within the bounded shutdown window');
                try {options.persist?.(report());} catch {fail('persist-failed', 'The bounded observer receipt could not be persisted');}
            }
            return acknowledgment(errors.length ? 'Observer measurement is incomplete' : undefined);
        })();
        requests.set(requestId, {phase: name, promise}); return promise;
    }
    return {attachAdapter, observeLoad, handlePhase, report, fail,
        restore() {for (const restore of restores.reverse()) restore(); restores.length = 0;}};
}

/** Relay only ACKs actually emitted by the owned child for a phase sent by this parent. */
export function installProjectionPhaseRelay(parent, children) {
    const requests = new Map(), listeners = new Map();
    const receive = message => {
        if (message?.event !== 'qualifier_projection_phase' || typeof message.requestId !== 'string'
            || !/^[a-zA-Z0-9-]{1,96}$/.test(message.requestId) || !projectionMeasurementPhases.includes(message.phase)) return;
        const previous = requests.get(message.requestId);
        if (previous && previous !== message.phase || !previous && requests.size >= 4) return;
        requests.set(message.requestId, message.phase);
        for (const worker of Object.values(children.workers ?? {})) if (worker?.isConnected()) {
            try {worker.send(message);} catch {}
        }
    };
    const track = worker => {
        const forward = message => {
            if (message?.event !== 'qualifier_projection_phase_ack' || requests.get(message.requestId) !== message.phase
                || message.pid !== worker.process.pid || message.parentPid !== parent.pid || message.role !== 'projection') return;
            try {parent.send?.({...message, viaParentPid: parent.pid});} catch {}
        };
        listeners.set(worker, forward); worker.on('message', forward);
    };
    parent.on('message', receive); children.on('fork', track);
    for (const worker of Object.values(children.workers ?? {})) if (worker) track(worker);
    return () => {parent.off('message', receive); children.off('fork', track);
        for (const [worker, listener] of listeners) worker.off('message', listener);};
}

/** Class objects are mutable even though their ESM export bindings are immutable. */
export function installProjectionValidationHooks(observer, {Storage, Controller, role}) {
    const originalLoad = method(Storage.prototype, 'load'), originalCreate = Controller && method(Controller, 'create');
    if (!originalLoad || role === 'projection' && !originalCreate) throw new Error('Expected pinned class methods');
    const beforeLoad = Object.getOwnPropertyDescriptor(Storage.prototype, 'load');
    Object.defineProperty(Storage.prototype, 'load', {...beforeLoad, value: function (...args) {
        return observer.observeLoad(this, originalLoad, args, role === 'api');
    }});
    let beforeCreate;
    if (role === 'projection') {
        beforeCreate = Object.getOwnPropertyDescriptor(Controller, 'create');
        Object.defineProperty(Controller, 'create', {...beforeCreate, value: function (...args) {
            const adapter = own(args[0], 'adapter');
            if (adapter) observer.attachAdapter(adapter, 'owner'); else observer.fail('owner-unattached', 'Actual controller adapter was missing');
            return Reflect.apply(originalCreate, this, args);
        }});
    }
    return () => {Object.defineProperty(Storage.prototype, 'load', beforeLoad);
        if (beforeCreate) Object.defineProperty(Controller, 'create', beforeCreate);};
}

async function preload(directoryArgument) {
    if (process.versions.bun || !/^(22|24)\./.test(process.versions.node)) throw new Error('Qualification observer requires native Node22/24');
    if (!isAbsolute(directoryArgument) || lstatSync(directoryArgument).isSymbolicLink() || !lstatSync(directoryArgument).isDirectory()
        || realpathSync(directoryArgument) !== resolve(directoryArgument)) throw new Error('Observer directory must be ordinary and absolute');
    const repository = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
    const entry = process.argv[1] && resolve(process.argv[1]);
    const role = process.env.worker_role === 'projection' ? 'projection' : entry === join(repository, 'build/api/server.js') ? 'api' : undefined;
    if (!role) {
        if (entry === join(repository, 'build/indexer/launcher.js')) {
            const {default: cluster} = await import('node:cluster');
            if (cluster.isPrimary) installProjectionPhaseRelay(process, cluster);
        }
        return;
    }
    const path = join(directoryArgument, `projection-${process.pid}.json`), descriptor = openSync(path, 'wx', 0o600);
    let persisted = false;
    const persist = value => {
        if (persisted) return;
        const bytes = Buffer.from(JSON.stringify(value) + '\n');
        if (bytes.length > projectionObserverLimits.maxReportBytes) throw new Error('Observer output exceeds byte bound');
        let offset = 0;
        while (offset < bytes.length) {const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
            if (written < 1) throw new Error('Observer receipt short write'); offset += written;}
        fsyncSync(descriptor); persisted = true;
    };
    const storagePath = realpathSync(fileURLToPath(new URL('storage.js', import.meta.resolve('@eosrio/hyperion-backend-mongodb'))));
    const controllerPath = join(repository, 'build/indexer/projection/controller.js');
    const modules = [storagePath, ...(role === 'projection' ? [controllerPath] : [])].map(path => ({path, sha256: sha(readFileSync(path))}));
    const observerPath = fileURLToPath(import.meta.url);
    const observer = createProjectionValidationObserver({identity: {pid: process.pid, parentPid: process.ppid, role, node: process.version},
        observer: {path: observerPath, sha256: sha(readFileSync(observerPath)), limits: projectionObserverLimits}, modules, persist});
    const {MongoProjectionStorage: Storage} = await import(pathToFileURL(storagePath).href);
    const Controller = role === 'projection' ? (await import(pathToFileURL(controllerPath).href)).PortableStateController : undefined;
    installProjectionValidationHooks(observer, {Storage, Controller, role});
    process.on('message', message => {
        if (message?.event !== 'qualifier_projection_phase') return;
        void observer.handlePhase(message).then(ack => {try {process.send?.(ack);} catch {observer.fail('ack-send', 'Phase acknowledgment could not be sent');}});
    });
    process.on('exit', () => {
        if (!persisted) {
            observer.fail('unsealed-exit', 'Process exited before a persisted controlled shutdown receipt');
            try {persist(observer.report());} catch {try {process.stderr.write('Projection observer receipt persistence failed\n');} catch {}}
        }
        try {closeSync(descriptor);} catch {}
    });
}

if (process.env.HYP252_OBSERVER_DIR) await preload(process.env.HYP252_OBSERVER_DIR);
