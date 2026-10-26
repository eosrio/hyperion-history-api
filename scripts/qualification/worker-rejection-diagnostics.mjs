import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {serialize} from 'node:v8';
import assert from 'node:assert/strict';
import {installWorkerFenceDiagnostics} from './worker-fence-diagnostics.mjs';
import {installWorkerFailureDiagnostics} from './worker-failure-diagnostics.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function physical(pid) {
    // A birth tick is observed from this exact process, never synthesized from a timestamp/PID.
    const birthTicks = process.platform === 'linux'
        ? readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19] : null;
    if (birthTicks !== null && !/^[1-9][0-9]*$/.test(birthTicks)) throw new Error('Physical worker birth is unavailable');
    return {pid, birthTicks, birthObservation: birthTicks === null ? 'unsupported-platform' : 'proc-stat'};
}

/** Qualification observations only. No fault membership, retry, ACK, end, restart or shutdown authority. */
export function installWorkerRejectionDiagnostics({Pool, Reader, Projection, Supervisor, WorkerClient, WorkerHost, Master, cluster, record, maximumRejections = 32,
    maximumPendingPublications = 64, maximumWorkers = 256, maximumFenceEvents = 1024}) {
    for (const limit of [maximumRejections, maximumPendingPublications, maximumWorkers])
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('Invalid rejection diagnostic bounds');
    const channelIds = new WeakMap(), publishers = new WeakSet(), pending = new Map(), workers = new WeakSet(), rejected = new WeakSet();
    const incarnation = randomUUID();
    const workerIdentities = new WeakMap();
    const workerIdentity = worker => {
        let identity = workerIdentities.get(worker);
        if (!identity) {identity = physical(worker.process.pid); workerIdentities.set(worker, identity);}
        return identity;
    };
    let rejections = 0, workerCount = 0, reportFailures = 0, omittedRejections = 0;
    const channelId = channel => {
        if (!channel) return null;
        let value = channelIds.get(channel);
        if (!value) {value = randomUUID(); channelIds.set(channel, value);} return value;
    };
    const emit = (event, snapshot) => {
        try {
            const value = {observationOnly: true, physical: physical(process.pid), parentPid: process.ppid,
                diagnosticIncarnation: incarnation, ...snapshot()};
            const bytes = JSON.stringify(value);
            if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error('Rejection diagnostic row exceeds its byte bound');
            record(event, JSON.parse(bytes));
        } catch {reportFailures++;}
    };
    const rejection = (event, snapshot) => {
        if (rejections++ >= maximumRejections) {omittedRejections++; reportFailures++; return;}
        emit(event, snapshot);
    };
    const fences = installWorkerFenceDiagnostics({WorkerClient, WorkerHost, Supervisor, Master, emit, physical, workerIdentity,
        failed: () => {reportFailures++;}, maximumFenceEvents});
    const reject = Pool.prototype.rejectActionAdmission;
    Pool.prototype.rejectActionAdmission = function(reason, decision) {
        rejection('action_admission_rejected', () => {
            const {message, admission, epoch, owner, predicate} = decision;
            const client = this.workerAttemptClient, retained = this.workerAttemptDeliveries?.get(message);
            if (!retained) throw new Error('Original rejected delivery custody is unavailable');
            const attempt = client.describe(retained.handle);
            const source = admission.source.inventoryInput;
            return {reason, predicate, actual: decision.actual, expected: decision.expected, operandFormat: decision.operandFormat,
                attempt, fenceOrigin: fences.describe(client, retained.handle),
                parentEpoch: client.authority?.epoch ?? null, parentIncarnation: client.authority?.incarnation ?? null,
                workerId: process.env.worker_id ?? null, originalConsumerId: attempt.descriptor.consumerId,
                originalPublisherId: attempt.descriptor.publisherId,
                currentConsumerId: this.workerAttemptChannels?.get(this.ch) ?? null,
                currentPublisherId: this.workerAttemptChannels?.get(this.cch) ?? null,
                consumerReady: this.ch_ready, publisherReady: this.cch_ready,
                ownerConsumerIsCurrent: owner.consumer === this.ch, ownerPublisherIsCurrent: owner.publisher === this.cch,
                originalConsumerIsCurrent: retained.consumer === this.ch,
                delivery: {payloadSha256: retained.payloadSha256, headersSha256: retained.headersSha256,
                    currentPayloadSha256: hash(message.content), deliveryTag: message.fields?.deliveryTag ?? null,
                    redelivered: message.fields?.redelivered ?? null},
                admission: {id: admission.id, planId: admission.planId, source: source.source,
                    selectionId: source.sourceSelectionId ?? null, target: admission.target,
                    producer: admission.source.producer, executableSha256: admission.source.executableSha256,
                    originalFrameSha256: typeof admission.source.frameHex === 'string' ? hash(Buffer.from(admission.source.frameHex, 'hex')) : null},
                epoch: {producer: epoch.producer, executableSha256: epoch.executableSha256, configurationSha256: hash(epoch.configuration)}};
        });
        try {return reject.call(this, reason, decision);}
        catch (error) {rejected.add(error); throw error;}
    };
    const begin = Pool.prototype.beginActionAdmission;
    Pool.prototype.beginActionAdmission = async function(message, ...args) {
        try {return await begin.call(this, message, ...args);}
        catch (error) {
            if (!rejected.has(error)) rejection('action_admission_threw', () => {
                const retained = this.workerAttemptDeliveries?.get(message);
                return {boundary: 'beginActionAdmission', predicate: null,
                    error: {name: error?.name?.slice(0, 128), message: error?.message?.slice(0, 1024)},
                    attempt: retained ? this.workerAttemptClient.describe(retained.handle) : null,
                    parentEpoch: this.workerAttemptClient?.authority?.epoch ?? null,
                    parentIncarnation: this.workerAttemptClient?.authority?.incarnation ?? null,
                    currentConsumerId: this.workerAttemptChannels?.get(this.ch) ?? null,
                    currentPublisherId: this.workerAttemptChannels?.get(this.cch) ?? null,
                    consumerReady: this.ch_ready, publisherReady: this.cch_ready};
            });
            throw error;
        }
    };
    const observePublisher = publisher => {
        if (!publisher || publishers.has(publisher)) return;
        publishers.add(publisher); channelId(publisher);
        const send = publisher.sendToQueue;
        publisher.sendToQueue = function(queue, content, options, callback) {
            let token;
            try {
                if (pending.size >= maximumPendingPublications) throw new Error('Pending publication diagnostic budget exhausted');
                token = {};
                const headers = serialize(options?.headers ?? {});
                if (headers.length > 64 * 1024) throw new Error('Publication header diagnostic budget exhausted');
                pending.set(token, {publisherId: channelId(this), queue, payloadSha256: hash(content), payloadBytes: content.length,
                    headersSha256: hash(headers), headersBytes: headers.length,
                    blockNum: options?.headers?.block_num ?? null, blockId: options?.headers?.block_id ?? null,
                    sourceIngressId: options?.headers?.['hyperion-action-source-v1'] ?? null, confirmation: 'unknown'});
            } catch {reportFailures++;}
            try {
                return send.call(this, queue, content, options, typeof callback === 'function' ? (...args) => {
                    // Retain the original confirmation while its original callback makes the failure decision.
                    const receipt = pending.get(token);
                    if (receipt) receipt.confirmation = args[0] ? 'failed' : 'confirmed';
                    try {return callback(...args);} finally {pending.delete(token);}
                } : callback);
            } catch (error) {
                const receipt = pending.get(token); if (receipt) receipt.confirmation = 'send-threw-unknown';
                throw error;
            }
        };
    };
    const queues = Reader.prototype.assertQueues;
    Reader.prototype.assertQueues = function(...args) {
        try {observePublisher(this.cch);} catch {reportFailures++;}
        return queues.apply(this, args);
    };
    const recover = Reader.prototype.failPublisherRecovery;
    Reader.prototype.failPublisherRecovery = function(reason, decision) {
        if (!this.publisherFailure) rejection('reader_publisher_recovery_required', () => ({
            reason, predicate: decision.predicate, failureDecisionId: failures.describeReaderDecision(this)?.id ?? null,
            callbackPublisherId: channelId(decision.publisher),
            callbackPublisherIsCurrent: !!decision.publisher && decision.publisher === this.cch,
            currentPublisherId: channelId(this.cch), publisherReady: this.cch_ready,
            blockNum: decision.blockNum ?? null, assignmentId: this.assignmentId ?? null,
            sourceContext: this.sourceContext ? {id: this.sourceContext.id, readerSessionId: this.sourceContext.readerSessionId,
                generation: this.sourceContext.generation ?? null, schemaSha256: hash(this.sourceContext.schemaJson)} : null,
            coordinatorSource: this.coordinatorSource ?? null,
            socketGeneration: this.socketGeneration, activeIngressGeneration: this.activeIngressGeneration ?? null,
            verifiedReaderSessionId: this.verifiedReaderSessionId ?? null,
            pendingConfirmations: this.publications?.size ?? 0, originalPublications: [...pending.values()]}));
        return recover.call(this, reason, decision);
    };
    if (cluster?.isPrimary) cluster.on('fork', worker => {
        if (workers.has(worker)) return;
        workers.add(worker);
        if (++workerCount > maximumWorkers) {reportFailures++; return;}
        let identity;
        emit('physical_worker_forked', () => ({workerId: worker.id, child: identity = workerIdentity(worker)}));
        worker.once('exit', (code, signal) => emit('physical_worker_exited', () => ({workerId: worker.id, child: identity ?? null, code, signal})));
    });
    if (Supervisor) {
        const attached = new WeakSet(), attach = Supervisor.prototype.attach;
        Supervisor.prototype.attach = function(worker, role) {
            const result = attach.call(this, worker, role);
            if (!attached.has(worker)) {
                attached.add(worker);
                emit('attempt_owner_attached', () => ({role, workerId: worker.id, child: workerIdentity(worker),
                    parentEpoch: this.epoch, parentIncarnation: this.owners.get(worker).incarnation}));
            }
            return result;
        };
    }
    const failures = installWorkerFailureDiagnostics({Pool, Reader, Projection, WorkerClient, Master, Supervisor, cluster,
        emit, physical, workerIdentity, failed: () => {reportFailures++;}});
    return {snapshot: () => ({observationOnly: true, rejections, omittedRejections, workerCount,
        pendingPublications: pending.size, reportFailures, maximumRejections, maximumPendingPublications, maximumWorkers,
        fences: fences.snapshot(), failures: failures.snapshot()})};
}

/** Capture integrity only. Successful validation never changes or excuses a raw worker outcome. */
export function auditWorkerRejectionDiagnostics(rows, primaryPid) {
    const validPid = pid => Number.isSafeInteger(pid) && pid > 0;
    assert.ok(validPid(primaryPid), 'Original primary PID is required for diagnostic coverage');
    const expected = new Set([primaryPid]), starts = new Set(), pids = new Set(), summaries = [];
    for (const row of rows) {
        if (row.kind === 'start') {assert.ok(validPid(row.pid)); expected.add(row.pid);}
        if (row.kind === 'worker_fork') {assert.ok(validPid(row.childPid)); expected.add(row.childPid);}
        if (row.kind === 'native_boundary' && row.event === 'start') {
            assert.ok(validPid(row.pid) && !starts.has(row.pid), 'Duplicated or invalid native diagnostic start'); starts.add(row.pid);
        }
    }
    assert.ok(expected.size <= 64 && starts.size <= 64, 'Diagnostic process census exceeds its existing bound');
    for (const row of rows.filter(value => value.kind === 'native_boundary' && value.event === 'observer_metrics')) {
        assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0 && !pids.has(row.pid), 'Duplicated or invalid rejection diagnostic process');
        pids.add(row.pid);
        const value = row.rejectionDiagnostics;
        assert.equal(value?.observationOnly, true, 'Rejection diagnostic summary is unavailable');
        assert.equal(value.maximumRejections, 32); assert.equal(value.maximumPendingPublications, 64); assert.equal(value.maximumWorkers, 256);
        assert.equal(value.reportFailures, 0, 'Worker rejection diagnostic capture failed');
        assert.equal(value.omittedRejections, 0, 'Worker rejection diagnostic decisions were omitted');
        assert.equal(value.fences?.maximumFenceEvents, 1024, 'Fence diagnostic bounds are unavailable or changed');
        assert.equal(value.fences?.membersPerRow, 32, 'Fence diagnostic member bound changed');
        assert.equal(value.fences?.omitted, 0, 'Worker fence diagnostic events were omitted');
        assert.equal(value.failures?.maximumFailureEvents, 128, 'Failure diagnostic bounds are unavailable or changed');
        assert.equal(value.failures?.maximumErrorMatches, 8, 'Failure error-object match bound changed');
        assert.equal(value.failures?.omitted, 0, 'Worker failure diagnostic events were omitted');
        assert.equal(value.failures?.omittedRoots, 0, 'Worker failure diagnostic roots were omitted');
        for (const key of ['root', 'attempts', 'pool', 'reader', 'projection', ...(row.pid === primaryPid ? ['master', 'cluster', 'supervisor'] : [])])
            assert.equal(value.failures?.enabled?.[key], true, `Worker failure diagnostic ${key} is unavailable`);
        for (const key of ['client', 'host', ...(row.pid === primaryPid ? ['supervisor', 'master'] : [])])
            assert.equal(value.fences?.enabled?.[key], true, `Worker fence diagnostic ${key} is unavailable`);
        summaries.push({pid: row.pid, ...value});
    }
    const processes = [...new Set([...expected, ...starts, ...pids])].sort((a, b) => a - b).map(pid => ({pid,
        missing: [...(!expected.has(pid) ? ['physical-census-membership'] : []),
            ...(!starts.has(pid) ? ['native-start'] : []), ...(!pids.has(pid) ? ['diagnostic-summary'] : [])]}));
    return {status: processes.some(value => value.missing.length) ? 'incomplete' : 'complete', processes, summaries};
}
