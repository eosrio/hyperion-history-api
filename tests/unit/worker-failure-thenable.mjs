/** Native original scope/run assimilation with controlled local custody; no external services. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {installWorkerFailureDiagnostics} from '../../scripts/qualification/worker-failure-diagnostics.mjs';

async function drive(kind) {
    let reads = 0, calls = 0, caught;
    const error = new Error('original thenable failure');
    const client = new WorkerAttemptClient({mode: 'controlled-local-only', role: 'projection'});
    const handle = client.capture({kind: 'projection-frame', receiptId: randomUUID(),
        payloadSha256: 'a'.repeat(64), headersSha256: 'b'.repeat(64), consumerId: null, publisherId: null,
        queue: null, deliveryTag: null});
    const value = {get then() {
        reads++;
        if (kind === 'getter-throws') throw error;
        if (kind === 'plain-value') return undefined;
        return (resolve, reject) => {calls++; if (kind === 'rejects') reject(error); else resolve(7);};
    }};
    let result;
    try {result = await client.run(handle, () => value);} catch (failure) {caught = failure;}
    if (['rejects', 'getter-throws'].includes(kind)) assert.equal(caught, error);
    else {assert.equal(caught, undefined); assert.equal(result, kind === 'plain-value' ? value : 7);}
    assert.equal(client.describe(handle).scope.state, 'drained'); client.dispose();
    return {kind, reads, calls};
}
const kinds = ['resolves', 'rejects', 'getter-throws', 'plain-value'];
const baseline = [];
for (const kind of kinds) baseline.push(await drive(kind));
let failures = 0;
installWorkerFailureDiagnostics({WorkerClient: WorkerAttemptClient,
    emit(_event, snapshot) {snapshot();}, failed() {failures++;}});
const observed = [];
for (const kind of kinds) observed.push(await drive(kind));
assert.deepEqual(observed, baseline, 'Observer must preserve original then getter reads, assimilation and throws');
assert.equal(failures, 0);
assert.equal(observed.find(row => row.kind === 'resolves').calls, 1);
console.log(JSON.stringify({passed: true, node: process.versions.node, baseline, observed,
    controlledLocalOnly: true, productionAuthority: false}));
