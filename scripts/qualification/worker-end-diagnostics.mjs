import {isProxy} from 'node:util/types';
import {workerAttemptDigest} from '../../build/indexer/protocol/worker-attempt-supervisor.js';

const own = (value, key) => {
    if (value === null || typeof value !== 'object' || isProxy(value)) return undefined;
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property && Object.hasOwn(property, 'value') ? property.value : undefined;
};
// IPC carries plain JSON. Never invoke getters, toJSON, proxies or caller code while observing it.
function detached(value, budget = {nodes: 0}, depth = 0, seen = new Set()) {
    if (++budget.nodes > 2048 || depth > 16) throw new Error('End observation metadata budget exceeded');
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && Buffer.byteLength(value) <= 16 * 1024) return value;
    if (typeof value !== 'object' || isProxy(value) || seen.has(value)) throw new Error('End observation is not detached plain JSON');
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error('End observation has a foreign prototype');
    seen.add(value);
    try {
        const properties = Object.getOwnPropertyDescriptors(value);
        const entries = [];
        for (const key of Reflect.ownKeys(properties)) {
            if (typeof key !== 'string') throw new Error('End observation has a symbol');
            const property = properties[key];
            if (!property.enumerable) continue;
            if (!Object.hasOwn(property, 'value')) throw new Error('End observation has an accessor');
            entries.push([key, detached(property.value, budget, depth + 1, seen)]);
        }
        if (!Array.isArray(value)) return Object.fromEntries(entries);
        const length = properties.length?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > 2048 || entries.length !== length
            || entries.some(([key], index) => key !== String(index))) throw new Error('End observation has a sparse or decorated array');
        return entries.map(([, entry]) => entry);
    } finally {seen.delete(value);}
}

/** Original synchronous parent handle/reply boundaries only. No end, source or progress authority. */
export function installWorkerEndDiagnostics({Supervisor, emit, workerIdentity, failed, maximumSuccesses = 8, maximumFailures = 128}) {
    if (!Number.isSafeInteger(maximumSuccesses) || maximumSuccesses < 1 || maximumSuccesses > 32
        || !Number.isSafeInteger(maximumFailures) || maximumFailures < 1 || maximumFailures > 1024)
        throw new Error('Invalid worker end diagnostic bounds');
    let successes = 0, failures = 0, omittedSuccesses = 0, omittedFailures = 0, reportFailures = 0;
    const contexts = [], enabled = !!Supervisor && typeof Supervisor.prototype.handle === 'function' && typeof Supervisor.prototype.reply === 'function';
    const unavailable = () => {reportFailures++; failed();};
    const observe = work => {try {return work();} catch {unavailable(); return undefined;}};
    if (enabled) {
        const handle = Supervisor.prototype.handle, reply = Supervisor.prototype.reply;
        const snapshot = (context, boundary) => {
            const {supervisor, worker, payload} = context, request = {};
            // Only association operands survive. Client/challenge credentials and unknown summary values do not.
            for (const key of ['operation','attemptId','sequence','descriptorSha256','bindingSha256']) {
                const property = Object.getOwnPropertyDescriptor(payload, key);
                if (property) {
                    if (!Object.hasOwn(property, 'value')) throw new Error('End association input has an accessor');
                    request[key] = detached(property.value);
                }
            }
            const summaryProperty = Object.getOwnPropertyDescriptor(payload, 'summary');
            if (summaryProperty && !Object.hasOwn(summaryProperty, 'value')) throw new Error('End summary has an accessor');
            const summary = summaryProperty?.value;
            if (summary !== undefined) {
                const copy = detached(summary);
                const redacted = value => ({valueRedacted: true,
                    type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value});
                request.summary = copy && typeof copy === 'object' && !Array.isArray(copy)
                    ? Object.fromEntries(Object.entries(copy).map(([key, value]) => {
                        if (key === 'acknowledgementAttempted') return [key, typeof value === 'boolean' ? value : redacted(value)];
                        if (key === 'rootResult') return [key, ['returned','threw'].includes(value) ? value : redacted(value)];
                        return [key, {valueRedacted: true}];
                    })) : redacted(copy);
            }
            const owner = Map.prototype.get.call(own(supervisor, 'owners'), worker);
            const entries = own(owner, 'entries'), entry = entries ? Map.prototype.get.call(entries, request.attemptId) : undefined;
            return {request, validator: entry ? {entryPresent: true,
                descriptorSha256: workerAttemptDigest(detached(own(entry, 'descriptor'))),
                bindingSha256: workerAttemptDigest(detached(own(entry, 'binding')))} : {entryPresent: false},
                child: workerIdentity(worker), ownerRole: own(owner, 'role'), parentEpoch: own(supervisor, 'epoch'), parentIncarnation: own(owner, 'incarnation'),
                operandBoundary: boundary};
        };
        Supervisor.prototype.reply = function(worker, requestId, result, ...args) {
            const context = contexts.findLast(value => value.supervisor === this && value.worker === worker && value.requestId === requestId);
            if (context) observe(() => {
                context.successful = own(result, 'ok') === true;
                const selected = context.successful ? successes < maximumSuccesses : failures < maximumFailures;
                if (selected && omittedFailures === 0) {
                    // A failed association changes no entry before the original synchronous error reply.
                    // Normal ends outside the selected window incur no metadata copy/digest work.
                    context.view ??= snapshot(context, 'original synchronous error reply; no await or end mutation before association failure');
                    context.reply = detached(result);
                }
            });
            const returned = reply.call(this, worker, requestId, result, ...args);
            if (context) context.replyCalls++;
            return returned;
        };
        Supervisor.prototype.handle = function(worker, message, ...args) {
            let context;
            observe(() => {
                if (own(message, 'event') !== 'worker_attempt_request') return;
                const payload = own(message, 'payload');
                const operation = own(payload, 'operation');
                if (['hello','register','bind','observe','retire','retire-owner'].includes(operation)) return;
                if (!payload || isProxy(payload)) return;
                if (contexts.length >= 32) throw new Error('Worker end diagnostic nesting budget exceeded');
                context = {supervisor: this, worker, payload, requestId: own(message, 'requestId'), replyCalls: 0};
                if (successes < maximumSuccesses && omittedFailures === 0)
                    context.view = snapshot(context, 'original synchronous handle entry; no await before end validation');
            });
            if (context) contexts.push(context);
            try {return handle.call(this, worker, message, ...args);}
            finally {
                if (context) {
                    contexts.pop();
                    observe(() => {
                        const successful = context.successful;
                        if (successful ? successes++ >= maximumSuccesses : failures++ >= maximumFailures) {
                            if (successful) omittedSuccesses++; else {omittedFailures++; unavailable();}
                            return;
                        }
                        if (context.replyCalls !== 1 || !context.reply) throw new Error('Original end reply boundary is unavailable or ambiguous');
                        const compared = successful || context.reply.error === 'Invalid worker attempt end association';
                        const view = context.view;
                        if (!view) throw new Error('Original end operand snapshot is unavailable');
                        let mismatches = null;
                        if (compared) {
                            if (!view.validator.entryPresent) throw new Error('Original end validator entry is unavailable');
                            const input = view.request, summary = input.summary;
                            mismatches = [];
                            if (input.operation !== 'end') mismatches.push('operation');
                            for (const key of ['descriptorSha256','bindingSha256'])
                                if (input[key] !== view.validator[key]) mismatches.push(key);
                            const keys = summary && typeof summary === 'object' && !Array.isArray(summary) ? Object.keys(summary).sort() : [];
                            if (keys.join('|') !== 'acknowledgementAttempted|rootResult') mismatches.push('summary.keys');
                            if (typeof summary?.acknowledgementAttempted !== 'boolean') mismatches.push('summary.acknowledgementAttempted');
                            if (!['returned','threw'].includes(summary?.rootResult)) mismatches.push('summary.rootResult');
                        }
                        emit('worker_attempt_end_association', () => ({requestId: context.requestId, attemptId: view.request.attemptId,
                            ...view, reply: context.reply, mismatches,
                            validatorComparisonReached: compared, credentialsRetained: false,
                            replyBoundary: 'original Supervisor.reply input; delivery and settlement unknown'}));
                    });
                }
            }
        };
    }
    return {snapshot: () => ({enabled, successes, failures, omittedSuccesses, omittedFailures, reportFailures,
        maximumSuccesses, maximumFailures, maximumNesting: 32, observationOnly: true})};
}
