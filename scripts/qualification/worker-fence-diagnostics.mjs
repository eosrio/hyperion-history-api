import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {ProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';
import {workerAttemptDigest} from '../../build/indexer/protocol/worker-attempt-supervisor.js';

/** Original-object observations only. These records never issue an end, retry or fault allowance. */
export function installWorkerFenceDiagnostics({WorkerClient, WorkerHost, Supervisor, Master, emit, failed, physical, workerIdentity,
    maximumFenceEvents = 1024, membersPerRow = 32}) {
    if (!Number.isSafeInteger(maximumFenceEvents) || maximumFenceEvents < 1 || maximumFenceEvents > 4096
        || !Number.isSafeInteger(membersPerRow) || membersPerRow < 1 || membersPerRow > 32)
        throw new Error('Invalid fence diagnostic bounds');
    const context = new AsyncLocalStorage(), records = new WeakMap(), origins = new WeakMap();
    const transports = new WeakMap(), channels = new WeakSet(), workers = new WeakMap(), deferred = new WeakMap();
    const identities = new WeakMap();
    const identifyWorker = worker => {
        let identity = identities.get(worker);
        if (!identity) {identity = workerIdentity ? workerIdentity(worker) : physical(worker.process.pid); identities.set(worker, identity);}
        return identity;
    };
    let events = 0, omitted = 0, normalDrains = 0;
    const observe = (event, value) => {
        if (events++ >= maximumFenceEvents) {omitted++; failed(); return;}
        emit(event, value);
    };
    const attempt = record => ({attemptId: record.id, sequence: record.sequence,
        descriptorSha256: workerAttemptDigest(record.descriptor), bindingSha256: workerAttemptDigest(record.binding)});
    const authority = client => ({parentEpoch: client.authority?.epoch ?? null, parentIncarnation: client.authority?.incarnation ?? null});
    const safely = operation => {try {return operation();} catch {failed();}};
    const wrap = (prototype, name, operation) => {
        const original = prototype?.[name]; if (typeof original !== 'function') return;
        prototype[name] = function(...args) {return operation.call(this, original, args);};
    };
    const childOrigin = (scope, record, client) => {
        const current = context.getStore();
        if (current?.draining === scope) return {kind: 'normal-root-drain'};
        const ipc = current?.ipc;
        if (ipc?.transport === client.options.transport && ipc.event === 'disconnect') return {kind: 'ipc-disconnect'};
        if (ipc?.transport === client.options.transport && current.client === client
            && ['worker_attempt_fence', 'worker_attempt_fence_active'].includes(ipc.message?.event)
            && ipc.message.epoch === client.authority?.epoch && ipc.message.incarnation === client.authority?.incarnation)
            return {kind: 'parent-ipc', event: ipc.message.event, messageSha256: workerAttemptDigest(ipc.message), deferred: false};
        const pending = deferred.get(client);
        if (current?.opening === client && pending && pending.value.epoch === client.authority?.epoch
            && pending.value.incarnation === client.authority?.incarnation && record.sequence <= pending.value.sequence)
            return {kind: 'parent-ipc', event: pending.event, messageSha256: pending.messageSha256,
                deferred: true, sequenceWatermark: pending.value.sequence};
        if (current?.channel && current.client === client && record.descriptor
            && [record.descriptor.consumerId, record.descriptor.publisherId].includes(current.channel.id))
            return {kind: 'channel-close', channelId: current.channel.id};
        return {kind: current?.disposing === client ? 'dispose' : current?.retiring === client ? 'supervised-retirement' : 'unclassified-local',
            method: current?.client === client ? current.method : null};
    };
    wrap(ProofConsumerScope.prototype, 'closeAndDrain', function(original, args) {
        return context.run({...context.getStore(), draining: this}, () => original.apply(this, args));
    });
    wrap(ProofConsumerScope.prototype, 'fence', function(original, args) {
        // Retain the first original open->fenced transition, before abort listeners can re-enter.
        const retained = records.get(this);
        if (!retained || this.snapshot().state !== 'open') return original.apply(this, args);
        const origin = safely(() => childOrigin(this, retained.record, retained.client));
        const observation = origin && {id: randomUUID(), origin};
        if (observation) origins.set(this, observation);
        const result = original.apply(this, args);
        if (observation?.origin.kind === 'normal-root-drain') normalDrains++;
        else if (observation) observe(observation.origin.kind === 'parent-ipc' ? 'worker_attempt_fence_received' : 'worker_attempt_scope_fenced',
            () => ({...observation, ...authority(retained.client), role: retained.client.role,
                attempt: attempt(retained.record), scope: this.snapshot()}));
        return result;
    });
    const observeTransport = client => {
        if (client.mode !== 'managed') return;
        const transport = client.options.transport;
        let clients = transports.get(transport);
        if (clients) {clients.add(client); return;}
        clients = new Set([client]); transports.set(transport, clients);
        const original = transport.emit;
        transport.emit = function(event, ...args) {
            if (event !== 'message' && event !== 'disconnect') return original.call(this, event, ...args);
            const ipc = {transport: this, event, message: args[0]};
            return context.run({...context.getStore(), ipc}, () => {
                try {return original.call(this, event, ...args);}
                finally {if (event === 'message') for (const observed of clients) safely(() => {
                    // The original callback caches this exact object before hello. It is not yet accepted.
                    const pending = observed.pendingFence;
                    if (pending && pending !== deferred.get(observed)?.value)
                        deferred.set(observed, {value: pending, event: pending.stop ? 'worker_attempt_fence' : 'worker_attempt_fence_active',
                            messageSha256: workerAttemptDigest(ipc.message)});
                });}
            });
        };
    };
    wrap(WorkerClient?.prototype, 'capture', function(original, args) {
        safely(() => observeTransport(this));
        const handle = original.apply(this, args);
        safely(() => {const record = this.attempts.get(handle); records.set(record.scope, {client: this, record});});
        return handle;
    });
    wrap(WorkerClient?.prototype, 'open', function(original, args) {
        // Return the original memoized promise; do not replace its completion or rejection.
        return context.run({...context.getStore(), opening: this}, () => original.apply(this, args));
    });
    for (const name of ['fenceAll', 'fenceActiveAttempts', 'fenceChannel']) wrap(WorkerClient?.prototype, name, function(original, args) {
        return context.run({...context.getStore(), client: this, method: name}, () => original.apply(this, args));
    });
    for (const [name, key] of [['dispose', 'disposing'], ['requestSupervisedRetirement', 'retiring']])
        wrap(WorkerClient?.prototype, name, function(original, args) {
            try {return context.run({...context.getStore(), [key]: this}, () => original.apply(this, args));}
            finally {if (name === 'dispose') safely(() => {transports.get(this.options.transport)?.delete(this); deferred.delete(this);});}
        });
    wrap(WorkerHost?.prototype, 'attemptChannelId', function(original, args) {
        const id = original.apply(this, args), channel = args[0];
        safely(() => {
            if (!channel || channels.has(channel)) return;
            channels.add(channel); const dispatch = channel.emit;
            channel.emit = function(event, ...values) {
                if (event !== 'close' || this !== channel) return dispatch.call(this, event, ...values);
                return context.run({...context.getStore(), channel: {object: this, id}}, () => dispatch.call(this, event, ...values));
            };
        });
        return id;
    });
    for (const name of ['fenceActive', 'retire', 'stop', 'handle']) wrap(Supervisor?.prototype, name, function(original, args) {
        const previous = context.getStore();
        return context.run({...previous, supervisor: this, method: name,
            supervisorCaller: previous?.supervisor === this ? previous.method : null}, () => original.apply(this, args));
    });
    for (const name of ['handleProtocolAbiCoordinatorRequest', 'revokeProtocolAbiReader']) wrap(Master?.prototype, name, function(original, args) {
        const [worker, message] = args;
        const currentReaderAtCall = this.liveReader?.wref === worker;
        // Irrelevant/unauthorized calls must retain the original no-op without demanding /proc evidence.
        // Real revocation may follow physical exit; identify the captured Worker, not a new PID lookup.
        const source = () => ({method: name, workerId: worker?.id ?? null, reader: identifyWorker(worker), currentReaderAtCall,
            requestId: message?.mId ?? null, operation: message?.data?.operation ?? null,
            readerSessionId: typeof message === 'string' ? message : message?.data?.readerSessionId ?? null});
        return context.run({...context.getStore(), source}, () => original.apply(this, args));
    });
    wrap(Supervisor?.prototype, 'attach', function(original, args) {
        const result = original.apply(this, args), worker = args[0];
        safely(() => {
            const owner = this.owners.get(worker);
            if (!owner || workers.get(worker) === owner) return;
            workers.set(worker, owner);
            const child = identifyWorker(worker);
            const send = worker.send, supervisor = this;
            worker.send = function(message, ...values) {
                const current = context.getStore();
                if (this !== worker || supervisor.owners.get(worker) !== owner || current?.supervisor !== supervisor
                    || !['worker_attempt_fence', 'worker_attempt_fence_active'].includes(message?.event))
                    return send.call(this, message, ...values);
                let snapshot;
                safely(() => {
                    const members = [...owner.entries.values()].filter(entry => !entry.end).map(attempt);
                    snapshot = {sendId: randomUUID(), workerId: worker.id, childPid: worker.process?.pid ?? null,
                        child, role: owner.role, parentEpoch: supervisor.epoch, parentIncarnation: owner.incarnation,
                        fenceEvent: message.event, messageSha256: workerAttemptDigest(message), method: current.method,
                        invokedFrom: current.supervisorCaller,
                        sourceOperation: current.source?.() ?? null, memberCount: members.length};
                    // All chunks or an explicit failure. Never silently present a prefix as a complete set.
                    for (let offset = 0; offset < members.length; offset += membersPerRow)
                        observe('worker_attempt_fence_members', () => ({...snapshot, offset, members: members.slice(offset, offset + membersPerRow)}));
                });
                const last = values.length - 1;
                if (snapshot && typeof values[last] === 'function') {
                    const callback = values[last];
                    values[last] = function(...received) {
                        observe('worker_attempt_fence_send_callback', () => ({...snapshot, error: received[0]
                            ? {name: received[0].name, message: received[0].message?.slice(0, 1024)} : null}));
                        return callback.apply(this, received);
                    };
                }
                try {
                    const returned = send.call(this, message, ...values);
                    if (snapshot) observe('worker_attempt_fence_sent', () => ({...snapshot, returned}));
                    return returned;
                } catch (error) {
                    if (snapshot) observe('worker_attempt_fence_send_threw', () => ({...snapshot,
                        error: {name: error?.name, message: error?.message?.slice(0, 1024)}}));
                    throw error;
                }
            };
        });
        return result;
    });
    return {describe: (client, handle) => {
        const record = client.attempts.get(handle);
        return record ? origins.get(record.scope) ?? null : null;
    }, snapshot: () => ({events, omitted, normalDrains, maximumFenceEvents, membersPerRow,
        enabled: {client: !!WorkerClient, host: !!WorkerHost, supervisor: !!Supervisor, master: !!Master}})};
}
