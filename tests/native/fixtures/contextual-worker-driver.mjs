// Owned child preload: scripted BSON replaces only the external database wire/lifecycle boundary.
// The installed driver's command construction, monitoring events and write-concern error stay original.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {PassThrough} from 'node:stream';
import {MongoClient, BSON} from 'mongodb';
import {canonicalContextualProjectionBatch} from '@eosrio/hyperion-sdk/projection';

const require = createRequire(import.meta.url);
const driver = dirname(require.resolve('mongodb/package.json'));
const {Connection} = require(join(driver, 'lib/cmap/connection.js'));
const {MongoDBResponse} = require(join(driver, 'lib/cmap/wire_protocol/responses.js'));
const {Server} = require(join(driver, 'lib/sdam/server.js'));
const {ServerDescription} = require(join(driver, 'lib/sdam/server_description.js'));
const {FindOneAndUpdateOperation} = require(join(driver, 'lib/operations/find_and_modify.js'));
const input = readFileSync(process.env.H45_CONTEXTUAL_REPLY_JOB, 'utf8');
assert.ok(Buffer.byteLength(input) <= 128 * 1024);
const job = JSON.parse(input), scenario = process.env.H45_CONTEXTUAL_REPLY_SCENARIO;
assert.ok(['success', 'empty-write-errors', 'write-concern-error', 'write-errors', 'command-error'].includes(scenario));
const trace = value => writeSync(2, JSON.stringify({control: value}) + '\n');
const originalClose = MongoClient.prototype.close;

MongoClient.prototype.connect = async function () {
    const digest = createHash('sha256').update(canonicalContextualProjectionBatch(job.request.batch)).digest('hex');
    const pending = {block: job.request.batch.block, digest};
    const stored = {storageVersion: 'h45-contextual-mongodb-recovery-v1', binding: job.binding,
        revision: job.request.revision, checkpoint: job.request.batch.previous, pending};
    const reply = {ok: 1, value: stored};
    if (scenario === 'empty-write-errors') reply.writeErrors = [];
    if (scenario === 'write-concern-error') reply.writeConcernError = {code: 64, errmsg: 'Fixture majority unavailable'};
    if (scenario === 'write-errors') reply.writeErrors = [{index: 0, code: 11000, errmsg: 'Fixture write rejected'}];
    if (scenario === 'command-error') Object.assign(reply, {ok: 0, code: 121, errmsg: 'Fixture command rejected'});
    const stream = new PassThrough();
    const options = {id: 1, generation: 0, monitorCommands: true};
    const connection = new Connection(stream, options);
    connection.description.receiveResponse({ok: 1, isWritablePrimary: true, minWireVersion: 0, maxWireVersion: 27});
    connection.established = true;
    connection.sendWire = async function* () {yield MongoDBResponse.make(BSON.serialize(reply));};
    for (const name of ['commandStarted', 'commandSucceeded', 'commandFailed']) connection.on(name, event => {
        trace(name); this.emit(name, event);
    });
    const topology = {description: {type: 'Single'}, s: {options: {directConnection: true, retryWrites: false}}};
    const server = new Server(topology, new ServerDescription('127.0.0.1:34567'), options);
    server.s.state = 'connected';
    server.pool.checkOut = async () => connection;
    server.pool.checkIn = () => trace('connection-checked-in');
    const operation = new FindOneAndUpdateOperation(this.db(job.databaseName).collection(`${job.collectionPrefix}_metadata`),
        {_id: 'controlled-wire-intent'}, {$set: {pending}}, {writeConcern: {w: 'majority', j: true}, returnDocument: 'after'});
    try {
        // This original call emits commandSucceeded before its original write-concern check.
        await server.command(operation);
        trace('driver-command-fulfilled');
        throw new Error('Controlled database reply reached its caller without a crash receipt');
    } catch (error) {
        trace({driverRejected: error.name, code: error.code ?? null, message: error.message});
        throw error;
    } finally {stream.destroy(); await server.pool.close();}
};
MongoClient.prototype.close = async function () {
    trace('client-close');
    await originalClose.call(this);
};
