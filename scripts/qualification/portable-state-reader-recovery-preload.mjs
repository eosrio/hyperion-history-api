/** Explicit held-RPC/owned-reader fault. Normal master, reader, source opening and adjudication remain in use. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {AsyncLocalStorage} from 'node:async_hooks';
import {join} from 'node:path';
import {readWireReaderRecoveryControl, createWireReaderRecorder, wireReaderControlDigest} from './portable-state-reader-recovery.mjs';
import {durableRecoveryFile} from './recovery-custody.mjs';
import {assertWireRecoveryEnd} from './wire-recovery-end-audit.mjs';
import {installWireReaderRecoveryHost} from './wire-reader-recovery-host.mjs';

assert.equal(process.env.HYPERION_PORTABLE_NATIVE_QUALIFICATION, '1'); assert.equal(process.env.ES198_CPU_PROFILE, '0');
const control = readWireReaderRecoveryControl(process.env.ES198_WIRE_READER_CONTROL, {
    observerDirectory: process.env.ES198_OBSERVER_DIR, chain: process.env.CHAIN_NAME, configFile: process.env.CONFIG_JSON});
if (cluster.isPrimary) {
    const [{describeWorkerAttemptEnd}, {ActionAttemptAdjudicator}, {HyperionMaster}] = await Promise.all([
        import('../../build/indexer/protocol/worker-attempt-supervisor.js'),
        import('../../build/indexer/history/action-attempt-adjudicator.js'), import('../../build/indexer/modules/master.js')]);
    const active = new AsyncLocalStorage(), owners = new WeakMap(), record = createWireReaderRecorder(control);
    let held;
    const selected = end => end.role === 'ds_pool_worker' && [control.blockNum, control.resumeBlockNum].includes(end.binding.blockNum)
        && end.binding.traceOrdinal === control.traceOrdinal;
    const factory = HyperionMaster.prototype.attemptAdjudicatorFor;
    HyperionMaster.prototype.attemptAdjudicatorFor = function (...args) {
        const adjudicator = factory.apply(this, args); owners.set(adjudicator, this); return adjudicator;
    };
    const enqueue = ActionAttemptAdjudicator.prototype.enqueue, adjudicate = ActionAttemptAdjudicator.prototype.adjudicate;
    ActionAttemptAdjudicator.prototype.enqueue = function (evidence) {
        const end = describeWorkerAttemptEnd(this.supervisor, evidence);
        if (selected(end)) record('end', {end}); return enqueue.call(this, evidence);
    };
    ActionAttemptAdjudicator.prototype.adjudicate = async function (evidence) {
        const end = describeWorkerAttemptEnd(this.supervisor, evidence), master = owners.get(this);
        try {
            const result = await active.run({end, master}, () => adjudicate.call(this, evidence));
            if (selected(end)) record('adjudicated', {end, result}); return result;
        } catch (error) {
            if (selected(end)) {
                const failure = {name: error instanceof Error ? error.name : 'Unknown',
                    message: error instanceof Error ? error.message.slice(0, 4096) : 'Adjudication unavailable'};
                if (held?.end === end) held.rejected = failure;
                record('adjudication-rejected', {end, error: failure});
            }
            throw error;
        }
    };
    const read = HyperionMaster.prototype.readCanonicalRpcBlock;
    HyperionMaster.prototype.readCanonicalRpcBlock = async function (blockNum) {
        const context = active.getStore(), candidate = context?.master === this && selected(context.end)
            && context.end.binding.blockNum === control.blockNum && !held
            ? {end: context.end, master: this, reader: this.liveReader?.wref, source: this.protocolAbiSource,
                coordinator: this.protocolAbiCoordinator, readerSessionId: this.protocolAbiSource?.readerSessionId,
                generation: this.protocolAbiSource?.generation} : undefined;
        const response = await read.call(this, blockNum);
        if (candidate && !held) {
            assertWireRecoveryEnd(control, candidate.end);
            assert.equal(this.liveReader?.wref, candidate.reader); assert.equal(this.protocolAbiSource, candidate.source);
            assert.ok(candidate.reader && candidate.source && candidate.coordinator);
            assert.equal(candidate.source.readerSessionId, candidate.readerSessionId); assert.equal(candidate.source.generation, candidate.generation);
            let release; const gate = new Promise(resolve => {release = resolve;});
            held = {...candidate, response: structuredClone(response), readBlockNum: blockNum, release};
            const marker = {schemaVersion: 1, runId: control.runId, controlSha256: wireReaderControlDigest(control),
                masterPid: process.pid, parentPid: process.ppid, readerPid: candidate.reader.process.pid,
                readerId: candidate.reader.id, readerSessionId: candidate.readerSessionId, generation: candidate.generation,
                readBlockNum: blockNum, response, end: candidate.end};
            durableRecoveryFile(join(control.output, 'reader-recovery/held.json'), marker); record('rpc-held', marker);
            await gate; record('rpc-returning', {readBlockNum: blockNum, response, readerPid: candidate.reader.process.pid});
        }
        return response;
    };
    installWireReaderRecoveryHost(control, () => held, record);
}
