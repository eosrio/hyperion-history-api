/** Explicit owned-fixture fault only. Original callbacks, broker operations and stores remain in use. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {readWireRecoveryControl, createWireRecoveryRecorder, exitWireWorkerBeforeAck} from './portable-state-worker-recovery.mjs';
import {describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {ActionAttemptAdjudicator} from '../../build/indexer/history/action-attempt-adjudicator.js';
import {HyperionWorker} from '../../build/indexer/workers/hyperionWorker.js';
import DSPoolWorker from '../../build/indexer/workers/ds-pool.js';

assert.equal(process.env.HYPERION_PORTABLE_NATIVE_QUALIFICATION, '1');
assert.equal(process.env.ES198_CPU_PROFILE, '0', 'recovery fault must remain separate from CPU capture');
const control = readWireRecoveryControl(process.env.ES198_WIRE_RECOVERY_CONTROL, {
    observerDirectory: process.env.ES198_OBSERVER_DIR, chain: process.env.CHAIN_NAME, configFile: process.env.CONFIG_JSON});
const record = createWireRecoveryRecorder(control);
if (cluster.isPrimary) {
    const enqueue = ActionAttemptAdjudicator.prototype.enqueue, adjudicate = ActionAttemptAdjudicator.prototype.adjudicate;
    ActionAttemptAdjudicator.prototype.enqueue = function (evidence) {
        const end = describeWorkerAttemptEnd(this.supervisor, evidence);
        if (end.role === 'ds_pool_worker' && end.binding.blockNum === control.blockNum) record('end', {end});
        return enqueue.call(this, evidence);
    };
    ActionAttemptAdjudicator.prototype.adjudicate = async function (evidence) {
        const end = describeWorkerAttemptEnd(this.supervisor, evidence);
        const result = await adjudicate.call(this, evidence);
        if (end.role === 'ds_pool_worker' && end.binding.blockNum === control.blockNum) record('adjudicated', {end, result});
        return result;
    };
} else if (process.env.worker_role === 'ds_pool_worker') {
    const active = new AsyncLocalStorage(), channels = new WeakSet(), hash = value => createHash('sha256').update(value).digest('hex');
    const processMessages = DSPoolWorker.prototype.processMessages, begin = DSPoolWorker.prototype.beginActionAdmission;
    const observe = HyperionWorker.prototype.observeFreshActionWrite;
    DSPoolWorker.prototype.processMessages = function (...args) {
        return active.run({worker: this, message: undefined, freshId: undefined}, () => processMessages.apply(this, args));
    };
    HyperionWorker.prototype.observeFreshActionWrite = async function (result) {
        const accepted = await observe.call(this, result), context = active.getStore();
        if (context?.worker === this && this.activeActionAdmission?.admission.source.inventoryInput.source.blockNum === control.blockNum) {
            if (/^h45actionhandoff1:[0-9a-f]{64}$/.test(result.id)) {assert.equal(accepted, true); context.freshId = result.id;}
        }
        return accepted;
    };
    DSPoolWorker.prototype.beginActionAdmission = async function (message, ...args) {
        const result = await begin.call(this, message, ...args), context = active.getStore();
        assert.equal(context?.worker, this); context.message = message; context.freshId = undefined;
        const channel = this.activeActionAdmission.owner.consumer;
        if (!channels.has(channel)) {
            channels.add(channel); const ack = channel.ack;
            channel.ack = function (delivery, ...ackArgs) {
                const current = active.getStore(), worker = current?.worker, scope = worker?.activeActionAdmission;
                assert.ok(scope && current.message === delivery && scope.owner.consumer === this);
                if (scope.admission.source.inventoryInput.source.blockNum !== control.blockNum)
                    return ack.call(this, delivery, ...ackArgs);
                assert.equal(scope.owner.current(), true); assert.equal(worker.chain, control.chain);
                assert.ok(scope.payload.equals(delivery.content));
                if (!current.freshId) return ack.call(this, delivery, ...ackArgs);
                const captured = worker.workerAttemptDeliveries.get(delivery);
                assert.ok(captured); const attempt = worker.workerAttemptClient.describe(captured.handle);
                const snapshot = {role: process.env.worker_role, workerId: process.env.worker_id,
                    admissionId: scope.admission.id, traceOrdinal: scope.traceOrdinal,
                    payloadSha256: hash(delivery.content), source: scope.admission.source.inventoryInput.source,
                    originalFrameSha256: hash(Buffer.from(scope.admission.source.frameHex, 'hex')),
                    redelivered: delivery.fields.redelivered, deliveryTag: delivery.fields.deliveryTag,
                    freshId: current.freshId, attempt};
                // A replacement sees the marker and uses the original ACK; no NACK or synthetic redelivery.
                if (!delivery.fields.redelivered) exitWireWorkerBeforeAck(control, snapshot);
                record('ack-intent', snapshot);
                const acknowledged = ack.call(this, delivery, ...ackArgs);
                record('ack-sent', snapshot); return acknowledged;
            };
        }
        return result;
    };
}
