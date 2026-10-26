/** Controlled callback/promise controls only; no physical fault or end authority. */
import assert from 'node:assert/strict';
import {installWorkerFailureDiagnostics} from '../../scripts/qualification/worker-failure-diagnostics.mjs';

async function fixture(options = {}) {
    const rows = [], originalResults = new WeakMap(); let failures = 0;
    const sentinelReturn = Object.freeze({});
    class Client {
        run(_handle, operation) {
            const result = Promise.resolve().then(operation); originalResults.set(this, result); return result;
        }
        describe(handle) {return {marker: handle.marker};}
    }
    class Projection {handleProjectionFailure() {return sentinelReturn;}}
    const diagnostics = installWorkerFailureDiagnostics({WorkerClient: Client, Projection,
        emit(event, snapshot) {if (options.sinkFailure) throw new Error('controlled sink'); rows.push({event, ...snapshot()});},
        failed() {failures++;}, maximumFailureEvents: options.maximumFailureEvents ?? 128});
    const client = new Client(), other = new Client(), worker = Object.assign(new Projection(), {workerAttemptClient: client});
    const error = new Error('original object'), handle = {marker: 'original handle'};
    const result = client.run(handle, () => {throw error;});
    assert.equal(result, originalResults.get(client), 'Observer retains the exact original run promise');
    await assert.rejects(result, value => value === error);
    assert.equal(worker.handleProjectionFailure(error), sentinelReturn, 'Observer retains the exact original handler return');
    if (!options.sinkFailure && !options.maximumFailureEvents) {
        const exact = rows.at(-1);
        assert.equal(exact.root.originalObjectMatch, true); assert.equal(exact.root.runRejectionObjectMatch, true);
        assert.equal(exact.root.runFailureId, rows.find(row => row.event === 'worker_attempt_run_rejected').runFailureId);
        worker.handleProjectionFailure(new Error(error.message));
        assert.equal(rows.at(-1).root.runRejectionObjectMatch, false, 'Copied error text grants no association');
        worker.workerAttemptClient = other;
        worker.handleProjectionFailure(error);
        assert.equal(rows.at(-1).root.runRejectionObjectMatch, false, 'An independent owner cannot borrow a root');
        worker.workerAttemptClient = client;
        for (let index = 0; index < 8; index++) await assert.rejects(client.run({marker: index}, () => {throw error;}), value => value === error);
        worker.handleProjectionFailure(error);
        assert.equal(rows.at(-1).root.ambiguous, true, 'Reused errors with multiple original runs remain ambiguous');
        assert.equal(rows.at(-1).root.attempt, null);
        assert.ok(failures > 0, 'Error-object association overflow remains visible');
    }
    if (options.sinkFailure || options.maximumFailureEvents) assert.ok(failures > 0);
    if (options.maximumFailureEvents) assert.equal(diagnostics.snapshot().omitted, 1);
    assert.equal(diagnostics.snapshot().maximumErrorMatches, 8);
}
await fixture();
await fixture({sinkFailure: true});
await fixture({maximumFailureEvents: 1});
for (const maximumFailureEvents of [0, 1025, 1.5]) assert.throws(
    () => installWorkerFailureDiagnostics({maximumFailureEvents}), /Invalid worker failure diagnostic bound/);
console.log(JSON.stringify({passed: true, controlledCallbacksOnly: true, physicalFaultEvidence: false}));
