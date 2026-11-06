// Exact original cleanup failure pattern through executeOperation/Server/Connection/BSON.
// No socket, physical server, child process or controller is used by these controls.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {nativeSnapshotFixture} from './operator-list-native-snapshot-fixture.mjs';
import {read, readLimits} from './operator-list-fixture.mjs';
import {executeCompleteKindCommand} from '../dist/stateful-complete-kind-command.js';
const require = createRequire(import.meta.url), {RunCommandOperation} = require('mongodb/lib/operations/run_command.js');
const {Connection} = require('mongodb/lib/cmap/connection.js');

test('bounded real-driver read reserves one successful cleanup command on its original logical session', async () => {
    const f = await nativeSnapshotFixture();
    try {
        await f.publish(); const baseline = await read(f.source, ['schemas']);
        const start = f.commands.length, operationStart = f.operations.length;
        let failure;
        await assert.rejects(read(f.freshSource(), ['schemas'], {...readLimits(), attempts: baseline.attempts}), error => {
            failure = error; return error.code === 'operator-list.unavailable' && /cleanup attempt reserve exhausted/.test(error.message);
        });
        assert.equal(failure.suppressed, undefined, 'A valid killCursors must not produce the retained MongoDB code72 failure');
        const calls = f.commands.slice(start), kill = calls.filter(value => value.command.killCursors);
        assert.equal(kill.length, 1); assert.equal(calls.length, baseline.attempts);
        assert.equal(kill[0].command.readConcern, undefined); assert.equal(kill[0].command.maxTimeMS, undefined);
        assert.equal(kill[0].options.session, undefined, 'Only unsupported connection decoration is omitted');
        const original = kill[0].session, operation = f.operations.slice(operationStart).at(-1);
        assert.equal(operation.session, original); assert.equal(operation.operation.session, original);
        assert.equal(original.snapshotEnabled, true); assert.equal(original.hasEnded, true);
        assert.deepEqual(kill[0].command.lsid, original.id);
        assert.ok(kill[0].options.signal instanceof AbortSignal); assert.equal(kill[0].options.timeoutContext.csotEnabled(), true);
        assert.ok(kill[0].options.timeoutMS > 0 && kill[0].options.timeoutMS <= 1000);
        assert.equal(f.f.cursors.size, 0);
        const stamp = original.snapshotTime;
        for (const value of calls.filter(value => !value.command.killCursors)) {
            assert.equal(value.options.session, original); assert.equal(value.command.readConcern.level, 'snapshot');
            if (value.command.readConcern.atClusterTime) assert.ok(value.command.readConcern.atClusterTime.equals(stamp));
            assert.deepEqual(value.command.lsid, kill[0].command.lsid);
        }
    } finally {await f.close();}
});

test('real cleanup server failure stays secondary to the original bounded-read failure', async () => {
    const f = await nativeSnapshotFixture();
    try {
        await f.publish(); const baseline = await read(f.source, ['schemas']);
        f.f.changeReply = (answer, command) => {if (command.killCursors) Object.assign(answer,
            {ok: 0, code: 43, errmsg: 'controlled cleanup failure'});};
        await assert.rejects(read(f.freshSource(), ['schemas'], {...readLimits(), attempts: baseline.attempts}), error => {
            assert.match(error.message, /cleanup attempt reserve exhausted/);
            assert.equal(error.suppressed?.[0].code, 43); assert.equal(error.suppressed?.[0].message, 'controlled cleanup failure');
            return error.code === 'operator-list.unavailable';
        });
        assert.equal(f.commands.at(-1).command.killCursors, 'bounded_ol_v1_item');
        assert.equal(f.commands.at(-1).command.readConcern, undefined);
    } finally {await f.close();}
});

test('ended, foreign and cancelled original sessions never dispatch a native cleanup command', async () => {
    const f = await nativeSnapshotFixture(), foreign = new f.rootDriver.MongoClient('mongodb://127.0.0.1:1');
    const ended = f.client.startSession({snapshot: true, causalConsistency: false}); await ended.endSession();
    const other = foreign.startSession({snapshot: true, causalConsistency: false}), live = f.client.startSession({snapshot: true, causalConsistency: false});
    const command = {killCursors: 'bounded_ol_v1_item', cursors: [f.nativeDriver.Long.fromNumber(10)]};
    const invoke = (session, signal = new AbortController().signal) => executeCompleteKindCommand(f.client, 'lists_fixture', command,
        {session, signal, timeoutMS: 1000, promoteLongs: false});
    try {
        await assert.rejects(invoke(ended), /expired session/i);
        await assert.rejects(invoke(other), /same MongoClient/);
        const controller = new AbortController(); controller.abort(new Error('controlled pre-dispatch cancellation'));
        await assert.rejects(invoke(live, controller.signal), /controlled pre-dispatch cancellation/);
        assert.equal(f.commands.length, 0);
    } finally {await other.endSession(); await foreign.close(); await f.close();}
});

test('cleanup lsid is derived only from the genuine operation session', async () => {
    const f = await nativeSnapshotFixture(), session = f.client.startSession({snapshot: true, causalConsistency: false});
    try {
        const answer = await executeCompleteKindCommand(f.client, 'lists_fixture', {killCursors: 'bounded_ol_v1_item',
            cursors: [f.nativeDriver.Long.fromNumber(10)], lsid: {id: new f.nativeDriver.UUID()}},
        {session, signal: new AbortController().signal, timeoutMS: 1000, promoteLongs: false});
        assert.equal(answer.ok, 1); assert.deepEqual(f.commands[0].command.lsid, session.id);
        assert.equal(f.operations[0].session, session); assert.equal(f.commands[0].command.readConcern, undefined);
        assert.equal(session.snapshotEnabled, true); assert.equal(session.inTransaction(), false);
    } finally {await f.close();}
});

test('late session expiry and an explicit cleanup readConcern refuse before wire dispatch', async () => {
    for (const lateExpiry of [false, true]) {
        const f = await nativeSnapshotFixture(), session = f.client.startSession({snapshot: true, causalConsistency: false});
        try {
            if (lateExpiry) {
                const select = f.client.topology.selectServer;
                f.client.topology.selectServer = async (...args) => {const selected = await select(...args); await session.endSession(); return selected;};
            }
            await assert.rejects(executeCompleteKindCommand(f.client, 'lists_fixture', {killCursors: 'bounded_ol_v1_item',
                cursors: [f.nativeDriver.Long.fromNumber(10)], ...(lateExpiry ? {} : {readConcern: {level: 'snapshot'}})},
            {session, signal: new AbortController().signal, timeoutMS: 1000}),
            lateExpiry ? /original live session/ : /cannot carry read concern/);
            assert.equal(f.commands.length, 0); assert.equal(session.snapshotEnabled, true);
        } finally {await f.close();}
    }
});

test('ordinary and transaction sessions retain the original generic operation and wire preparation', async () => {
    for (const transactional of [false, true]) {
        const f = await nativeSnapshotFixture(), session = f.client.startSession({causalConsistency: false});
        try {
            if (transactional) session.startTransaction({readConcern: {level: 'snapshot'}});
            const server = await f.client.topology.selectServer(), commands = [];
            // Observe the real pinned command preparation only; this control does not
            // assert server acceptance of a synthetic first-command transaction cleanup.
            server.command = async (operation, timeoutContext) => {
                assert.equal(operation.constructor, RunCommandOperation); assert.equal(operation.session, session);
                const options = operation.buildOptions(timeoutContext); assert.equal(options.session, session);
                const command = Connection.prototype.prepareCommand.call({description: {type: 'RSPrimary'},
                    hasSessionSupport: true, supportsOpMsg: true}, 'lists_fixture', operation.buildCommand(undefined, session), options).command;
                commands.push(command); return {toObject: () => ({ok: 1})};
            };
            await executeCompleteKindCommand(f.client, 'lists_fixture', {killCursors: 'bounded_ol_v1_item', cursors: [f.nativeDriver.Long.fromNumber(10)]},
                {session, signal: new AbortController().signal, timeoutMS: 1000});
            assert.deepEqual(commands[0].lsid, session.id);
            assert.equal(commands[0].maxTimeMS, undefined);
            if (transactional) {assert.equal(commands[0].autocommit, false); assert.equal(commands[0].startTransaction, true);
                assert.equal(commands[0].readConcern.level, 'snapshot');}
            else {assert.equal(commands[0].readConcern, undefined); assert.equal(commands[0].txnNumber, undefined);}
            await session.endSession();
        } finally {await f.close();}
    }
});

test('first-key find and getMore retain snapshot preparation despite an extra killCursors field', async () => {
    for (const name of ['find', 'getMore']) {
        const f = await nativeSnapshotFixture();
        try {
            await f.publish(); const session = f.client.startSession({snapshot: true, causalConsistency: false});
            const invoke = command => executeCompleteKindCommand(f.client, 'lists_fixture', command,
                {session, signal: new AbortController().signal, timeoutMS: 1000, promoteLongs: false});
            const initial = {find: 'bounded_ol_v1_item', filter: {}, hint: '_id_', batchSize: 1};
            const first = name === 'getMore' ? await invoke(initial) : undefined;
            await invoke(name === 'getMore' ? {getMore: first.cursor.id, collection: 'bounded_ol_v1_item', batchSize: 1,
                killCursors: 'bounded_ol_v1_item'} : {...initial, killCursors: 'bounded_ol_v1_item'});
            const sent = f.commands.at(-1), operation = f.operations.at(-1);
            assert.equal(Object.keys(sent.command)[0], name); assert.equal(operation.operation.constructor, RunCommandOperation);
            assert.equal(operation.session, session); assert.equal(sent.options.session, session);
            assert.equal(sent.command.readConcern.level, 'snapshot'); assert.deepEqual(sent.command.lsid, session.id);
            // Extra fields are modeled only to observe dispatch. Server acceptance of
            // this deliberately ambiguous input is not asserted by this control.
        } finally {await f.close();}
    }
});

test('a command whose first key changes after cleanup selection refuses before wire dispatch', async () => {
    const f = await nativeSnapshotFixture(), session = f.client.startSession({snapshot: true, causalConsistency: false});
    const command = {killCursors: 'bounded_ol_v1_item', cursors: [f.nativeDriver.Long.fromNumber(10)]};
    try {
        const select = f.client.topology.selectServer;
        f.client.topology.selectServer = async (...args) => {const server = await select(...args);
            delete command.killCursors; delete command.cursors;
            command.find = 'bounded_ol_v1_item'; command.killCursors = 'bounded_ol_v1_item'; return server;};
        await assert.rejects(executeCompleteKindCommand(f.client, 'lists_fixture', command,
            {session, signal: new AbortController().signal, timeoutMS: 1000}), /must remain a killCursors command/);
        assert.equal(f.commands.length, 0); assert.equal(session.snapshotEnabled, true);
    } finally {await f.close();}
});
