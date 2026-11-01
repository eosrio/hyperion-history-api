// Real driver/session response processing over controlled BSON; no connection or physical acceptance.
import assert from 'node:assert/strict';
import test from 'node:test';
import {nativeSnapshotFixture} from './operator-list-native-snapshot-fixture.mjs';
import {context, read} from './operator-list-fixture.mjs';

test('first publication provisions the source namespace before its genuine native snapshot read', async () => {
    const f = await nativeSnapshotFixture();
    try {
        const result = await f.publish();
        assert.equal(result.attempts, f.f.commands.length, 'Every publication command, including namespace provisioning, is charged');
        assert.deepEqual(f.f.commands[0].command, {createIndexes: 'bounded_ol_v1_source',
            indexes: [{name: '_id_', key: {_id: 1}}], writeConcern: {w: 'majority', j: true}});
        assert.ok(f.f.commands[0].options.timeoutMS > 0 && f.f.commands[0].options.timeoutMS <= 1000);
        assert.ok(f.commands.length > 0);
        assert.equal(f.commands[0].command.find, 'bounded_ol_v1_source');
        assert.equal(f.commands[0].namespaceExisted, true);
        assert.deepEqual(f.replies[0].toObject().cursor.firstBatch, [], 'Namespace creation does not fabricate a pointer');
        assert.ok(f.sessions[0].snapshotTime); assert.equal(f.sessions[0].inTransaction(), false);
        assert.notEqual(f.rootDriver.MongoClient, f.nativeDriver.MongoClient);
        assert.equal(f.sessions[0].snapshotTime instanceof f.rootDriver.Timestamp, false, 'Actual native response and root session use distinct BSON copies');
        assert.equal(f.sessions[0].snapshotTime instanceof f.nativeDriver.Timestamp, true);
        assert.ok(f.commands.some(value => value.command.getMore));
        for (const value of f.commands) {
            assert.equal(value.options.session.client, f.client); assert.equal(value.options.timeoutContext.csotEnabled(), true);
            assert.ok(value.options.signal instanceof AbortSignal); assert.equal(value.command.txnNumber, undefined);
            assert.equal(value.command.autocommit, undefined); assert.equal(value.command.readConcern.level, 'snapshot');
            if (value !== f.commands[0]) assert.ok(value.command.readConcern.atClusterTime.equals(f.sessions[0].snapshotTime));
            if (value.command.getMore || value.command.killCursors) assert.equal(value.command.maxTimeMS, undefined);
        }
        assert.equal(f.client.topology.selectServer instanceof Function, true, 'Only the controlled topology exists');
    } finally {await f.close();}
});

test('missing or non-Timestamp server snapshot metadata still refuses publication and activation', async () => {
    for (const stamp of ['missing', 1, 'not-a-timestamp', 'long']) {
        const f = await nativeSnapshotFixture();
        try {
            f.f.changeReply = answer => {if (!answer.cursor) return;
                if (stamp === 'missing') delete answer.cursor.atClusterTime;
                else answer.cursor.atClusterTime = stamp === 'long' ? f.rootDriver.Long.fromNumber(1) : stamp;};
            await assert.rejects(f.publish(), error => error.code === 'operator-list.unavailable' && /did not establish atClusterTime/.test(error.message));
            assert.equal(f.f.rows('bounded_ol_v1_source').size, 0);
            assert.equal(f.sessions[0].snapshotTime, undefined);
        } finally {await f.close();}
    }
});

test('a provisioned empty namespace grants no source authority before a complete publication', async () => {
    const f = await nativeSnapshotFixture();
    try {
        f.f.before = event => {if (event.command.createIndexes === 'bounded_ol_v1_header') throw new Error('controlled provisioning failure');};
        await assert.rejects(f.publish(), error => error.code === 'operator-list.unavailable');
        f.f.before = undefined;
        assert.equal(f.f.rows('bounded_ol_v1_source').size, 0);
        await assert.rejects(read(f.source, ['schemas']), error => error.code === 'operator-list.unavailable');
        assert.ok(f.sessions[0].snapshotTime, 'An actual empty-namespace response establishes time without inventing a publication');
    } finally {await f.close();}
});

test('provisioning consumes the original attempt limit and cancellation cannot continue into snapshot verification', async () => {
    const limited = await nativeSnapshotFixture({publicationLimits: {names: 256, items: 10000, bytes: 1024 * 1024, attempts: 1}});
    try {
        await assert.rejects(limited.publish(), error => error.code === 'operator-list.unavailable');
        assert.equal(limited.f.commands.length, 1); assert.equal(limited.f.commands[0].command.createIndexes, 'bounded_ol_v1_source');
        assert.equal(limited.commands.length, 0); assert.equal(limited.f.rows('bounded_ol_v1_source').size, 0);
    } finally {await limited.close();}
    const cancelled = await nativeSnapshotFixture(), signal = new AbortController();
    try {
        cancelled.f.after = event => {if (event.command.createIndexes === 'bounded_ol_v1_source') signal.abort();};
        await assert.rejects(cancelled.publish(context({signal: signal.signal})), error => error.code === 'operator-list.unavailable');
        assert.equal(cancelled.f.commands.length, 1); assert.equal(cancelled.commands.length, 0);
        assert.equal(cancelled.f.rows('bounded_ol_v1_source').size, 0);
    } finally {await cancelled.close();}
});
