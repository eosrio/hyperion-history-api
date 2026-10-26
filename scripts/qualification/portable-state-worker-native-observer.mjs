/** Read-only observations of actual production calls; no provider, decision, receipt or outcome substitution. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {createHash} from 'node:crypto';
import {openSync, writeSync, fsyncSync, closeSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {ProtocolNativeObservationStore} from '../../build/indexer/protocol/native-observation-store.js';
import {ActionSourceAdmissionStore} from '../../build/indexer/history/action-source-admission.js';
import {HyperionWorker} from '../../build/indexer/workers/hyperionWorker.js';
import {default as Deserializer} from '../../build/indexer/workers/deserializer.js';
import {actionHistoryImmutableJson} from '../../build/indexer/history/action-history-manifest.js';
import {UndiciConnection} from '@elastic/transport';
import {ProtocolAbiProofReader} from '../../build/indexer/protocol/abi-proof.js';
import {ImmutableProtocolBundleStore} from '../../build/indexer/protocol/immutable-bundle-store.js';
import {ObserverIoMetrics, installProofMetrics} from './portable-state-worker-proof-metrics.mjs';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {WorkerAttemptSupervisor} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {installProjectionDiagnostics} from './portable-state-projection-diagnostics.mjs';
import {installWorkerRejectionDiagnostics} from './worker-rejection-diagnostics.mjs';
import DSPool from '../../build/indexer/workers/ds-pool.js';
import StateReader from '../../build/indexer/workers/state-reader.js';
import ProjectionWorker from '../../build/indexer/workers/projection.js';

assert.equal(process.env.HYPERION_PORTABLE_NATIVE_QUALIFICATION, '1');
const chain = process.env.CHAIN_NAME;
assert.match(chain, /^hyp-p191-[0-9a-f]{12}$/);
const config = JSON.parse(readFileSync(process.env.CONFIG_JSON, 'utf8'));
assert.equal(config.settings.chain, chain);
assert.equal(config.settings.protocol.profileId, 'wire-sysio-6508c9e8-native-engineering-v1');
assert.equal(config.features.streaming.enable, false);
assert.equal(config.settings.protocol_abi_coordination?.recovery_window_blocks, undefined, 'default256 must remain in force');
assert.ok(isAbsolute(process.env.ES198_OBSERVER_DIR));
const directory = realpathSync(process.env.ES198_OBSERVER_DIR); assert.ok(statSync(directory).isDirectory());
const descriptor = openSync(join(directory, `native-${process.pid}.jsonl`), 'wx');
const hash = value => createHash('sha256').update(value).digest('hex');
let sequence = 0, bytes = 0;
const observerIo = new ObserverIoMetrics();
const record = (event, value) => {
    const line = JSON.stringify({kind: 'native_boundary', event, sequence: ++sequence, pid: process.pid,
        role: process.env.worker_role || 'master', monotonicNs: process.hrtime.bigint().toString(), ...value}) + '\n';
    bytes += Buffer.byteLength(line); assert.ok(bytes <= 24 * 1024 * 1024, 'native observer byte budget');
    observerIo.write(Buffer.byteLength(line), () => writeSync(descriptor, line));
    observerIo.sync(() => fsyncSync(descriptor));
};
record('start', {profileId: config.settings.protocol.profileId, observationOnly: true});
const proofMetrics = installProofMetrics({ProofReader: ProtocolAbiProofReader, BundleStore: ImmutableProtocolBundleStore,
    Connection: UndiciConnection, record});
const projectionDiagnostics = cluster.isPrimary || process.env.worker_role === 'projection'
    ? installProjectionDiagnostics({WorkerClient: WorkerAttemptClient, Supervisor: WorkerAttemptSupervisor,
        Master: cluster.isPrimary ? (await import('../../build/indexer/modules/master.js')).HyperionMaster : undefined, record})
    : undefined;
const rejectionDiagnostics = installWorkerRejectionDiagnostics({Pool: DSPool, Reader: StateReader, Projection: ProjectionWorker,
    WorkerClient: WorkerAttemptClient, WorkerHost: HyperionWorker,
    Master: cluster.isPrimary ? (await import('../../build/indexer/modules/master.js')).HyperionMaster : undefined,
    Supervisor: cluster.isPrimary ? WorkerAttemptSupervisor : undefined, cluster, record});
process.once('exit', () => {
    // Snapshot excludes this summary row and the following exit row's own writes/syncs.
    record('observer_metrics', {coverage: 'before-this-row', io: observerIo.snapshot(), proofs: proofMetrics.snapshot(),
        projectionDiagnostics: projectionDiagnostics?.snapshot(), rejectionDiagnostics: rejectionDiagnostics.snapshot()});
    record('exit', {bytes}); closeSync(descriptor);
    if (proofMetrics.snapshot().reportFailures || projectionDiagnostics?.snapshot().reportFailures || rejectionDiagnostics.snapshot().reportFailures) process.exitCode = 1;
});

const prepare = ProtocolNativeObservationStore.prototype.prepare;
ProtocolNativeObservationStore.prototype.prepare = async function (selectionId, input, ...args) {
    const origin = {selectionId, blockNum: input.source.blockNum, blockId: input.source.blockId,
        contextId: input.contextId, observationStatus: input.observation.status};
    record('native_prepare_begin', origin);
    const result = await prepare.call(this, selectionId, input, ...args);
    record('native_prepare_readback', {...origin, linkId: result.linkId,
        observationId: result.link.observationId, observationDigest: result.link.observationDigest});
    return result;
};
const admit = ActionSourceAdmissionStore.prototype.admit;
ActionSourceAdmissionStore.prototype.admit = async function (...args) {
    const result = await admit.apply(this, args);
    record('action_admitted', {admissionId: result.id, sourceId: result.sourceId, planId: result.planId,
        blockNum: result.source.inventoryInput.source.blockNum, blockId: result.source.inventoryInput.source.blockId,
        selectionId: result.source.inventoryInput.sourceSelectionId, target: result.target, producer: result.source.producer,
        incomplete: result.incomplete});
    return result;
};
const seal = ActionSourceAdmissionStore.prototype.trySeal;
ActionSourceAdmissionStore.prototype.trySeal = async function (admission, ...args) {
    const result = await seal.call(this, admission, ...args);
    record('action_seal_result', {admissionId: admission.id, blockNum: admission.source.inventoryInput.source.blockNum,
        planId: admission.planId, sealed: result}); return result;
};
const publication = HyperionWorker.prototype.publishAdmitted;
HyperionWorker.prototype.publishAdmitted = async function (owner, queue, content, headers, ...args) {
    const canonicalPayloadSha256 = queue.startsWith(chain + ':index_actions:')
        ? hash(actionHistoryImmutableJson(JSON.parse(content.toString()))) : undefined;
    if (canonicalPayloadSha256) assert.equal(canonicalPayloadSha256, hash(content), 'admitted production action bytes must be canonical');
    const origin = {queue, payloadSha256: hash(content), canonicalPayloadSha256, bytes: content.length, headers: structuredClone(headers)};
    record('admitted_publish_begin', origin);
    const result = await publication.call(this, owner, queue, content, headers, ...args);
    record('admitted_publish_confirmed', origin); return result;
};
// Confirmed action handoffs call the publication helper directly, bypassing publishAdmitted.
// Observe the actual owned AMQP send and its broker callback without replacing either result.
const actionPublicationOwner = HyperionWorker.prototype.actionPublicationOwner;
const observedPublishers = new WeakSet();
HyperionWorker.prototype.actionPublicationOwner = function (...args) {
    const owner = actionPublicationOwner.apply(this, args), publisher = owner.publisher;
    if (!observedPublishers.has(publisher)) {
        observedPublishers.add(publisher);
        const sendToQueue = publisher.sendToQueue;
        publisher.sendToQueue = function (queue, content, options, callback) {
            if (!queue.startsWith(chain + ':index_actions:'))
                return sendToQueue.call(this, queue, content, options, callback);
            assert.equal(typeof callback, 'function', 'admitted action publication requires a broker confirm callback');
            assert.equal(options.persistent, true); assert.equal(options.mandatory, true);
            const canonicalPayloadSha256 = hash(actionHistoryImmutableJson(JSON.parse(content.toString())));
            const payloadSha256 = hash(content);
            assert.equal(canonicalPayloadSha256, payloadSha256, 'admitted production action bytes must be canonical');
            const origin = {queue, payloadSha256, canonicalPayloadSha256, bytes: content.length,
                headers: structuredClone(options.headers), messageId: options.messageId,
                persistent: options.persistent, mandatory: options.mandatory};
            record('admitted_broker_publish_begin', origin);
            return sendToQueue.call(this, queue, content, options, error => {
                record(error ? 'admitted_broker_nack' : 'admitted_broker_confirmed',
                    error ? {...origin, error: String(error)} : origin);
                return callback(error);
            });
        };
    }
    return owner;
};
const sourceAck = Deserializer.prototype.ackAdmittedSourceDelivery;
Deserializer.prototype.ackAdmittedSourceDelivery = function (message, ...args) {
    const admission = this.activeActionSource?.admission;
    const origin = {headers: structuredClone(message.properties.headers), payloadSha256: hash(message.content),
        admissionId: admission?.id, blockNum: admission?.source.inventoryInput.source.blockNum};
    const result = sourceAck.call(this, message, ...args);
    record('source_ack_sent', origin); return result;
};
const channels = new WeakSet(), capture = HyperionWorker.prototype.captureActionAdmissionDelivery;
HyperionWorker.prototype.captureActionAdmissionDelivery = function (message, channel, ...args) {
    const result = capture.call(this, message, channel, ...args);
    if (!channels.has(channel)) {
        channels.add(channel); const ack = channel.ack;
        channel.ack = function (delivery, ...ackArgs) {
            const origin = {headers: structuredClone(delivery.properties.headers), payloadSha256: hash(delivery.content),
                deliveryTag: delivery.fields.deliveryTag};
            const result = ack.call(this, delivery, ...ackArgs); record('broker_ack_sent', origin); return result;
        };
    }
    return result;
};
