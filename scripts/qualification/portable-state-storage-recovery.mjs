/** Original acknowledged transport bytes survive an owned replica restart before broker handover. */
import assert from 'node:assert/strict';
import {captureOwnedWireReplica, describeOwnedWireReplica, restartOwnedWireReplica, describeOwnedWireReplicaRestart} from './owned-wire-replica.mjs';
import {describeIssuedWireBrokerControl, readWireBrokerRecoveryEvidence, assertWireBrokerHeldReceipt} from './portable-state-broker-recovery.mjs';

function heldReturn(control, expected) {
    describeIssuedWireBrokerControl(control);
    const evidence = readWireBrokerRecoveryEvidence(control), held = evidence.held;
    assertWireBrokerHeldReceipt(control, held);
    const selected = evidence.events.filter(row => row.pid === held.pid &&
        (row.attemptId ?? row.attempt?.attemptId ?? row.end?.attemptId) === held.attempt.attemptId);
    assert.equal(selected.filter(row => row.event === 'handoff-receipt-held').length, 1);
    assert.ok(!selected.some(row => ['fresh-observation-attempt', 'fresh-observation-return', 'ack-intent', 'ack-sent',
        'handoff-receipt-released', 'held-attempt-fenced', 'end', 'adjudicated'].includes(row.event)), 'original return settled or lost its current owner before broker handover');
    if (expected !== undefined) assert.deepEqual(held, expected, 'original held receipt changed during storage recovery');
    return held;
}

export async function snapshotWireStorage(es, core, held) {
    // Reject foreign names before contacting or refreshing any Elasticsearch index.
    assert.match(core.run, /^[a-f0-9]{12}$/);
    const chain = 'hyp-p191-' + core.run, target = held.attempt.binding.targetName;
    assert.equal(held.request.index, chain + '-history-source-admission-v1');
    assert.match(target, new RegExp('^' + chain + '-action-v1-[0-9]{6}$'));
    assert.match(held.recordId, /^h45actionhandoff1:[a-f0-9]{64}$/);
    const identity = await es.info();
    assert.equal(identity.cluster_name, core.clusterName); assert.equal(identity.version.number, '9.5.5');
    assert.equal(typeof identity.cluster_uuid, 'string'); assert.ok(identity.cluster_uuid.length > 0 && identity.cluster_uuid !== '_na_');
    assert.equal(identity.cluster_uuid, core.clusterUuid);
    const settings = await es.indices.getSettings({index: [held.request.index, target], flat_settings: true, include_defaults: true});
    const indices = Object.fromEntries([held.request.index, target].map(name => {
        const entry = settings[name]; assert.ok(entry);
        const value = key => entry.settings?.[key] ?? entry.defaults?.[key];
        assert.equal(value('index.number_of_replicas'), '1');
        const rawDurability = value('index.translog.durability');
        assert.equal(typeof rawDurability, 'string'); assert.equal(rawDurability.toLowerCase(), 'request');
        const uuid = value('index.uuid'); assert.ok(typeof uuid === 'string' && uuid.length > 0);
        return [name, {uuid, replicas: value('index.number_of_replicas'), durability: 'request', rawDurability}];
    }));
    assert.equal(indices[target].uuid, held.attempt.binding.targetUuid);
    const nodes = await es.nodes.info();
    assert.equal(nodes._nodes.total, 3); assert.equal(nodes._nodes.successful, 3); assert.equal(nodes._nodes.failed, 0);
    assert.deepEqual(Object.values(nodes.nodes).map(node => node.name).sort(), core.nodes.map(node => node.name).sort());
    const data = Object.entries(nodes.nodes).filter(([, node]) => core.nodes.some(entry => entry.role === 'data' && entry.name === node.name));
    assert.equal(data.length, 2);
    const copies = [];
    // Refresh only makes this query visible. It cannot replace the original two-copy write receipt.
    const refresh = await es.indices.refresh({index: held.request.index});
    assert.equal(refresh._shards.failed, 0); assert.equal(refresh._shards.total, 2); assert.equal(refresh._shards.successful, 2);
    for (const [nodeId, node] of data) {
        const response = await es.search({index: held.request.index, query: {ids: {values: [held.recordId]}},
            size: 2, track_total_hits: true, preference: '_only_nodes:' + nodeId});
        assert.equal(response.timed_out, false); assert.equal(response._shards.failed, 0);
        assert.equal(response._shards.total, 1); assert.equal(response._shards.successful, 1);
        assert.equal(response.hits.total.relation, 'eq'); assert.equal(response.hits.total.value, 1); assert.equal(response.hits.hits.length, 1);
        assert.equal(response.hits.hits[0]._index, held.request.index); assert.equal(response.hits.hits[0]._id, held.recordId);
        assert.deepEqual(response.hits.hits[0]._source, held.request.document);
        copies.push({nodeId, name: node.name, preference: '_only_nodes:' + nodeId, response});
    }
    return {clusterName: identity.cluster_name, clusterUuid: identity.cluster_uuid, indices, copies};
}

export async function qualifyWireStorageRestart({core, docker, es, control, replay, wait, evidence = {}}) {
    Object.assign(evidence, {status: 'pending', freshWriteAuthority: false, capacityAuthority: false, releaseQualified: false});
    try {
        const held = heldReturn(control); replay.assertThrough(33); evidence.held = held;
        const before = await snapshotWireStorage(es, core, held); evidence.before = before;
        heldReturn(control, held); replay.assertThrough(33);
        const token = captureOwnedWireReplica(core, docker); evidence.originalIncarnation = describeOwnedWireReplica(token);
        const restart = restartOwnedWireReplica(token); evidence.restart = describeOwnedWireReplicaRestart(restart);
        evidence.status = 'restart-observed';
        await wait('owned Elasticsearch configured copies recovered before broker handover', async () => {
            const health = await es.cluster.health({wait_for_status: 'green', wait_for_active_shards: 'all', timeout: '1s'});
            evidence.lastHealth = health;
            assert.equal(health.timed_out, false); assert.equal(health.status, 'green');
            assert.equal(health.number_of_nodes, 3); assert.equal(health.number_of_data_nodes, 2);
            const current = await snapshotWireStorage(es, core, held); evidence.after = current;
            assert.equal(current.clusterUuid, before.clusterUuid); assert.deepEqual(current.indices, before.indices);
            assert.deepEqual(current.copies.map(copy => [copy.nodeId, copy.name]).sort(), before.copies.map(copy => [copy.nodeId, copy.name]).sort());
        });
        heldReturn(control, held); replay.assertThrough(33);
        Object.assign(evidence, {status: 'observed', originalReturnStillHeld: true, originalResponseUnchanged: true, existingTwoCopyWriteOnly: true});
        return evidence;
    } catch (error) {
        evidence.status = 'failed'; evidence.error = {name: error.name, message: error.message, stack: error.stack};
        if (error.replicaRestartAttempt) evidence.restartFailure = error.replicaRestartAttempt;
        throw error;
    }
}
