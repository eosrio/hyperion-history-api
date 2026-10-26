/** Real qualifier with controlled records/ES callbacks. No source, Docker or restart authority. */
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createWireBrokerRecoveryControl, wireBrokerRecoveryDigest} from '../../scripts/qualification/portable-state-broker-recovery.mjs';
import {qualifyWireStorageRestart} from '../../scripts/qualification/portable-state-storage-recovery.mjs';

let cases = [
    {name: 'child-end-before', actor: 'child', event: 'end'},
    {name: 'child-ack-before', actor: 'child', event: 'ack-sent'},
    {name: 'master-end-before', actor: 'master', event: 'end'},
    {name: 'master-adjudicated-before', actor: 'master', event: 'adjudicated'},
    {name: 'master-end-after', actor: 'master', event: 'end', after: true},
    {name: 'master-adjudicated-after', actor: 'master', event: 'adjudicated', after: true},
    {name: 'child-end-after', actor: 'child', event: 'end', after: true},
    {name: 'foreign-master', actor: 'foreign', event: 'end', allowed: true},
    {name: 'other-attempt', actor: 'master', event: 'end', otherAttempt: true, allowed: true},
    {name: 'master-child-event', actor: 'master', event: 'ack-sent', allowed: true},
    {name: 'missing-master', owner: 'missing'},
    {name: 'invalid-master', owner: 'invalid'},
    {name: 'foreign-parent', owner: 'foreign'},
    {name: 'same-owner', owner: 'same'},
    {name: 'held', allowed: true}
];
if (process.argv[2]) {assert.ok(cases.some(value => value.name === process.argv[2])); cases = cases.filter(value => value.name === process.argv[2]);}
const results = [];
for (const scenario of cases) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'h45-storage-owner-')));
    try {
        const run = 'abcdef012345', chain = 'hyp-p191-' + run, chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d';
        const profileId = 'wire-sysio-6508c9e8-native-engineering-v1', configFile = join(directory, 'chain.json');
        writeFileSync(configFile, JSON.stringify({settings: {chain, protocol: {profileId}}}));
        const {control} = createWireBrokerRecoveryControl({output: directory, configFile, chain,
            source: {chainId, profileId, endBlock: 1480, records: Array.from({length: 33}, () => ({blockId: 'b'.repeat(64)}))}, frameSha256: 'f'.repeat(64)});
        const masterPid = process.ppid, childPid = process.pid, foreignPid = Math.max(childPid, masterPid) + 1000;
        const attemptId = randomUUID(), recordId = 'h45actionhandoff1:' + 'c'.repeat(64), admissionId = 'h45actionadmission1:' + 'd'.repeat(64);
        const index = chain + '-history-source-admission-v1', target = chain + '-action-v1-000001';
        const scope = {id: 'controlled-root', state: 'open', pendingOperations: 1};
        const held = {schemaVersion: 1, runId: control.runId, controlSha256: wireBrokerRecoveryDigest(control), role: 'ds_pool_worker',
            source: {chainId, blockNum: 33, blockId: control.blockId}, originalFrameSha256: control.frameSha256,
            admissionId, traceOrdinal: 0, payloadSha256: 'e'.repeat(64), redelivered: false, pid: childPid, parentPid: masterPid,
            recordId, method: 'create', scope, attempt: {attemptId, mode: 'managed', masterEnd: null, scope,
                binding: {targetName: target, targetUuid: 'original-target', admissionId, traceOrdinal: 0, blockNum: 33, blockId: control.blockId},
                descriptor: {payloadSha256: 'e'.repeat(64)}},
            request: {index, id: recordId, document: {kind: 'manifest', bundle_id: recordId}, wait_for_active_shards: 'all', pipeline: '_none', refresh: false},
            response: {_id: recordId, _index: index, result: 'created', _seq_no: 1, _shards: {total: 2, successful: 2, failed: 0}}};
        if (scenario.owner === 'foreign') held.parentPid = foreignPid;
        if (scenario.owner === 'same') held.pid = masterPid;
        writeFileSync(join(directory, 'broker-recovery/held-receipt.json'), JSON.stringify(held));
        const rows = [{event: 'handoff-receipt-held', pid: held.pid, attemptId}];
        const terminal = scenario.event && {event: scenario.event,
            pid: scenario.actor === 'child' ? held.pid : scenario.actor === 'master' ? masterPid : foreignPid,
            ...(scenario.event === 'end' || scenario.event === 'adjudicated'
                ? {end: {attemptId: scenario.otherAttempt ? randomUUID() : attemptId}} : {attemptId})};
        const save = () => {
            const grouped = Map.groupBy(rows, row => row.pid);
            for (const [pid, entries] of grouped) writeFileSync(join(directory, `broker-recovery/process-${pid}.jsonl`),
                entries.map((row, index) => JSON.stringify({...row, runId: control.runId, sequence: index + 1})).join('\n') + '\n');
        };
        if (terminal && !scenario.after) rows.push(terminal);
        save();
        let esCalls = 0, dockerCalls = 0;
        const boundary = new Error('Controlled storage-inspection boundary');
        const core = {run, clusterName: 'controlled-cluster', clusterUuid: 'original-cluster',
            nodes: ['a', 'b', 'witness'].map((name, index) => ({name, role: index < 2 ? 'data' : 'master'}))};
        const es = {info: async () => {
            esCalls++;
            if (!scenario.after) throw boundary;
            rows.push(terminal); save();
            return {cluster_name: core.clusterName, cluster_uuid: core.clusterUuid, version: {number: '9.5.5'}};
        }, indices: {
            getSettings: async () => Object.fromEntries([index, target].map(name => [name, {settings: {
                'index.uuid': name === target ? 'original-target' : 'original-manifest', 'index.number_of_replicas': '1', 'index.translog.durability': 'request'}}])),
            refresh: async () => ({_shards: {total: 2, successful: 2, failed: 0}})
        }, nodes: {info: async () => ({_nodes: {total: 3, successful: 3, failed: 0},
            nodes: Object.fromEntries(core.nodes.map((node, index) => ['node' + index, {name: node.name}]))})},
        search: async () => ({timed_out: false, _shards: {total: 1, successful: 1, failed: 0},
            hits: {total: {value: 1, relation: 'eq'}, hits: [{_index: index, _id: recordId, _source: held.request.document}]}})};
        const evidence = {}; let error;
        try {await qualifyWireStorageRestart({core, es, control, evidence,
            masterPid: scenario.owner === 'missing' ? undefined : scenario.owner === 'invalid' ? 0 : masterPid,
            docker() {dockerCalls++; throw new Error('Unexpected controlled Docker boundary');},
            replay: {assertThrough: block => assert.equal(block, 33)}, wait() {assert.fail('No restart or recovery wait in this control');}});
        } catch (value) {error = value;}
        assert.ok(error); assert.equal(dockerCalls, 0);
        if (scenario.allowed) {assert.equal(error, boundary); assert.equal(esCalls, 1);}
        else {
            assert.match(error.message, scenario.owner ? /master|owner/i : /original return settled/);
            assert.equal(esCalls, scenario.after ? 1 : 0);
        }
        assert.equal(evidence.status, 'failed'); assert.equal(evidence.releaseQualified, false);
        results.push({name: scenario.name, expectedPreconditionPassed: !!scenario.allowed,
            stoppedBeforeDocker: true, postSnapshot: !!scenario.after});
    } finally {
        assert.equal(dirname(directory), realpathSync(tmpdir())); assert.ok(basename(directory).startsWith('h45-storage-owner-'));
        rmSync(directory, {recursive: true, force: true});
    }
}
console.log(JSON.stringify({passed: true, node: process.versions.node, scenarios: results.length, results,
    controlledRecordsOnly: true, realDockerCalls: 0, sourceAuthority: false, restartAuthority: false, serviceQualification: false}));
