/** Explicit test-only hold of an actual handoff manifest response; never races cancellation to completion. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {Client} from '@elastic/elasticsearch';
import {readWireBrokerRecoveryControl, createWireBrokerRecorder, wireBrokerRecoveryDigest,
    assertWireBrokerHeldReceipt, awaitWireBrokerReceiptRelease} from './portable-state-broker-recovery.mjs';
import {durableRecoveryFile} from './recovery-custody.mjs';
import {describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {currentProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';
import {ActionAttemptAdjudicator} from '../../build/indexer/history/action-attempt-adjudicator.js';
import {ActionSourceAdmissionStore} from '../../build/indexer/history/action-source-admission.js';
import {HyperionWorker} from '../../build/indexer/workers/hyperionWorker.js';
import DSPoolWorker from '../../build/indexer/workers/ds-pool.js';

assert.equal(process.env.HYPERION_PORTABLE_NATIVE_QUALIFICATION, '1');
assert.equal(process.env.ES198_CPU_PROFILE, '0'); assert.equal(process.platform, 'linux');
assert.ok(!process.versions.bun && /^(24|26)\./.test(process.versions.node));
const control = readWireBrokerRecoveryControl(process.env.ES198_WIRE_BROKER_CONTROL, {
    observerDirectory: process.env.ES198_OBSERVER_DIR, chain: process.env.CHAIN_NAME, configFile: process.env.CONFIG_JSON});
const record = createWireBrokerRecorder(control), hash = value => createHash('sha256').update(value).digest('hex');
const selected = end => end.role === 'ds_pool_worker' && end.binding.blockNum === control.blockNum
    && end.binding.traceOrdinal === control.traceOrdinal;
if (cluster.isPrimary) {
    const enqueue = ActionAttemptAdjudicator.prototype.enqueue, adjudicate = ActionAttemptAdjudicator.prototype.adjudicate;
    ActionAttemptAdjudicator.prototype.enqueue = function (evidence) {
        const end = describeWorkerAttemptEnd(this.supervisor, evidence);
        if (selected(end)) record('end', {end}); return enqueue.call(this, evidence);
    };
    ActionAttemptAdjudicator.prototype.adjudicate = async function (evidence) {
        const end = describeWorkerAttemptEnd(this.supervisor, evidence);
        try {
            const result = await adjudicate.call(this, evidence);
            if (selected(end)) record('adjudicated', {end, result}); return result;
        } catch (error) {
            if (selected(end)) record('adjudication-rejected', {end, error: String(error).slice(0, 4096)});
            throw error;
        }
    };
} else if (process.env.worker_role === 'ds_pool_worker') {
    const active = new AsyncLocalStorage(), channels = new WeakSet(), connections = new WeakSet();
    const processMessages = DSPoolWorker.prototype.processMessages, begin = DSPoolWorker.prototype.beginActionAdmission;
    const observe = HyperionWorker.prototype.observeFreshActionWrite, handoff = ActionSourceAdmissionStore.prototype.recordConfirmedHandoff;
    DSPoolWorker.prototype.processMessages = function (...args) {
        return active.run({worker: this, message: undefined}, () => processMessages.apply(this, args));
    };
    const snapshot = context => {
        const worker = context.worker, delivery = context.message, scope = worker.activeActionAdmission;
        assert.ok(scope && delivery && scope.payload.equals(delivery.content));
        const captured = worker.workerAttemptDeliveries.get(delivery); assert.ok(captured);
        return {role: process.env.worker_role, workerId: process.env.worker_id, admissionId: scope.admission.id,
            traceOrdinal: scope.traceOrdinal, payloadSha256: hash(delivery.content), source: scope.admission.source.inventoryInput.source,
            originalFrameSha256: hash(Buffer.from(scope.admission.source.frameHex, 'hex')),
            redelivered: delivery.fields.redelivered, deliveryTag: delivery.fields.deliveryTag,
            attempt: worker.workerAttemptClient.describe(captured.handle)};
    };
    DSPoolWorker.prototype.beginActionAdmission = async function (message, ...args) {
        const result = await begin.call(this, message, ...args), context = active.getStore();
        assert.equal(context?.worker, this); context.message = message;
        const owner = this.activeActionAdmission.owner;
        for (const [kind, channel] of [['consumer', owner.consumer], ['publisher', owner.publisher]]) {
            if (channels.has(channel)) continue;
            channels.add(channel);
            const original = channel.ack;
            channel.ack = function (delivery, ...ackArgs) {
                const current = active.getStore();
                const chosen = current?.message === delivery && current.worker.activeActionAdmission?.admission.source.inventoryInput.source.blockNum === control.blockNum;
                const view = chosen ? snapshot(current) : undefined;
                if (view) record('ack-intent', view);
                const returned = original.call(this, delivery, ...ackArgs);
                if (view) record('ack-sent', view); return returned;
            };
            channel.once('close', () => record('channel-close', {kind, workerId: process.env.worker_id}));
            channel.once('error', error => record('channel-error', {kind, error: String(error).slice(0, 4096)}));
            if (channel.connection && !connections.has(channel.connection)) {
                connections.add(channel.connection);
                channel.connection.once('close', () => record('connection-close', {workerId: process.env.worker_id}));
            }
        }
        return result;
    };
    HyperionWorker.prototype.observeFreshActionWrite = async function (result) {
        const context = active.getStore(), chosen = context?.worker === this
            && this.activeActionAdmission?.admission.source.inventoryInput.source.blockNum === control.blockNum;
        if (chosen) record('fresh-observation-attempt', {...snapshot(context), recordId: result.id});
        const accepted = await observe.call(this, result);
        if (chosen) record('fresh-observation-return', {...snapshot(context), recordId: result.id, accepted});
        return accepted;
    };
    ActionSourceAdmissionStore.prototype.recordConfirmedHandoff = function (input, ...args) {
        const context = active.getStore(), scope = context?.worker.activeActionAdmission;
        if (!scope || scope.admission.source.inventoryInput.source.blockNum !== control.blockNum)
            return handoff.call(this, input, ...args);
        assert.equal(input.owner, scope.owner); assert.equal(input.publications, scope.handoff.publications);
        assert.ok(input.publications.length > 0); assert.equal(scope.owner.current(), true);
        return active.run({...context, handoff: input}, () => handoff.call(this, input, ...args));
    };
    for (const method of ['create', 'index']) {
        const original = Client.prototype[method];
        Client.prototype[method] = async function (request, ...args) {
            const context = active.getStore();
            const chosen = context?.handoff && request?.index === control.chain + '-history-source-admission-v1'
                && request.document?.kind === 'manifest' && /^h45actionhandoff1:[a-f0-9]{64}$/.test(request.id);
            const response = await original.call(this, request, ...args);
            if (!chosen) return response;
            const scope = currentProofConsumerScope(true), view = snapshot(context);
            const held = {schemaVersion: 1, runId: control.runId, controlSha256: wireBrokerRecoveryDigest(control),
                ...view, pid: process.pid, parentPid: process.ppid, at: Date.now(), method,
                recordId: request.id, request, response, scope: scope.snapshot()};
            // The marker is exclusive across physical DS workers. A later retry uses the original transport normally.
            try {durableRecoveryFile(join(control.output, 'broker-recovery/held-receipt.json'), assertWireBrokerHeldReceipt(control, held));}
            catch (error) {if (error.code === 'EEXIST') return response; throw error;}
            let returned = false;
            const fenced = () => record('held-attempt-fenced', {attemptId: view.attempt.attemptId,
                scope: scope.snapshot(), returned, attempt: context.worker.workerAttemptClient.describe(
                    context.worker.workerAttemptDeliveries.get(context.message).handle)});
            scope.signal.addEventListener('abort', fenced, {once: true});
            record('handoff-receipt-held', held);
            try {
                await awaitWireBrokerReceiptRelease(control);
                record('handoff-receipt-released', {attemptId: view.attempt.attemptId, scope: scope.snapshot(),
                    ownerCurrent: context.handoff.owner.current(), returned});
                return response;
            } finally {returned = true; scope.signal.removeEventListener('abort', fenced);}
        };
    }
}
