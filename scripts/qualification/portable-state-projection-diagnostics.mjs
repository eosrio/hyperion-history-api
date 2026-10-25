import {currentProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';

/** Bounded observations only. Descriptions and JSON cannot authorize retry, end, effects or progress. */
export function installProjectionDiagnostics({WorkerClient, Supervisor, Master, record, maximumAttempts = 8, maximumTransitions = 8}) {
    if (![maximumAttempts, maximumTransitions].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 32))
        throw new Error('Invalid projection diagnostic bounds');
    const clients = new WeakMap();
    let attempts = 0, omittedAttempts = 0, transitions = 0, omittedTransitions = 0, sourceCalls = 0, omittedSourceCalls = 0, reportFailures = 0;
    const emit = (event, value) => {
        try {
            const bytes = JSON.stringify({observationOnly: true, pid: process.pid, parentPid: process.ppid, ...value});
            if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error('Projection diagnostic row exceeds its byte bound');
            record(event, JSON.parse(bytes));
        }
        catch {reportFailures++;}
    };
    const describe = (client, handle) => {
        try {return client.describe(handle);} catch {return {descriptionUnavailable: true};}
    };
    const errorView = error => {
        try {return {name: typeof error?.name === 'string' ? error.name.slice(0, 128) : typeof error,
            code: typeof error?.code === 'string' ? error.code.slice(0, 128) : null};}
        catch {return {descriptionUnavailable: true};}
    };
    const run = WorkerClient.prototype.run;
    WorkerClient.prototype.run = async function(handle, operation) {
        if (this.role !== 'projection') return run.call(this, handle, operation);
        const state = clients.get(this) ?? {count: 0, selected: new WeakSet()}; clients.set(this, state);
        if (state.count++ >= maximumAttempts) {omittedAttempts++; return run.call(this, handle, operation);}
        const description = describe(this, handle);
        if (!['projection-initialization', 'projection-frame'].includes(description.descriptor?.kind))
            return run.call(this, handle, operation);
        attempts++; state.selected.add(handle);
        let scope;
        const origin = () => {
            // Qualification already observes compiled private lifecycle state. No handle or scope escapes.
            const local = this.attempts.get(handle);
            return {attempt: describe(this, handle), ...(scope ? {scope: scope.snapshot()} : {}), lifecycle: {
                stopped: this.stopped, activeFence: local?.activeFence ?? null,
                initializationRetryClaimed: local?.initializationRetryClaimed ?? null,
                parentEpoch: this.authority?.epoch ?? null, parentIncarnation: this.authority?.incarnation ?? null}};
        };
        emit('projection_attempt_begin', origin());
        try {
            const result = await run.call(this, handle, async () => {
                // The original client still creates and owns the scope, root, drainage and end request.
                try {scope = currentProofConsumerScope();} catch {reportFailures++;}
                const onFence = () => emit('projection_attempt_fenced', origin());
                scope?.signal.addEventListener('abort', onFence, {once: true});
                try {
                    const value = await operation();
                    emit('projection_root_returned', origin()); return value;
                } catch (error) {
                    emit('projection_root_threw', {...origin(), error: errorView(error), originalScopeFence: scope?.ownsFenceError(error) ?? false});
                    throw error;
                }
            });
            emit('projection_attempt_returned', origin()); return result;
        } catch (error) {
            emit('projection_attempt_threw', {...origin(), error: errorView(error), originalScopeFence: scope?.ownsFenceError(error) ?? false});
            throw error;
        }
    };
    const retry = WorkerClient.prototype.consumeProjectionInitializationRetry;
    WorkerClient.prototype.consumeProjectionInitializationRetry = function(handle, error) {
        const accepted = retry.call(this, handle, error);
        if (clients.get(this)?.selected.has(handle)) emit('projection_initialization_retry', {
            attempt: describe(this, handle), accepted, error: errorView(error)});
        return accepted;
    };
    if (Supervisor) {
        const fence = Supervisor.prototype.fenceActive;
        Supervisor.prototype.fenceActive = function(...args) {
            if (transitions++ < maximumTransitions) {
                const snapshot = this.snapshot();
                const owners = snapshot.owners.filter(owner => owner.role === 'projection');
                emit('projection_source_fence', {epoch: snapshot.epoch, active: snapshot.active,
                    owners: owners.slice(0, 8).map(owner => ({...owner, attempts: owner.attempts.slice(0, 8)})),
                    omittedOwners: Math.max(0, owners.length - 8),
                    omittedOwnerAttempts: owners.slice(0, 8).reduce((total, owner) => total + Math.max(0, owner.attempts.length - 8), 0)});
            } else omittedTransitions++;
            return fence.apply(this, args);
        };
    }
    if (Master) {
        const source = value => value ? {readerPid: value.worker?.process?.pid ?? null,
            readerSessionId: value.readerSessionId, generation: value.generation ?? null} : null;
        const open = Master.prototype.handleProtocolAbiCoordinatorRequest;
        Master.prototype.handleProtocolAbiCoordinatorRequest = async function(worker, message) {
            const opening = message?.data?.operation === 'open', selected = opening && sourceCalls++ < maximumTransitions;
            if (opening && !selected) omittedSourceCalls++;
            if (selected) emit('projection_source_open_begin', {readerPid: worker?.process?.pid ?? null,
                currentReader: this.liveReader?.wref === worker, source: source(this.protocolAbiSource)});
            try {return await open.call(this, worker, message);}
            finally {if (selected) emit('projection_source_open_end', {readerPid: worker?.process?.pid ?? null,
                currentReader: this.liveReader?.wref === worker, source: source(this.protocolAbiSource)});}
        };
    }
    return {snapshot: () => ({attempts, omittedAttempts, transitions, omittedTransitions, sourceCalls, omittedSourceCalls, reportFailures,
        maximumAttempts, maximumTransitions, observationOnly: true})};
}
