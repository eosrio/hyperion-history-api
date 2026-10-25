/** Bounded custody for the original block-33 handoff receipt and one owned broker restart. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {errorMonitor} from 'node:events';
import {mkdirSync, realpathSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {boundedRecoveryFile, durableRecoveryFile, createRecoveryRecorder, readRecoveryRecords} from './recovery-custody.mjs';

const chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d';
const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
const controls = new WeakSet();
export const wireBrokerRecoveryDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const directory = control => join(control.output, 'broker-recovery');

export function createWireBrokerRecoveryControl({output, configFile, chain, source, frameSha256}) {
    assert.equal(realpathSync(output), resolve(output)); assert.equal(resolve(configFile), join(output, 'chain.json'));
    assert.match(chain, /^hyp-p191-[a-f0-9]{12}$/);
    assert.equal(source.chainId, chainId); assert.equal(source.profileId, profileId); assert.equal(source.endBlock, 1480);
    assert.match(frameSha256, /^[a-f0-9]{64}$/); assert.match(source.records[32].blockId, /^[a-f0-9]{64}$/);
    const control = Object.freeze({schemaVersion: 1, kind: 'wire-broker-restart', runId: randomUUID(),
        output, configFile: resolve(configFile), configSha256: wireBrokerRecoveryDigest(boundedRecoveryFile(configFile, 1024 * 1024).toString()),
        chain, chainId, profileId, blockNum: 33, blockId: source.records[32].blockId, traceOrdinal: 0, frameSha256});
    mkdirSync(directory(control)); const file = join(directory(control), 'control.json');
    durableRecoveryFile(file, control); controls.add(control); return {file, control};
}
export function readWireBrokerRecoveryControl(file, {observerDirectory, chain, configFile}) {
    const observer = realpathSync(observerDirectory), output = dirname(dirname(observer));
    assert.equal(observer, join(output, 'observer/master'));
    assert.equal(resolve(file), join(output, 'broker-recovery/control.json'));
    assert.equal(realpathSync(dirname(file)), dirname(resolve(file)));
    const control = JSON.parse(boundedRecoveryFile(file, 16384).toString());
    assert.equal(control.schemaVersion, 1); assert.equal(control.kind, 'wire-broker-restart');
    assert.match(control.runId, /^[a-f0-9-]{36}$/);
    assert.equal(control.output, output); assert.equal(control.configFile, resolve(configFile));
    assert.equal(control.configFile, join(output, 'chain.json')); assert.equal(control.chain, chain);
    assert.match(chain, /^hyp-p191-[a-f0-9]{12}$/);
    assert.equal(control.chainId, chainId); assert.equal(control.profileId, profileId);
    assert.equal(control.blockNum, 33); assert.equal(control.traceOrdinal, 0);
    assert.match(control.blockId, /^[a-f0-9]{64}$/); assert.match(control.frameSha256, /^[a-f0-9]{64}$/);
    const configBytes = boundedRecoveryFile(configFile, 1024 * 1024).toString(), config = JSON.parse(configBytes);
    assert.equal(control.configSha256, wireBrokerRecoveryDigest(configBytes));
    assert.equal(config.settings.chain, chain); assert.equal(config.settings.protocol.profileId, profileId);
    assert.equal(config.settings.protocol_abi_coordination?.recovery_window_blocks, undefined);
    return control;
}
export const createWireBrokerRecorder = control => createRecoveryRecorder(directory(control), control.runId);
export function describeIssuedWireBrokerControl(control) {
    assert.ok(controls.has(control), 'unissued broker recovery control');
    assert.deepEqual(JSON.parse(boundedRecoveryFile(join(directory(control), 'control.json'), 16384).toString()), control);
    assert.equal(wireBrokerRecoveryDigest(boundedRecoveryFile(control.configFile, 1024 * 1024).toString()), control.configSha256);
    return structuredClone(control);
}
/** An observer must preserve both the original handled-error path and native unhandled-error exit. */
export function observeWireBrokerChannelEvents(channel, kind, record) {
    assert.ok(['consumer', 'publisher'].includes(kind));
    channel.once('close', () => record('channel-close', {kind, workerId: process.env.worker_id}));
    channel.once(errorMonitor, error => record('channel-error', {kind, error: String(error).slice(0, 4096)}));
}
export function readWireBrokerRecoveryEvidence(control) {
    return {held: JSON.parse(boundedRecoveryFile(join(directory(control), 'held-receipt.json'), 128 * 1024).toString()),
        events: readRecoveryRecords(directory(control), control.runId, ['control.json', 'held-receipt.json', 'release-receipt.json'])};
}
export function assertWireBrokerHeldReceipt(control, held) {
    assert.equal(held.schemaVersion, 1);
    assert.equal(held.runId, control.runId); assert.equal(held.controlSha256, wireBrokerRecoveryDigest(control));
    assert.equal(held.role, 'ds_pool_worker'); assert.equal(held.source.blockNum, control.blockNum);
    assert.equal(held.source.blockId, control.blockId); assert.equal(held.source.chainId, control.chainId);
    assert.equal(held.originalFrameSha256, control.frameSha256); assert.equal(held.admissionId, held.attempt.binding.admissionId);
    assert.equal(held.traceOrdinal, control.traceOrdinal); assert.equal(held.attempt.binding.traceOrdinal, control.traceOrdinal);
    assert.equal(held.attempt.binding.blockNum, control.blockNum); assert.equal(held.attempt.binding.blockId, control.blockId);
    assert.equal(held.payloadSha256, held.attempt.descriptor.payloadSha256);
    assert.equal(held.redelivered, false); assert.equal(held.attempt.mode, 'managed'); assert.equal(held.attempt.masterEnd, null);
    // The awaited store call belongs to the still-running root; counts alone never issue an end.
    assert.equal(held.scope.state, 'open'); assert.ok(Number.isSafeInteger(held.scope.pendingOperations) && held.scope.pendingOperations >= 0);
    assert.deepEqual(held.scope, held.attempt.scope); assert.match(held.recordId, /^h45actionhandoff1:[a-f0-9]{64}$/);
    assert.equal(held.request.index, control.chain + '-history-source-admission-v1');
    assert.equal(held.request.id, held.recordId); assert.equal(held.request.document.kind, 'manifest');
    assert.equal(held.request.document.bundle_id, held.recordId); assert.equal(held.request.wait_for_active_shards, 'all');
    assert.equal(held.request.pipeline, '_none'); assert.equal(held.request.refresh, false);
    assert.ok(['create', 'index'].includes(held.method));
    assert.ok(Number.isSafeInteger(held.pid) && held.pid > 0 && Number.isSafeInteger(held.parentPid) && held.parentPid > 0);
    assert.equal(held.response._id, held.recordId); assert.equal(held.response._index, held.request.index);
    assert.equal(held.response.result, held.method === 'create' ? 'created' : 'updated');
    assert.ok(held.response._shards.total === 2 && held.response._shards.failed === 0
        && held.response._shards.successful === held.response._shards.total);
    return held;
}
export function releaseWireBrokerReceipt(control) {
    assert.ok(controls.has(control), 'unissued broker recovery control');
    durableRecoveryFile(join(directory(control), 'release-receipt.json'), {runId: control.runId,
        controlSha256: wireBrokerRecoveryDigest(control), at: Date.now()});
}
/** No AbortSignal or cancellation race: the original awaited receipt remains owned until release/owner exit. */
export async function awaitWireBrokerReceiptRelease(control) {
    for (;;) {
        let release;
        try {release = JSON.parse(boundedRecoveryFile(join(directory(control), 'release-receipt.json'), 16384).toString());}
        catch (error) {if (error.code !== 'ENOENT') throw error;}
        if (release) {
            assert.equal(release.runId, control.runId); assert.equal(release.controlSha256, wireBrokerRecoveryDigest(control));
            return;
        }
        await pause(50);
    }
}
/** Read-only counters are scoped to their observed process incarnation, never reconstructed as one broker total. */
export function auditWireBrokerSourceCounterWindows({chain, through, restart, before, after}) {
    assert.match(chain, /^hyp-p191-[a-f0-9]{12}$/); assert.ok(Number.isSafeInteger(through) && through > 33 && through <= 1480);
    assert.equal(restart.kind, 'owned-wire-broker-restart-observed');
    assert.equal(restart.before.broker.containerId, restart.after.broker.containerId);
    assert.notEqual(restart.before.broker.startedAt, restart.after.broker.startedAt);
    assert.ok(restart.before.process.pid !== restart.after.process.pid || restart.before.process.startTicks !== restart.after.process.startTicks);
    const window = (rows, identity, expected) => {
        assert.ok(rows.length > 0 && rows.length <= 4096);
        const selected = rows.filter(row => row.name === chain + ':live_blocks'); assert.equal(selected.length, 1);
        const row = selected[0];
        assert.equal(row.ack, expected); assert.equal(row.delivered, expected); assert.equal(row.redelivered, 0);
        assert.equal(row.ready, 0); assert.equal(row.unacked, 0); assert.equal(row.messages, 0);
        return {containerId: identity.broker.containerId, startedAt: identity.broker.startedAt,
            process: identity.process, expectedDeliveries: expected, sourceQueue: structuredClone(row)};
    };
    return {before: window(before, restart.before, 33), after: window(after, restart.after, through - 33),
        brokerSettlement: 'unknown', sourceAuthority: false, capacityAcceptance: false};
}
