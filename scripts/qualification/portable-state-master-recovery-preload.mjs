/** Explicit master crash cut. The real supervisor, writes, broker ACKs and new-master adjudicator stay in use. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {createHash} from 'node:crypto';
import {readWireMasterRestartControl, createWireMasterRecorder, holdWireMasterEnd, readWireMasterRestartEvidence}
    from './portable-state-master-recovery.mjs';
import {describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {ActionAttemptAdjudicator} from '../../build/indexer/history/action-attempt-adjudicator.js';
import {actionHistoryImmutableJson} from '../../build/indexer/history/action-history-manifest.js';

assert.equal(process.env.HYPERION_PORTABLE_NATIVE_QUALIFICATION, '1');
assert.equal(process.env.ES198_CPU_PROFILE, '0');
const phase = process.env.ES198_WIRE_MASTER_PHASE;
const control = readWireMasterRestartControl(process.env.ES198_WIRE_MASTER_CONTROL, {
    observerDirectory: process.env.ES198_OBSERVER_DIR, chain: process.env.CHAIN_NAME, configFile: process.env.CONFIG_JSON, phase});
if (cluster.isPrimary) {
    const record = createWireMasterRecorder(control), selected = end => end.role === 'ds_pool_worker'
        && end.binding.blockNum === (phase === 'before' ? control.blockNum : control.resumeBlockNum)
        && end.binding.traceOrdinal === control.traceOrdinal;
    const physical = (adjudicator, end) => {
        const owners = [...adjudicator.supervisor.owners.values()].filter(value => value.incarnation === end.incarnation);
        assert.equal(owners.length, 1); const worker = owners[0].worker;
        assert.equal(owners[0].role, end.role);
        return {workerPid: worker.process.pid, workerId: worker.id};
    };
    const enqueue = ActionAttemptAdjudicator.prototype.enqueue, adjudicate = ActionAttemptAdjudicator.prototype.adjudicate;
    ActionAttemptAdjudicator.prototype.enqueue = function (evidence) {
        const end = describeWorkerAttemptEnd(this.supervisor, evidence);
        if (selected(end)) record('end', {phase, end, ...physical(this, end)});
        return enqueue.call(this, evidence);
    };
    let probed = false;
    ActionAttemptAdjudicator.prototype.adjudicate = async function (evidence) {
        const end = describeWorkerAttemptEnd(this.supervisor, evidence);
        if (phase === 'before' && selected(end)) {
            const owner = physical(this, end);
            if (holdWireMasterEnd(control, end, owner.workerPid, owner.workerId)) {
                record('held', {phase, end, ...owner});
                return new Promise(() => {});
            }
        }
        if (phase === 'after' && !probed) {
            probed = true;
            const prior = readWireMasterRestartEvidence(control).marker.end;
            const oldAssociationId = 'h45actionassociation1:' + createHash('sha256')
                .update(actionHistoryImmutableJson([prior.epoch, prior.incarnation, prior.attemptId])).digest('hex');
            try {
                const result = await adjudicate.call(this, structuredClone(prior));
                record('prior-end-probe', {phase, oldAssociationId, newEpoch: end.epoch, outcome: 'resolved', result});
            } catch (error) {
                record('prior-end-probe', {phase, oldAssociationId, newEpoch: end.epoch, outcome: 'rejected',
                    error: {name: error.name, message: error.message}});
            }
        }
        const result = await adjudicate.call(this, evidence);
        if (selected(end)) record('adjudicated', {phase, end, result});
        return result;
    };
}
