// Controlled native command boundary. This cannot establish physical MongoDB acceptance.
import assert from 'node:assert/strict';
import {Long} from 'mongodb';
import {createMongoDbStatefulCompleteKindAdapterV1} from '../dist/stateful-complete-kind-v1.js';
import {ownerFixture, configured, sdk, ownerIdentity, guard} from './stateful-owner-v2-fixture.mjs';
export {sdk, createMongoDbStatefulCompleteKindAdapterV1};
export const totals = () => ({readAttempts: 12, responseRecords: 8, responseBytes: 65536});
export const offer = limits => ({family: sdk.STATEFUL_COMPLETE_KIND_FAMILY_V1, interfaceVersion: 1, limits});

export function completeFixture() {
    const fixture = ownerFixture(), dbFor = fixture.client.db.bind(fixture.client), start = fixture.client.startSession.bind(fixture.client);
    const sessions = new WeakSet(), cursors = new Map(), indexes = new Map(); let cursorSequence = 1;
    fixture.dataCommands = []; fixture.cleanup = []; fixture.indexes = indexes; fixture.beforeData = undefined; fixture.reply = undefined;
    fixture.emptyFirstBatch = false; fixture.sessions = []; fixture.client.options = {retryReads: false, retryWrites: false, maxAdaptiveRetries: 0};
    fixture.cursorIds = [];
    fixture.client.startSession = (...args) => {const session = start(...args); sessions.add(session); fixture.sessions.push(session); return session;};
    fixture.client.db = (database, ...args) => {
        const db = dbFor(database, ...args);
        return {...db,
            collection(name, ...collectionOptions) {
                const collection = db.collection(name, ...collectionOptions);
                if (!indexes.has(name)) indexes.set(name, [{name: '_id_', key: {_id: 1}}]);
                return {...collection,
                    async createIndex(key, options) {fixture.native.push({command: 'createIndex', name, key, options});
                        indexes.set(name, [...indexes.get(name).filter(index => index.name !== options.name), {key, ...options}]); return options.name;},
                    listIndexes() {return {toArray: async () => indexes.get(name)};}
                };
            },
            async command(command, options) {
                assert.ok(sessions.has(options.session), 'A session from a foreign/main client reached the counted client');
                const name = command.find ?? command.collection ?? command.killCursors;
                if (command.killCursors) {for (const id of command.cursors) cursors.delete(id.toString()); fixture.cleanup.push({command: 'killCursors', name}); return {ok: 1};}
                const type = command.find ? 'find' : command.getMore ? 'getMore' : 'unknown';
                assert.ok(['find', 'getMore'].includes(type));
                const trace = {command: type, value: command, session: options.session}; fixture.dataCommands.push(trace);
                if (fixture.beforeData) await fixture.beforeData(trace);
                const storage = options.session.storage;
                let state;
                if (command.find) {
                    const selected = [...(storage.get(name) ?? new Map()).values()].filter(row => command.filter._id ? row._id === command.filter._id : row.kind === command.filter.kind);
                    state = {name, rows: selected, offset: 0, id: fixture.cursorIds.shift() ?? Long.fromNumber(cursorSequence++)};
                    if (!command.singleBatch) cursors.set(state.id.toString(), state);
                } else {state = cursors.get(command.getMore.toString()); assert.ok(state, 'Unknown native cursor');}
                let batch;
                if (fixture.emptyFirstBatch && command.find && !command.singleBatch) {fixture.emptyFirstBatch = false; batch = [];}
                else {batch = state.rows.slice(state.offset, state.offset + 1); state.offset += batch.length;}
                const exhausted = command.singleBatch || state.offset === state.rows.length;
                if (exhausted) cursors.delete(state.id.toString());
                const answer = {ok: 1, cursor: {id: exhausted ? Long.ZERO : state.id, ns: database + '.' + name,
                    [command.find ? 'firstBatch' : 'nextBatch']: structuredClone(batch)}};
                if (fixture.reply) await fixture.reply(answer, trace); return answer;
            }
        };
    };
    return fixture;
}

export async function setupComplete(fixture = completeFixture(), limits = totals(), changes = {}) {
    const state = await configured(fixture, changes);
    state.adapter = await createMongoDbStatefulCompleteKindAdapterV1(state.options, limits);
    state.declaration = await sdk.negotiateStatefulOwnerV2(state.declaration.projection,
        {family: sdk.STATEFUL_OWNER_FAMILY_V2, interfaceVersion: 2, sourceInputVersions: [2], supported: sdk.STATEFUL_OWNER_HOST_CAPABILITIES_V2,
            limits: state.declaration.projection.limits}, state.adapter.capabilities);
    state.identity = ownerIdentity(); state.lease = await state.adapter.acquireOwner({expected: null, nextOwner: state.identity}, guard);
    state.compose = async (compose, selected = limits, authority = guard) => {
        const selection = sdk.negotiateStatefulCompleteKindV1(state.declaration, selected, offer(limits), state.adapter.completeKindCapabilities);
        const recovery = await state.adapter.recovery();
        return sdk.composeStatefulOwnerCompleteKindReadV1(selection, state.adapter, state.identity, recovery.view, compose, authority);
    };
    return state;
}
