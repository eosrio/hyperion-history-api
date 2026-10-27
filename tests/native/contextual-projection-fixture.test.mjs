import assert from 'node:assert/strict';
import test from 'node:test';
import {validateContextualWorkerJob} from '../../scripts/qualification/projection-contextual-worker.mjs';

const run = 'a'.repeat(32), backendId = `fixture-contextual-${run}`;
const definition = {schemaVersion: 2, id: 'fixture', mappingRevision: 'a'.repeat(64),
    source: {contract: 'token', table: 'items', abiDeployment: 'deployment', abiSha256: 'b'.repeat(64)},
    fields: [{name: 'created', type: 'string', source: {kind: 'context', field: 'blockNum', format: 'decimal'}}],
    initialization: {kind: 'genesis'}, preserveOnReplace: ['created'], onAbsent: 'incomplete'};
const binding = {chainId: 'c'.repeat(64), backendId, projectionId: definition.id, mappingRevision: definition.mappingRevision,
    abiDeployment: definition.source.abiDeployment, abiSha256: definition.source.abiSha256, generation: 'fixture-instance'};
const job = () => ({schemaVersion: 1, run, uri: 'mongodb://127.0.0.1:34567/?directConnection=true',
    databaseName: `hyp_context_${run}`, backendId, collectionPrefix: 'h45_contextual', definition, binding,
    request: {revision: 'd'.repeat(64), batch: {binding,
        previous: {blockNum: 0, blockId: '0'.repeat(64)}, block: {blockNum: 1, blockId: '1'.repeat(64), previousBlockId: '0'.repeat(64)},
        source: {contract: 'token', table: 'items', blockTimeMs: 1000},
        policy: {preserveOnReplace: ['created'], onAbsent: 'incomplete'},
        mutations: [{kind: 'put-preserving', key: 'one', value: {created: '1'}, preserveFields: ['created']}]}}});

test('the contextual crash worker accepts only a bounded pinned own-fixture job before any connection', () => {
    const input = job(); const captured = validateContextualWorkerJob(input);
    input.request.batch.mutations[0].value.created = 'changed'; assert.equal(captured.request.batch.mutations[0].value.created, '1');
    for (const mutate of [value => {value.uri = 'mongodb://example.com:34567/?directConnection=true';},
        value => {value.uri = 'mongodb://127.0.0.1:27017/?directConnection=true';},
        value => {value.uri += '&directConnection=true';}, value => {value.uri = value.uri.replace('127.0.0.1', 'user:password@127.0.0.1');},
        value => {value.databaseName = 'another-database';}, value => {value.collectionPrefix = 'live';},
        value => {value.run = '../escape';}, value => {value.backendId = 'live';},
        value => {delete value.request.revision;}, value => {delete value.request.batch.source.blockTimeMs;},
        value => {value.request.batch.policy.preserveOnReplace = [];}, value => {value.request.batch.source.contract = 'foreign';},
        value => {value.request.batch.mutations[0].kind = 'put';}, value => {value.hook = 'code';}]) {
        const value = structuredClone(job()); mutate(value); assert.throws(() => validateContextualWorkerJob(value));
    }
    const accessor = job(); let calls = 0;
    Object.defineProperty(accessor, 'uri', {enumerable: true, get() {calls++; return 'mongodb://127.0.0.1:34567/';}});
    assert.throws(() => validateContextualWorkerJob(accessor)); assert.equal(calls, 0);
});
