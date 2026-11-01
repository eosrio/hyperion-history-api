// Real root managed client/session, public Db.command, executeOperation and Server.command.
// Only the final connection transport and metadata/row storage are controlled; no socket exists.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {MongoClient, MongoServerError, BSON} from 'mongodb';
import {StatefulCompleteKindMongoClient} from '../../build/indexer/connections/stateful-complete-kind-client.js';
import {completeFixture, setupComplete, totals} from '../../packages/backend-mongodb/tests/stateful-complete-kind-fixture.mjs';
import {admit, execute, retire} from '../../packages/backend-mongodb/tests/stateful-owner-v2-fixture.mjs';
import {executeCompleteKindCommand} from '../../packages/backend-mongodb/dist/stateful-complete-kind-command.js';
import {installCompleteKindCommandHooks} from '../../scripts/qualification/stateful-complete-kind-mongodb/command-hooks.mjs';
const require = createRequire(import.meta.url);
const {Server} = require('mongodb/lib/sdam/server.js');
const {Connection} = require('mongodb/lib/cmap/connection.js');
const nativeRequire = createRequire(new URL('../../packages/backend-mongodb/package.json', import.meta.url));
const {MongoClient: NativeMongoClient} = nativeRequire('mongodb');

async function fixture() {
    assert.notEqual(MongoClient, NativeMongoClient, 'Root managed and native adapter driver modules must be distinct');
    assert.equal(require('mongodb/package.json').version, '7.2.0'); assert.equal(nativeRequire('mongodb/package.json').version, '7.2.0');
    const controlled = completeFixture(), controlledDb = controlled.client.db.bind(controlled.client),
        controlledStart = controlled.client.startSession.bind(controlled.client);
    const wire = [], actualSessions = [], responseFrames = [], sessionStorage = new WeakMap(); let topology, fault, rawDb, selectedServer;
    const pool = new StatefulCompleteKindMongoClient(() => ({uri: 'mongodb://127.0.0.1:1', options: {}}), (uri, options) => {
        const client = new MongoClient(uri, options), db = client.db.bind(client), start = client.startSession.bind(client);
        rawDb = db;
        const connection = {description: {type: 'RSPrimary', maxWireVersion: 25, loadBalanced: false},
            supportsOpMsg: true, hasSessionSupport: true,
            async command(namespace, command, options, Response) {
                const message = Connection.prototype.prepareCommand.call(this, namespace.db, command, options), selected = message.command;
                if (selected.comment?.hyperion === 'stateful-complete-kind-v1') {
                    assert.equal(options.session.client, client); assert.equal(options.timeoutContext, options.session.timeoutContext);
                    assert.ok(options.session.inTransaction()); assert.ok(options.signal instanceof AbortSignal);
                    wire.push({command: selected.find ? 'find' : selected.getMore ? 'getMore' : 'other',
                        maxTimeMS: selected.maxTimeMS ?? null, signal: options.signal, session: options.session,
                        transaction: selected.txnNumber.toString(), timeoutContext: options.timeoutContext,
                        transactionTimeoutMS: options.timeoutContext.timeoutMS,
                        omitMaxTimeMS: options.omitMaxTimeMS ?? null});
                    if (fault) await fault(selected);
                    const answer = await controlledDb(namespace.db).command(selected,
                        {...options, session: sessionStorage.get(options.session)});
                    const response = Response.make(BSON.serialize(answer)); responseFrames.push(response); return response;
                }
                if (selected.find || selected.getMore || selected.killCursors) {
                    const answer = await controlledDb(namespace.db).command(selected,
                        {...options, session: sessionStorage.get(options.session)});
                    return Response.make(BSON.serialize(answer));
                }
                assert.ok(selected.ping || selected.commitTransaction || selected.abortTransaction || selected.endSessions,
                    'Only actual driver transaction/session commands can reach the controlled transport');
                return Response.make(BSON.serialize({ok: 1}));
            }};
        const server = Object.create(Server.prototype);
        selectedServer = server;
        topology = {s: {options: client.options}, description: {type: 'ReplicaSetWithPrimary'},
            logicalSessionTimeoutMinutes: 30, commonWireVersion: 25, selectServer: async () => server,
            close: async () => {}, closeCheckedOutConnections: () => {}, isConnected: () => true};
        Object.assign(server, {s: {state: 'connected', operationCount: 0,
            description: {address: '127.0.0.1:1', type: 'RSPrimary', maxWireVersion: 25, iscryptd: false}},
            topology, pool: {generation: 0, checkOut: async () => connection, checkIn: () => {}}, monitor: null});
        client.topology = topology;
        client.connect = async () => client; // Explicitly no connection, listener or socket constructor is called.
        client.startSession = options => {
            const session = start(options), storage = controlledStart(options), transaction = session.withTransaction.bind(session), end = session.endSession.bind(session);
            actualSessions.push(session); sessionStorage.set(session, storage);
            session.withTransaction = (work, options) => transaction(async () => storage.withTransaction(async () => {
                session.storage = storage.storage;
                try {return await work(session);} finally {session.storage = null;}
            }, options), options);
            session.endSession = async (...args) => {try {return await end(...args);} finally {await storage.endSession();}};
            return session;
        };
        const mapped = args => args.map(value => value && typeof value === 'object' && sessionStorage.has(value.session)
            ? {...value, session: sessionStorage.get(value.session)} : value);
        client.db = (...args) => {
            const actual = db(...args), storage = controlledDb(...args);
            return new Proxy(actual, {get(target, property) {
                if (property === 'collection') return (...args) => {
                    const collection = storage.collection(...args);
                    return new Proxy(collection, {get(target, name) {
                        const value = Reflect.get(target, name); return typeof value === 'function' ? (...args) => value.apply(target, mapped(args)) : value;
                    }});
                };
                if (property === 'admin') return () => storage.admin();
                if (property === 'createCollection') return (...args) => storage.createCollection(...mapped(args));
                const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
            }});
        };
        return client;
    });
    controlled.client = await pool.get(1000);
    const state = await setupComplete(controlled);
    return {state, wire, actualSessions, responseFrames, rawDb, selectedServer, client: controlled.client, setFault: value => {fault = value;},
        close: async () => {await pool.close(); assert.ok(actualSessions.every(session => session.hasEnded));}};
}
async function populated() {
    const context = await fixture(), target = await admit(context.state, 1);
    await execute(context.state, target, async port => {port.put('collection', 'one', {name: 'one'}); port.put('collection', 'two', {name: 'two'});});
    await retire(context.state, target); return context;
}
const read = (context, limits = totals()) => context.state.compose(async port => ({rows: await port.all('collection')}), limits);
const report = (context, name) => console.log(JSON.stringify({kind: 'controlled-root-native-command', name,
    driver: '7.2.0', distinctDriverModules: true, realManagedClientAndSession: true, realServerCommand: true, actualSockets: false,
    commands: context.wire.map(row => ({command: row.command, maxTimeMS: row.maxTimeMS, transaction: row.transaction,
        transactionTimeoutMS: row.transactionTimeoutMS, omitMaxTimeMS: row.omitMaxTimeMS,
        actualClientIdentity: row.session.client === context.client, signal: row.signal instanceof AbortSignal}))}));

test('root managed client through the native factory preserves the exact empty-find server bound', async () => {
    const context = await fixture();
    try {
        assert.deepEqual((await read(context)).value.rows, []); assert.equal(context.wire.length, 1);
        assert.equal(context.wire[0].maxTimeMS, 1000, 'Actual public command/session path must not expand initial find maxTimeMS');
        report(context, 'empty');
    } finally {await context.close();}
});

test('root managed client/native adapter retains non-tailable getMore and exact cross-package session identity', async () => {
    const context = await populated();
    try {
        assert.equal((await read(context)).value.rows.length, 2); assert.equal(context.wire.length, 2);
        assert.deepEqual(context.wire.map(row => [row.command, row.maxTimeMS]), [['find', 1000], ['getMore', null]]);
        assert.equal(context.wire[0].session, context.wire[1].session); assert.equal(context.wire[0].session.client, context.client);
        report(context, 'exhaustion');
    } finally {await context.close();}
});

test('actual root-session callback retries share native attempt totals across the two driver modules', async () => {
    const context = await populated(); let injected = false;
    context.setFault(command => {if (command.getMore && !injected) {injected = true;
        throw new MongoServerError({ok: 0, code: 112, errmsg: 'controlled transaction retry', errorLabels: ['TransientTransactionError']});}});
    try {
        assert.equal((await read(context)).value.rows.length, 2); assert.equal(context.wire.length, 4);
        assert.notEqual(context.wire[0].transaction, context.wire[2].transaction);
        report(context, 'callback-retry');
    } finally {await context.close();}
});

test('a real root-session retry cannot submit a data command beyond the shared attempt budget', async () => {
    const context = await populated(); let injected = false;
    context.setFault(command => {if (command.getMore && !injected) {injected = true;
        throw new MongoServerError({ok: 0, code: 112, errmsg: 'controlled transaction retry', errorLabels: ['TransientTransactionError']});}});
    try {
        await assert.rejects(read(context, {...totals(), readAttempts: 3}), /attempt total/);
        assert.equal(context.wire.length, 3); assert.notEqual(context.wire[0].transaction, context.wire[2].transaction);
        report(context, 'retry-budget');
    } finally {await context.close();}
});

test('the native executor refuses a real foreign root-client session before controlled transport', async () => {
    const context = await fixture(), foreign = new MongoClient('mongodb://127.0.0.1:1'), session = foreign.startSession();
    try {
        await assert.rejects(executeCompleteKindCommand(context.client, 'stateful_fixture', {ping: 1},
            {session, signal: AbortSignal.timeout(1000)}), /same MongoClient/);
        assert.equal(context.wire.length, 0);
        report(context, 'foreign-session');
    } finally {await session.endSession(); await foreign.close(); await context.close();}
});

test('actual public facade drops the private option while the executor preserves it in the same root transaction', async () => {
    const context = await fixture(), session = context.client.startSession(), state = context.state;
    const command = {find: state.options.collectionPrefix + '_stateful_v2_r_' + state.declaration.digest,
        filter: {kind: 'collection'}, batchSize: 1, maxTimeMS: 1000,
        comment: {hyperion: 'stateful-complete-kind-v1', operation: 'kind'}};
    try {
        await session.withTransaction(async () => {
            await context.client.db(state.options.databaseName).command(command,
                {session, promoteLongs: false, omitMaxTimeMS: true, signal: AbortSignal.timeout(1000)});
            await executeCompleteKindCommand(context.client, state.options.databaseName, command,
                {session, promoteLongs: false, signal: AbortSignal.timeout(1000)});
        }, {readConcern: {level: 'snapshot'}, timeoutMS: 2000});
        assert.equal(context.wire.length, 2); assert.equal(context.wire[0].omitMaxTimeMS, null);
        assert.equal(context.wire[1].omitMaxTimeMS, true); assert.equal(context.wire[1].maxTimeMS, 1000);
        assert.equal(context.wire[0].timeoutContext, context.wire[1].timeoutContext);
        report(context, 'legacy-public-facade-characterization');
    } finally {await session.endSession(); await context.close();}
});

test('qualification gates await both sides of the actual root-managed native command', async () => {
    const context = await populated(), events = [], before = Promise.withResolvers(), after = Promise.withResolvers(),
        releaseBefore = Promise.withResolvers(), releaseAfter = Promise.withResolvers();
    const selection = context.client.topology.selectServer, command = context.selectedServer.command;
    let reading, settled = false;
    const dispose = installCompleteKindCommandHooks(context.client, context.state.options.databaseName, {
        beforeData: async input => {
            events.push(['before', input.find ? 'find' : 'getMore']);
            if (events.length === 1) {before.resolve(); await releaseBefore.promise;}
        },
        afterData: async (input, response) => {
            assert.equal(response, context.responseFrames.at(-1), 'Hook receives the exact actual Server.command response');
            events.push(['after', input.find ? 'find' : 'getMore']);
            if (events.length === 2) {after.resolve(); await releaseAfter.promise;}
        }});
    try {
        reading = read(context); reading.then(() => {settled = true;}, () => {settled = true;});
        assert.equal(await Promise.race([before.promise.then(() => 'before'), reading.then(() => 'bypassed', () => 'rejected')]), 'before');
        assert.equal(context.wire.length, 0); assert.equal(settled, false); releaseBefore.resolve();
        assert.equal(await Promise.race([after.promise.then(() => 'after'), reading.then(() => 'bypassed', () => 'rejected')]), 'after');
        assert.equal(context.wire.length, 1); assert.equal(settled, false); releaseAfter.resolve();
        assert.equal((await reading).value.rows.length, 2);
        assert.deepEqual(events, [['before', 'find'], ['after', 'find'], ['before', 'getMore'], ['after', 'getMore']]);
        assert.deepEqual(context.wire.map(row => [row.command, row.maxTimeMS]), [['find', 1000], ['getMore', null]]);
        report(context, 'qualification-hooks-awaited');
    } finally {
        releaseBefore.resolve(); releaseAfter.resolve(); await reading?.catch(() => {}); dispose();
        assert.equal(context.client.topology.selectServer, selection); assert.equal(context.selectedServer.command, command);
        await context.close();
    }
});

test('qualification gates exclude actual metadata commands and an unrelated managed client', async () => {
    const context = await fixture(), unrelated = await populated(), events = [], session = context.client.startSession();
    const dispose = installCompleteKindCommandHooks(context.client, context.state.options.databaseName, {
        beforeData: async input => {events.push(['before', input]);}, afterData: async input => {events.push(['after', input]);}});
    try {
        await session.withTransaction(async () => {
            assert.equal(await context.rawDb(context.state.options.databaseName).collection('unrelated_metadata')
                .findOne({_id: 'absent'}, {session}), null);
            assert.equal((await context.rawDb(context.state.options.databaseName).command({ping: 1}, {session})).ok, 1);
        }, {readConcern: {level: 'snapshot'}, timeoutMS: 2000});
        assert.equal((await read(unrelated)).value.rows.length, 2); assert.deepEqual(events, []);
        console.log(JSON.stringify({kind: 'controlled-qualification-hooks', name: 'metadata-unrelated-excluded',
            actualSockets: false, metadataFindOne: true, untaggedCommand: true, distinctManagedClient: true, hooks: events.length}));
    } finally {dispose(); await session.endSession(); await unrelated.close(); await context.close();}
});

test('the qualification before-data gate arms a getMore fault before the actual send and callback retry', async () => {
    const context = await populated(), before = [], after = []; let armed = false, injected = false;
    const dispose = installCompleteKindCommandHooks(context.client, context.state.options.databaseName, {
        beforeData: async input => {
            before.push(input.find ? 'find' : 'getMore');
            if (input.getMore && !armed) {
                armed = true; assert.equal(context.wire.length, 1);
                context.setFault(command => {if (command.getMore && !injected) {injected = true;
                    throw new MongoServerError({ok: 0, code: 112, errmsg: 'controlled gate-armed transaction retry',
                        errorLabels: ['TransientTransactionError']});}});
            }
        },
        afterData: async input => {after.push(input.find ? 'find' : 'getMore');}});
    try {
        assert.equal((await read(context)).value.rows.length, 2); assert.equal(armed, true); assert.equal(injected, true);
        assert.deepEqual(before, ['find', 'getMore', 'find', 'getMore']); assert.deepEqual(after, ['find', 'find', 'getMore']);
        assert.equal(context.wire.length, 4); assert.notEqual(context.wire[0].transaction, context.wire[2].transaction);
        report(context, 'qualification-gate-callback-retry');
    } finally {dispose(); await context.close();}
});

test('the qualification after-data gate cancels before native rows can be published', async () => {
    const context = await populated(); let cancelled = false, before = 0, after = 0;
    const dispose = installCompleteKindCommandHooks(context.client, context.state.options.databaseName, {
        beforeData: async () => {before++;}, afterData: async () => {after++; cancelled = true;}});
    try {
        await assert.rejects(context.state.compose(async port => ({rows: await port.all('collection')}), totals(),
            () => {if (cancelled) throw new Error('controlled gate-cancelled result');}), /controlled gate-cancelled result/);
        assert.equal(before, 1); assert.equal(after, 1); assert.equal(context.wire.length, 1);
        report(context, 'qualification-gate-cancel-late-result');
    } finally {dispose(); await context.close();}
});

test('qualification command wrappers preserve receiver, operation, timeout, extra arguments and response identity', async () => {
    const response = {}, selected = {}, argumentsSeen = [], events = [], client = {}, foreign = {};
    const server = {async command(...args) {assert.equal(this, server); argumentsSeen.push(args); return response;}};
    const selectionArgs = [{selector: true}, {session: true}, {extra: true}];
    client.topology = {async selectServer(...args) {assert.equal(this, client.topology); assert.deepEqual(args, selectionArgs); return server;}};
    server.topology = client.topology;
    const originalSelection = client.topology.selectServer, originalCommand = server.command;
    const operation = {commandName: 'runCommand', command: {find: 'rows', comment: {hyperion: 'stateful-complete-kind-v1'}},
        session: {client}, ns: {db: 'bounded'}, options: {signal: new AbortController().signal}, SERVER_COMMAND_RESPONSE_TYPE: {},
        buildCommand: () => {assert.fail('The hook must not build or mutate an operation');}};
    const timeout = {}, extra = {}, dispose = installCompleteKindCommandHooks(client, 'bounded', {
        beforeData: async input => {assert.equal(input, operation.command); events.push('before');},
        afterData: async (input, reply) => {assert.equal(input, operation.command); assert.equal(reply, response); events.push('after');}});
    try {
        selected.server = await client.topology.selectServer(...selectionArgs); assert.equal(selected.server, server);
        assert.equal(await selected.server.command(operation, timeout, extra), response);
        assert.deepEqual(argumentsSeen[0], [operation, timeout, extra]);
        assert.equal(argumentsSeen[0][0], operation); assert.equal(argumentsSeen[0][1], timeout); assert.equal(argumentsSeen[0][2], extra);
        assert.deepEqual(events, ['before', 'after']);
        for (const skipped of [{...operation, session: {client: foreign}}, {...operation, ns: {db: 'other'}},
            {...operation, commandName: 'find'}, {...operation, command: {find: 'rows'}},
            {...operation, command: {ping: 1, comment: operation.command.comment}}]) {
            assert.equal(await selected.server.command(skipped, timeout, extra), response);
        }
        assert.equal(events.length, 2); assert.equal(argumentsSeen.length, 6);
        console.log(JSON.stringify({kind: 'controlled-qualification-hooks', name: 'forwarding-and-scope',
            actualSockets: false, originalArguments: true, sameResponse: true, skippedOperations: 5}));
    } finally {dispose(); dispose(); assert.equal(client.topology.selectServer, originalSelection); assert.equal(server.command, originalCommand);}
});
