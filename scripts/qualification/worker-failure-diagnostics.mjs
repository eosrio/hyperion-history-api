import {randomUUID} from 'node:crypto';
import {isPromise} from 'node:util/types';
import {ProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';

/** Bounded observations of original error, callback and Worker objects; never a fault ledger. */
export function installWorkerFailureDiagnostics({Pool, Reader, Projection, WorkerClient, Master, Supervisor, cluster,
    emit, workerIdentity, failed, maximumFailureEvents = 128}) {
    if (!Number.isSafeInteger(maximumFailureEvents) || maximumFailureEvents < 1 || maximumFailureEvents > 1024)
        throw new Error('Invalid worker failure diagnostic bound');
    let events = 0, omitted = 0, rejectedRoots = 0, omittedRoots = 0;
    const rootContexts = new WeakMap(), roots = new WeakMap(), batches = new WeakMap(), readerDecisions = new WeakMap();
    const knownWorkers = new WeakSet(), disconnects = new WeakMap(), requests = new WeakMap(), replacements = new WeakMap();
    const pendingDefinitions = new WeakMap();
    const launching = [];
    const observe = operation => {try {return operation();} catch {failed(); return undefined;}};
    const record = (event, snapshot) => {
        if (events++ >= maximumFailureEvents) {omitted++; failed(); return;}
        observe(() => emit(event, snapshot));
    };
    const errorDescription = error => ({name: typeof error?.name === 'string' ? error.name.slice(0, 128) : null,
        message: typeof error?.message === 'string' ? error.message.slice(0, 1024) : null, valueType: typeof error});
    const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
    const describeRoot = (client, error) => {
        const matches = object(error) ? roots.get(error)?.filter(root => root.client === client) ?? [] : [];
        const root = matches.length === 1 ? matches[0] : null;
        return {originalObjectMatch: !!root && root.rootResult === 'threw' && root.rootError === error,
            runRejectionObjectMatch: !!root, ambiguous: matches.length > 1,
            operationEntered: root?.operationEntered ?? false, rootResult: root?.rootResult ?? null,
            runFailureId: root?.id ?? null,
            parentAtRunRejection: root?.parentAtRunRejection ?? null,
            rootError: root?.rootResult === 'threw' ? errorDescription(root.rootError) : null,
            attempt: matches.length === 1 ? client.describe(matches[0].handle) : null};
    };
    const enabled = {root: typeof WorkerClient?.prototype.run === 'function' && typeof ProofConsumerScope.prototype.run === 'function',
        attempts: typeof WorkerClient?.prototype.run === 'function',
        pool: typeof Pool?.prototype.exitForActionProcessing === 'function' && typeof Pool?.prototype.processMessages === 'function',
        reader: typeof Reader?.prototype.exitForPublisherRecovery === 'function' && typeof Reader?.prototype.failPublisherRecovery === 'function',
        projection: typeof Projection?.prototype.handleProjectionFailure === 'function',
        master: typeof Master?.prototype.handleWorkerDisconnect === 'function' && typeof Master?.prototype.relaunchDisconnectedWorker === 'function',
        cluster: !!cluster?.isPrimary && typeof cluster.fork === 'function', supervisor: typeof Supervisor?.prototype.attach === 'function'};
    if (enabled.attempts && enabled.root) {
        const scopeRun = ProofConsumerScope.prototype.run;
        ProofConsumerScope.prototype.run = function(operation, ...args) {
            const context = rootContexts.get(this);
            const observed = context ? function(...parameters) {
                context.operationEntered = true; context.rootResult = 'pending';
                return operation.apply(this, parameters);
            } : operation;
            const result = scopeRun.call(this, observed, ...args);
            if (context) observe(() => {
                if (!isPromise(result)) throw new Error('Original scope root promise is unavailable');
                Promise.prototype.then.call(result, () => {context.rootResult = 'returned';}, error => {
                    context.rootResult = 'threw'; context.rootError = error;
                });
            });
            return result;
        };
        const run = WorkerClient.prototype.run;
        WorkerClient.prototype.run = function(handle, ...args) {
            const context = {id: randomUUID(), client: this, handle, operationEntered: false, rootResult: 'not-entered'};
            observe(() => {
                const attempt = this.attempts?.get(handle);
                if (attempt && !attempt.running && !attempt.ended) rootContexts.set(attempt.scope, context);
            });
            const result = run.call(this, handle, ...args);
            observe(() => {
                if (!isPromise(result)) throw new Error('Original worker run promise is unavailable');
                Promise.prototype.then.call(result, () => {}, error => {
                    observe(() => {
                        if (++rejectedRoots > maximumFailureEvents) {omittedRoots++; failed(); return;}
                        context.parentAtRunRejection = this.authority
                            ? {epoch: this.authority.epoch, incarnation: this.authority.incarnation} : null;
                        record('worker_attempt_run_rejected', () => ({runFailureId: context.id,
                            attempt: this.describe(handle), error: errorDescription(error), rootResult: context.rootResult,
                            parentAtRunRejection: context.parentAtRunRejection,
                            operationEntered: context.operationEntered,
                            rootError: context.rootResult === 'threw' ? errorDescription(context.rootError) : null,
                            sameRootErrorObject: object(error) && context.rootError === error}));
                        if (!object(error)) return;
                        const prior = roots.get(error) ?? [];
                        if (prior.length >= 8) {failed(); return;}
                        roots.set(error, [...prior, context]);
                    });
                });
            });
            return result;
        };
    }
    if (enabled.pool) {
        const process = Pool.prototype.processMessages, exit = Pool.prototype.exitForActionProcessing;
        Pool.prototype.processMessages = function(payload, ...args) {
            const result = process.call(this, payload, ...args);
            observe(() => result.then(() => {}, error => {observe(() => {
                if (!object(payload)) return;
                const previous = batches.get(payload);
                batches.set(payload, previous ? {ambiguous: true} : {worker: this, error});
            });}));
            return result;
        };
        Pool.prototype.exitForActionProcessing = function(error, payload, ...args) {
            record('worker_failure_decision', () => {
                const batch = object(payload) ? batches.get(payload) : null;
                return {boundary: 'action-processing', error: errorDescription(error),
                    originalBatchMatch: !!batch && !batch.ambiguous && batch.worker === this && batch.error === error,
                    batchSize: Array.isArray(payload) ? payload.length : null,
                    root: describeRoot(this.workerAttemptClient, error)};
            });
            return exit.call(this, error, payload, ...args);
        };
    }
    if (enabled.projection) {
        const exit = Projection.prototype.handleProjectionFailure;
        Projection.prototype.handleProjectionFailure = function(error, ...args) {
            record('worker_failure_decision', () => ({boundary: 'projection', error: errorDescription(error),
                root: describeRoot(this.workerAttemptClient, error)}));
            return exit.call(this, error, ...args);
        };
    }
    if (enabled.reader) {
        const recover = Reader.prototype.failPublisherRecovery, exit = Reader.prototype.exitForPublisherRecovery;
        Reader.prototype.failPublisherRecovery = function(reason, decision, ...args) {
            const first = !this.publisherFailure;
            if (first) observe(() => readerDecisions.set(this, {id: randomUUID(), reason, predicate: decision.predicate}));
            return recover.call(this, reason, decision, ...args);
        };
        Reader.prototype.exitForPublisherRecovery = function(...args) {
            record('worker_failure_decision', () => ({boundary: 'reader-publisher-recovery',
                decision: readerDecisions.get(this) ?? null, originalDecisionMatch: readerDecisions.has(this),
                reasonStillCurrent: readerDecisions.get(this)?.reason === this.publisherFailure}));
            return exit.apply(this, args);
        };
    }
    if (enabled.cluster) {
        cluster.on('fork', worker => {observe(() => {knownWorkers.add(worker); workerIdentity(worker);});});
        cluster.on('disconnect', worker => {
            if (!knownWorkers.has(worker)) return;
            observe(() => {
                const decision = {id: randomUUID(), worker, identity: workerIdentity(worker)};
                disconnects.set(worker, decision);
                record('physical_worker_disconnected', () => ({disconnectId: decision.id, workerId: worker.id, child: decision.identity}));
            });
        });
        const fork = cluster.fork;
        cluster.fork = function(definition, ...args) {
            const result = fork.call(this, definition, ...args);
            observe(() => {
                const trigger = launching.at(-1);
                if (!trigger) return;
                const pending = pendingDefinitions.get(trigger.master), request = pending?.get(definition);
                if (!request || request.master !== trigger.master || !trigger.master.workerMap.includes(definition)
                    || definition.wref !== undefined) return;
                pending.delete(definition);
                const replacement = {...request, triggerRequestId: trigger.id, replacementId: randomUUID(), worker: result};
                replacements.set(result, replacement);
                record('worker_replacement_forked', () => ({replacementId: replacement.replacementId, requestId: request.id,
                    triggerRequestId: trigger.id, disconnectId: request.disconnect.id,
                    logicalWorkerId: definition.worker_id, role: definition.worker_role,
                    previous: request.disconnect.identity, previousOwner: request.previousOwner, child: workerIdentity(result)}));
            });
            return result;
        };
    }
    if (enabled.master) {
        const disconnect = Master.prototype.handleWorkerDisconnect, relaunch = Master.prototype.relaunchDisconnectedWorker;
        Master.prototype.handleWorkerDisconnect = function(worker, ...args) {
            let pending;
            observe(() => {
                const original = disconnects.get(worker); disconnects.delete(worker);
                const definition = this.workerMap.find(value => value.wref === worker);
                if (original && definition && !this.mode_transition && !this.shutdownStarted) {
                    const owner = this.workerAttemptSupervisor?.owners.get(worker);
                    pending = {id: randomUUID(), master: this, definition, previous: worker, disconnect: original,
                        previousOwner: owner ? {epoch: this.workerAttemptSupervisor.epoch, incarnation: owner.incarnation} : null,
                        failures: definition.failures ?? 0};
                }
            });
            const result = disconnect.call(this, worker, ...args);
            observe(() => {
                if (!pending || pending.definition.wref !== undefined || pending.definition.failures !== pending.failures + 1) return;
                requests.set(worker, pending);
                let definitions = pendingDefinitions.get(this);
                if (!definitions) {definitions = new WeakMap(); pendingDefinitions.set(this, definitions);}
                definitions.set(pending.definition, pending);
                record('worker_replacement_requested', () => ({requestId: pending.id, disconnectId: pending.disconnect.id,
                    logicalWorkerId: pending.definition.worker_id, role: pending.definition.worker_role,
                    previous: pending.disconnect.identity, previousOwner: pending.previousOwner, failures: pending.definition.failures}));
            });
            return result;
        };
        Master.prototype.relaunchDisconnectedWorker = function(worker, definition, ...args) {
            let request;
            observe(() => {
                const candidate = requests.get(worker);
                // An earlier timer may already have launched this definition. This original callback can
                // still sweep other pending definitions, each of which keeps its own disconnect relation.
                if (candidate?.master === this && candidate.definition === definition && this.workerMap.includes(definition)) {
                    request = candidate; requests.delete(worker);
                }
            });
            if (!request) return relaunch.call(this, worker, definition, ...args);
            launching.push(request);
            try {return relaunch.call(this, worker, definition, ...args);}
            finally {launching.pop();}
        };
    }
    if (enabled.supervisor) {
        const attach = Supervisor.prototype.attach;
        Supervisor.prototype.attach = function(worker, role, ...args) {
            const result = attach.call(this, worker, role, ...args);
            observe(() => {
                const replacement = replacements.get(worker);
                if (!replacement || replacement.master.workerAttemptSupervisor !== this) return;
                record('replacement_owner_attached', () => ({replacementId: replacement.replacementId, requestId: replacement.id,
                    triggerRequestId: replacement.triggerRequestId,
                    child: workerIdentity(worker), previous: replacement.disconnect.identity, previousOwner: replacement.previousOwner, role,
                    parentEpoch: this.epoch, parentIncarnation: this.owners.get(worker).incarnation}));
            });
            return result;
        };
    }
    return {describeReaderDecision: reader => readerDecisions.get(reader),
        snapshot: () => ({observationOnly: true, events, omitted, rejectedRoots, omittedRoots,
            maximumFailureEvents, maximumErrorMatches: 8, enabled})};
}
