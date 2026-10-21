import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import Fastify from 'fastify';
import type {ProjectionCheckpoint, ProjectionDefinition} from '@eosrio/hyperion-sdk/projection';
import {createMongoDbProjectionAdapter} from '../../packages/backend-mongodb/src/index.js';
import {hash, slot, snapshot, STORAGE_VERSION, storedRecord} from '../../packages/backend-mongodb/src/contract.js';
import {portableStateBinding, resolvePortableStateConfiguration} from '../../src/indexer/projection/config.js';
import {createPortableStateReadGate} from '../../src/indexer/projection/production.js';
import {createPortableStateQueryService} from '../../src/indexer/projection/query-service.js';
import {portableStateQueryHandler} from '../../src/api/routes/v2-state/query/handler.js';

export const admissionReason = 'Canonical projection source admitted; durable application is pending';

/** Actual adapter/runtime/API consumers; only Mongo transport and seeded prior records are constructed. */
export function projectionFailureFixture(definition: ProjectionDefinition, chainId: string, checkpoint: ProjectionCheckpoint) {
    const configuration = resolvePortableStateConfiguration({backend: {kind: 'mongodb', id: 'fixture-backend', database: 'fixture'},
        projections: [definition]}, chainId)!;
    const binding = portableStateBinding(configuration, definition, chainId);
    let state: any = {metadata: snapshot({_id: slot(binding), storageVersion: STORAGE_VERSION, definition,
        definitionHash: hash(definition), binding, checkpoint, initialized: true, pending: null, gap: null,
        receipts: [{...checkpoint, digest: 'e'.repeat(64)}]}), rows: new Map([['old-key', storedRecord('old-key', {owner: 'alice'})]])};
    const calls: any[] = [];
    const faults = {rejectAdmission: false, loseAdmissionReceipt: false, rejectDetailedMarker: false, rejectCompletion: false, casMiss: false};
    const selected = (options?: any) => options?.session?.state ?? state;
    const change = (filter: any, update: any, options?: any) => {
        const target = selected(options);
        if (!Object.entries(filter).every(([key, value]) => isDeepStrictEqual(target.metadata[key], value))) return null;
        target.metadata = {...target.metadata, ...snapshot(update.$set)};
        if (options?.session) options.session.dirty = true;
        return snapshot(target.metadata);
    };
    const metadata = {
        async insertOne() {throw Object.assign(new Error('existing initialized fixture'), {name: 'MongoServerError', code: 11000});},
        async findOne(_filter: any, options?: any) {return snapshot(selected(options).metadata);},
        async findOneAndUpdate(filter: any, update: any, options: any) {
            calls.push({command: 'findAndModify', filter: snapshot(filter), update: snapshot(update), options});
            if (faults.casMiss) {faults.casMiss = false; return null;}
            const isAdmission = update.$set.pending?.reason === admissionReason && update.$set.pending?.digest === null;
            if ((isAdmission && faults.rejectAdmission) || (!isAdmission && faults.rejectDetailedMarker && update.$set.pending?.digest === null))
                throw new Error('injected pre-persistence failure marker rejection');
            const result = change(filter, update, options);
            if (isAdmission && faults.loseAdmissionReceipt) {faults.loseAdmissionReceipt = false; throw new Error('lost durable admission receipt');}
            return result;
        },
        async updateOne(filter: any, update: any, options: any) {
            calls.push({command: 'update', filter: snapshot(filter), update: snapshot(update), options});
            if (faults.rejectCompletion || faults.rejectDetailedMarker) throw new Error('injected update rejection');
            return {matchedCount: change(filter, update, options) === null ? 0 : 1};
        },
    };
    const records = {
        async replaceOne(filter: any, record: any, options: any) {
            calls.push({command: 'replace', options}); assert.ok(options.session);
            selected(options).rows.set(filter._id, snapshot(record)); options.session.dirty = true;
        },
        async deleteOne(filter: any, options: any) {selected(options).rows.delete(filter._id); options.session.dirty = true;},
        find(_filter: any, options: any) {
            const rows = [...selected(options).rows.values()];
            return {sort() {return this;}, limit() {return this;}, async *[Symbol.asyncIterator]() {yield* rows;}, async close() {}};
        },
    };
    const client: any = {db() {return {
        admin() {return {async command() {return {setName: 'fixture', isWritablePrimary: true, logicalSessionTimeoutMinutes: 30, maxWireVersion: 25};}};},
        collection(name: string) {return name.endsWith('_metadata') ? metadata : records;},
    };}, startSession() {
        const session: any = {async withTransaction(operation: () => Promise<unknown>) {
            session.state = structuredClone(state); session.dirty = false;
            const result = await operation();
            if (session.dirty) state = session.state;
            return result;
        }, async endSession() {}};
        return session;
    }};
    const createAdapter = () => createMongoDbProjectionAdapter({client, databaseName: 'fixture', backendId: 'fixture-backend'});
    return {configuration, binding, createAdapter, adapter: createAdapter(), faults, calls,
        metadata: () => snapshot(state.metadata), rows: () => structuredClone(state.rows)};
}

export async function projectionFailureApi(fixture: ReturnType<typeof projectionFailureFixture>, source: any) {
    const app = Fastify(), {configuration, adapter} = fixture, chainId = fixture.binding.chainId;
    const gate = createPortableStateReadGate({chainId, configuration, adapter, source});
    app.decorate('portableState', createPortableStateQueryService({chainId, configuration, adapter, gate}));
    app.post('/v2/state/query', portableStateQueryHandler(app));
    return {app, async query() {return app.inject({method: 'POST', url: '/v2/state/query', payload: {
        projection: configuration.projections[0].id, query: {filter: [], limit: 1},
    }});}};
}
