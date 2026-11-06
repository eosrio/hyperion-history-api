// Real pinned driver/session/command preparation, no connection or server.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {BSON, MongoClient, Timestamp} from 'mongodb';
import {Timestamp as OtherTimestamp} from 'bson';
import {read, setup} from './operator-list-fixture.mjs';
const require = createRequire(import.meta.url), {Connection} = require('mongodb/lib/cmap/connection.js');
const {RunCommandOperation} = require('mongodb/lib/operations/run_command.js'), {MongoDBNamespace} = require('mongodb/lib/utils.js');
const {CSOTTimeoutContext} = require('mongodb/lib/timeout.js'), {MongoDBResponse} = require('mongodb/lib/cmap/wire_protocol/responses.js');
const {updateSessionFromResponse} = require('mongodb/lib/sessions.js');

test('pinned generic preparation preserves snapshot reads and exposes unsupported cleanup decoration', async () => {
    const client = new MongoClient('mongodb://127.0.0.1:37017', {retryReads: false, retryWrites: false, maxAdaptiveRetries: 0});
    const session = client.startSession({snapshot: true, causalConsistency: false});
    const connection = {description: {type: 'RSPrimary'}, hasSessionSupport: true, supportsOpMsg: true};
    const prepare = command => {
        const operation = new RunCommandOperation(new MongoDBNamespace('fixture'), command,
            {session, omitMaxTimeMS: true, timeoutMS: 1000, signal: new AbortController().signal});
        const timeout = new CSOTTimeoutContext({timeoutMS: 1000, serverSelectionTimeoutMS: 1000});
        assert.equal(timeout.csotEnabled(), true);
        return Connection.prototype.prepareCommand.call(connection, 'fixture', operation.buildCommand(), operation.buildOptions(timeout)).command;
    };
    try {
        const first = prepare({find: 'rows', filter: {}, maxTimeMS: 1000}); assert.equal(first.readConcern.level, 'snapshot');
        assert.equal(first.readConcern.atClusterTime, undefined); assert.equal(first.txnNumber, undefined); assert.equal(session.inTransaction(), false);
        const stamp = new Timestamp({t: 1000, i: 7});
        updateSessionFromResponse(session, MongoDBResponse.make(BSON.serialize({ok: 1, cursor: {id: BSON.Long.ZERO,
            ns: 'fixture.rows', atClusterTime: stamp, firstBatch: []}})));
        for (const command of [{find: 'rows', filter: {}, maxTimeMS: 1000}, {aggregate: 'rows', pipeline: [], cursor: {}, maxTimeMS: 1000},
            {getMore: BSON.Long.fromNumber(10), collection: 'rows'}]) {
            const value = prepare(command); assert.equal(value.readConcern.level, 'snapshot'); assert.ok(value.readConcern.atClusterTime.equals(stamp));
            assert.deepEqual(value.lsid, first.lsid); assert.equal(value.txnNumber, undefined); assert.equal(value.autocommit, undefined);
            if (value.getMore || value.killCursors) assert.equal(value.maxTimeMS, undefined);
        }
        // Retain the generic driver's source behavior as evidence. The qualified
        // executor uses its narrow cleanup seam instead of sending this invalid form.
        const unsupported = prepare({killCursors: 'rows', cursors: [BSON.Long.fromNumber(10)]});
        assert.equal(unsupported.readConcern.level, 'snapshot'); assert.ok(unsupported.readConcern.atClusterTime.equals(stamp));
        assert.equal(unsupported.maxTimeMS, undefined);
        assert.equal(session.inTransaction(), false); let aborted = false; session.abortTransaction = async () => {aborted = true;};
        await session.endSession(); assert.equal(aborted, false); assert.equal(session.hasEnded, true);
        assert.equal(client.topology, undefined, 'No native connection/topology was created');
    } finally {await session.endSession(); await client.close();}
});

test('actual operator-list executor enables CSOT and preserves explicit find/aggregate bounds and getMore omission', async () => {
    const {source, f} = await setup();
    f.before = trace => {
        if (trace.transport !== 'executor') return;
        const {session, ...options} = trace.options;
        const operation = new RunCommandOperation(new MongoDBNamespace(trace.database), trace.command, options);
        const prepared = Connection.prototype.prepareCommand.call({description: {type: 'Standalone'}, hasSessionSupport: false, supportsOpMsg: true},
            trace.database, operation.buildCommand(), operation.buildOptions(trace.options.timeoutContext)).command;
        assert.ok(options.timeoutMS > 0 && options.timeoutMS <= 1000); assert.equal(trace.options.timeoutContext.csotEnabled(), true);
        assert.equal(prepared.maxTimeMS, trace.type === 'getMore' || trace.type === 'killCursors' ? undefined : 1000);
    };
    const result = await read(source, ['schemas']); assert.equal(result.attempts, f.data().length);
});

test('native atClusterTime accepts a genuine BSON Timestamp from a different installed/module copy', async () => {
    const {source, f} = await setup(); const stamp = new OtherTimestamp({t: 1000, i: 1});
    assert.equal(stamp instanceof Timestamp, false, 'This control must exercise distinct BSON constructor identity');
    f.before = trace => {if (trace.transport === 'executor') trace.options.session.snapshotTime = stamp;};
    assert.equal((await read(source, ['schemas'])).entries[0].items.length, 5);
});
