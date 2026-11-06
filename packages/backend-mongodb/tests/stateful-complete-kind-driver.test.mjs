// Real pinned-driver command preparation, with controlled storage and no socket/server.
// Replica-set CI remains necessary to establish actual MongoDB acceptance.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {MongoServerError} from 'mongodb';
import {setupComplete} from './stateful-complete-kind-fixture.mjs';
import {admit, execute, retire} from './stateful-owner-v2-fixture.mjs';
const require = createRequire(import.meta.url);
const {Connection} = require('mongodb/lib/cmap/connection.js');
const {RunCommandOperation} = require('mongodb/lib/operations/run_command.js');
const {CSOTTimeoutContext} = require('mongodb/lib/timeout.js');
const {MongoDBNamespace} = require('mongodb/lib/utils.js');

async function populated() {
    const state = await setupComplete(), target = await admit(state, 1);
    await execute(state, target, async port => {port.put('collection', 'one', {name: 'one'}); port.put('collection', 'two', {name: 'two'});});
    await retire(state, target); return state;
}
const read = state => state.compose(async port => ({rows: await port.all('collection')}));

function prepared(trace, timeoutMS) {
    // Session/ownership is exercised by the native fixture. Here isolate the real driver's
    // CSOT-to-wire behavior; no topology or session capable of opening a socket is created.
    const {session, ...options} = trace.options;
    const operation = new RunCommandOperation(new MongoDBNamespace('stateful_fixture'), trace.value, options);
    const timeout = new CSOTTimeoutContext({timeoutMS, serverSelectionTimeoutMS: timeoutMS});
    return Connection.prototype.prepareCommand.call({description: {type: 'Standalone'}, supportsOpMsg: true,
        hasSessionSupport: false}, 'stateful_fixture', operation.buildCommand(), operation.buildOptions(timeout)).command;
}

test('actual pinned driver must not add maxTimeMS to a non-tailable getMore', async () => {
    const state = await populated(), commands = [];
    state.fixture.beforeData = trace => {
        const command = prepared(trace, state.options.transactionTimeoutMS); commands.push(command);
        if (command.getMore) assert.equal(command.maxTimeMS, undefined,
            'MongoDB refuses maxTimeMS on non-tailable getMore; the transaction CSOT still applies client-side');
    };
    assert.equal((await read(state)).value.rows.length, 2);
    assert.equal(commands.length, 2); assert.ok(commands[1].getMore);
    assert.ok(state.fixture.dataCommands.every(row => row.options.signal instanceof AbortSignal));
    assert.ok(state.fixture.sessions.every(session => session.hasEnded));
});

test('actual pinned driver preserves the explicit initial find operation deadline under transaction CSOT', async () => {
    const state = await populated();
    state.fixture.beforeData = trace => {
        const command = prepared(trace, state.options.transactionTimeoutMS);
        if (command.find) assert.equal(command.maxTimeMS, state.options.operationTimeoutMS,
            'Generic db.command CSOT must not expand the explicitly bounded initial find');
    };
    assert.equal((await read(state)).value.rows.length, 2);
});

test('cursor and session cleanup failures cannot replace the original native data error', async () => {
    for (const cleanup of ['cursor', 'session', 'both']) {
        const state = await populated(), original = new MongoServerError({ok: 0, code: 2, errmsg: 'original native data failure'});
        const cleanupError = new MongoServerError({ok: 0, code: 251, errmsg: 'cleanup transaction no longer exists', errorLabels: ['TransientTransactionError']});
        let sessionWrapped = false;
        state.fixture.beforeData = trace => {
            if ((cleanup === 'session' || cleanup === 'both') && !sessionWrapped) {
                sessionWrapped = true; const end = trace.session.endSession.bind(trace.session);
                trace.session.endSession = async () => {await end(); throw cleanupError;};
            }
            if (trace.command === 'getMore') throw original;
        };
        if (cleanup === 'cursor' || cleanup === 'both') state.fixture.beforeCleanup = () => {throw cleanupError;};
        await assert.rejects(read(state), error => error.code === 'stateful.unavailable' && error.cause === original);
        assert.equal(state.fixture.dataCommands.length, 2); assert.equal(state.fixture.cleanup.length, 1);
        assert.ok(state.fixture.sessions.every(session => session.hasEnded));
    }
});

test('a session cleanup failure after otherwise successful data remains a retryable failure', async () => {
    const state = await populated(), cleanup = new Error('completed native session could not close');
    let wrapped = false;
    state.fixture.beforeData = trace => {
        if (wrapped) return; wrapped = true; const end = trace.session.endSession.bind(trace.session);
        trace.session.endSession = async () => {await end(); throw cleanup;};
    };
    await assert.rejects(read(state), error => error.code === 'stateful.unavailable' && error.cause === cleanup);
    assert.ok(state.fixture.sessions.every(session => session.hasEnded));
});
