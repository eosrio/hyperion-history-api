// Real root driver -> native executor -> Server/Connection/session-response path.
// Only storage and the final wire response are controlled. No socket, server, child or service is created.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fixture, options, context} from './operator-list-fixture.mjs';
import {createMongoDbOperatorListSourceV1} from '../dist/operator-lists.js';
const rootRequire = createRequire(new URL('../../../package.json', import.meta.url));
const nativeRequire = createRequire(new URL('../package.json', import.meta.url));
const rootDriver = rootRequire('mongodb'), nativeDriver = nativeRequire('mongodb');
const {Server} = rootRequire('mongodb/lib/sdam/server.js');
const {Connection} = rootRequire('mongodb/lib/cmap/connection.js');
const {MongoDBResponse} = rootRequire('mongodb/lib/cmap/wire_protocol/responses.js');

export async function nativeSnapshotFixture(changes = {}) {
    const f = fixture(), storageClient = f.client, storageServer = await storageClient.topology.selectServer();
    const client = new rootDriver.MongoClient('mongodb://127.0.0.1:1', {retryReads: false, retryWrites: false, maxAdaptiveRetries: 0});
    const start = client.startSession.bind(client), commands = [], replies = [], sessions = [], operations = [];
    client.startSession = input => {
        const session = start(input); session.storage = structuredClone(f.storage);
        assert.equal(session.snapshotTime, undefined, 'No modeled snapshot timestamp may be seeded');
        sessions.push(session); f.sessions.push(session); return session;
    };
    // Publication writes retain the existing controlled storage. Counted reads use the real native executor below.
    client.db = database => storageClient.db(database);
    const connection = Object.create(Connection.prototype);
    Object.assign(connection, {description: {type: 'RSPrimary', maxWireVersion: 25, logicalSessionTimeoutMinutes: 30,
        loadBalanced: false}, monitorCommands: false, established: false, error: null, clusterTime: null});
    connection.sendWire = async function* (message, commandOptions, Response = MongoDBResponse) {
        const command = message.command, database = message.databaseName;
        if (command.endSessions) {yield Response.make(rootDriver.BSON.serialize({ok: 1})); return;}
        const collection = command.find ?? command.aggregate ?? command.collection ?? command.killCursors;
        // Cleanup must retain the original logical session on the wire, even when the
        // connection decorator is omitted for a command that cannot accept readConcern.
        const session = commandOptions.session ?? sessions.findLast(value => !value.hasEnded && command.lsid
            && rootDriver.BSON.serialize(command.lsid).equals(rootDriver.BSON.serialize(value.id)));
        assert.ok(session && sessions.includes(session), 'Wire request must bind a genuine original session');
        const store = session.storage;
        const exists = store.has(database + '.' + collection);
        commands.push({command, options: commandOptions, session, namespaceExisted: exists});
        if (Object.keys(command)[0] === 'killCursors' && command.readConcern !== undefined) {
            // MongoDB8.0.34 KillCursorsCmd::supportsReadConcern is false.
            yield Response.make(rootDriver.BSON.serialize({ok: 0, code: 72,
                errmsg: 'Command killCursors does not support readConcern'})); return;
        }
        const result = await storageServer.command({ns: {db: database}, buildCommand: () => command,
            buildOptions: () => ({...commandOptions, session})}, commandOptions.timeoutContext);
        const answer = result.toObject();
        // MongoDB8.0.34 find_cmd.cpp770-783 omits atClusterTime for a missing namespace.
        // Existing (even empty) collections follow791-795 and return the selected snapshot time.
        if (answer.cursor && exists && !command.getMore) {
            answer.cursor.atClusterTime = new rootDriver.Timestamp({t: f.version + 1000, i: 7});
        }
        if (f.changeReply) f.changeReply(answer, command);
        const response = Response.make(rootDriver.BSON.serialize(answer)); replies.push(response);
        yield response;
    };
    const server = Object.create(Server.prototype), topology = {s: {options: client.options}, lastHello: () => ({maxWireVersion: 25}),
        description: {type: 'ReplicaSetWithPrimary'}, logicalSessionTimeoutMinutes: 30, commonWireVersion: 25,
        selectServer: async () => server, close: async () => {}, closeCheckedOutConnections() {}, isConnected: () => true};
    Object.assign(server, {s: {state: 'connected', operationCount: 0,
        description: {address: '127.0.0.1:1', type: 'RSPrimary', maxWireVersion: 25, iscryptd: false}},
        topology, pool: {generation: 0, checkOut: async () => connection, checkIn() {}}, monitor: null});
    server.command = async (operation, timeoutContext) => {
        operations.push({operation, session: operation.session, timeoutContext});
        return Server.prototype.command.call(server, operation, timeoutContext);
    };
    client.topology = topology;
    const source = createMongoDbOperatorListSourceV1(options(f, {client, ...changes}));
    return {f, source, client, commands, replies, sessions, operations, rootDriver, nativeDriver,
        freshSource: () => createMongoDbOperatorListSourceV1(options(f, {client, ...changes})),
        publish: (ctx = context()) => source.publish({revision: 'data-one', expectedRevision: null,
            entries: [{name: 'schemas', items: ['one', 'two', 'three']}]}, ctx),
        async close() {source.retire(); for (const session of sessions) await session.endSession(); await client.close();}};
}
