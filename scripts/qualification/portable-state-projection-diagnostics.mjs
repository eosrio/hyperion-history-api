import {isPromise} from 'node:util/types';
import {currentProofConsumerScope, ProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';

/** Bounded observations only. Descriptions and JSON cannot authorize retry, end, effects or progress. */
export function installProjectionDiagnostics({WorkerClient, Supervisor, Master, record, maximumAttempts = 8, maximumTransitions = 8}) {
    if (![maximumAttempts, maximumTransitions].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 32))
        throw new Error('Invalid projection diagnostic bounds');
    const clients = new WeakMap(), roots = new WeakMap();
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
    const observe = work => {try {work();} catch {reportFailures++;}};
    const observePromise = (result, returned, threw) => {
        try {
            if (!isPromise(result)) throw new Error('Original native diagnostic promise is unavailable');
            // Never forward an opaque result through another Promise resolution or read its then getter.
            Promise.prototype.then.call(result, () => {observe(returned);}, error => {observe(() => {threw(error);});});
        } catch {reportFailures++;}
    };
    const scopeRun = ProofConsumerScope.prototype.run;
    ProofConsumerScope.prototype.run = function(operation, ...args) {
        const context = roots.get(this), result = scopeRun.call(this, operation, ...args);
        if (context) observePromise(result, context.returned, context.threw);
        return result;
    };
    const run = WorkerClient.prototype.run;
    WorkerClient.prototype.run = function(handle, operation, ...args) {
        if (this.role !== 'projection') return run.call(this, handle, operation, ...args);
        const state = clients.get(this) ?? {count: 0, selected: new WeakSet()}; clients.set(this, state);
        if (state.count++ >= maximumAttempts) {omittedAttempts++; return run.call(this, handle, operation, ...args);}
        const description = describe(this, handle);
        if (!['projection-initialization', 'projection-frame'].includes(description.descriptor?.kind))
            return run.call(this, handle, operation, ...args);
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
        observe(() => {emit('projection_attempt_begin', origin());});
        try {
            const local = this.attempts.get(handle);
            if (local && !local.running && !local.ended) roots.set(local.scope, {
                returned: () => {emit('projection_root_returned', origin());},
                threw: error => {emit('projection_root_threw', {...origin(), error: errorView(error),
                    originalScopeFence: scope?.ownsFenceError(error) ?? false});}});
        } catch {reportFailures++;}
        let result;
        try {
            result = run.call(this, handle, function(...args) {
                // The original client still creates and owns the scope, root, drainage and end request.
                try {scope = currentProofConsumerScope();} catch {reportFailures++;}
                const onFence = () => {observe(() => {emit('projection_attempt_fenced', origin());});};
                observe(() => {scope?.signal.addEventListener('abort', onFence, {once: true});});
                return operation.apply(this, args);
            }, ...args);
        } catch (error) {
            observe(() => {emit('projection_attempt_threw', {...origin(), error: errorView(error), originalScopeFence: scope?.ownsFenceError(error) ?? false});});
            throw error;
        }
        observePromise(result, () => {emit('projection_attempt_returned', origin());},
            error => {emit('projection_attempt_threw', {...origin(), error: errorView(error), originalScopeFence: scope?.ownsFenceError(error) ?? false});});
        return result;
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
            observe(() => {
                if (transitions++ < maximumTransitions) {
                    const snapshot = this.snapshot();
                    const owners = snapshot.owners.filter(owner => owner.role === 'projection');
                    emit('projection_source_fence', {epoch: snapshot.epoch, active: snapshot.active,
                        owners: owners.slice(0, 8).map(owner => ({...owner, attempts: owner.attempts.slice(0, 8)})),
                        omittedOwners: Math.max(0, owners.length - 8),
                        omittedOwnerAttempts: owners.slice(0, 8).reduce((total, owner) => total + Math.max(0, owner.attempts.length - 8), 0)});
                } else omittedTransitions++;
            });
            return fence.apply(this, args);
        };
    }
    if (Master) {
        const source = value => value ? {readerPid: value.worker?.process?.pid ?? null,
            readerSessionId: value.readerSessionId, generation: value.generation ?? null} : null;
        const open = Master.prototype.handleProtocolAbiCoordinatorRequest;
        Master.prototype.handleProtocolAbiCoordinatorRequest = function(worker, message, ...args) {
            const opening = message?.data?.operation === 'open', selected = opening && sourceCalls++ < maximumTransitions;
            if (opening && !selected) omittedSourceCalls++;
            const snapshot = () => ({readerPid: worker?.process?.pid ?? null,
                currentReader: this.liveReader?.wref === worker, source: source(this.protocolAbiSource)});
            if (selected) observe(() => {emit('projection_source_open_begin', snapshot());});
            let result;
            try {result = open.call(this, worker, message, ...args);}
            catch (error) {
                if (selected) observe(() => {emit('projection_source_open_end', snapshot());});
                throw error;
            }
            if (selected) {
                const finished = () => {emit('projection_source_open_end', snapshot());};
                observePromise(result, finished, finished);
            }
            return result;
        };
    }
    return {snapshot: () => ({attempts, omittedAttempts, transitions, omittedTransitions, sourceCalls, omittedSourceCalls, reportFailures,
        maximumAttempts, maximumTransitions, observationOnly: true})};
}
