/** Actual controller/runtime/adapter/API/auditor with controlled Mongo transport; no source proofs. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Fastify from 'fastify';
import {databaseFixture} from '../../packages/backend-mongodb/tests/fixture.mjs';
import {PortableStateController} from '../../build/indexer/projection/controller.js';
import {DeclarativeProjectionRuntime} from '../../build/indexer/projection/runtime.js';
import {resolvePortableStateConfiguration, portableStateBinding} from '../../build/indexer/projection/config.js';
import {createPortableStateReadGate} from '../../build/indexer/projection/production.js';
import {createPortableStateQueryService} from '../../build/indexer/projection/query-service.js';
import {portableStateQueryHandler} from '../../build/api/routes/v2-state/query/handler.js';
import {auditPortablePhysicalMongo} from '../../scripts/qualification/portable-state-worker-mongo.ts';

export const recorded = JSON.parse(readFileSync(new URL('../fixtures/portable-state-worker/mongo-1244.json', import.meta.url)));
const template = JSON.parse(readFileSync(new URL('../fixtures/portable-state-worker/plan.template.json', import.meta.url)));
let baseline;
export async function mongoSamplingComponent() {
    const {definition, binding, backend, source, failedBlock, checkpoint, change} = recorded;
    const healthyDefinition = template.definitions[0];
    const configuration = resolvePortableStateConfiguration({backend, projections: [definition, healthyDefinition]}, binding.chainId);
    assert.deepEqual(JSON.parse(JSON.stringify(portableStateBinding(configuration, definition, binding.chainId))), binding);
    const healthyBinding = portableStateBinding(configuration, healthyDefinition, binding.chainId);
    const fixture = databaseFixture(), adapter = fixture.adapter({backendId: backend.id, databaseName: backend.database});
    const frame = {chainId: binding.chainId, block: failedBlock, changes: [change]};
    if (baseline) for (const [name, rows] of structuredClone(baseline)) fixture.storage.set(name, rows);
    const runtime = await DeclarativeProjectionRuntime.create({adapter, definition, binding,
        genesis: {blockNum: 0, blockId: '0'.repeat(64)}, maximumPendingFrames: 1});
    if (!baseline) {
        const healthy = await DeclarativeProjectionRuntime.create({adapter, definition: healthyDefinition, binding: healthyBinding,
            genesis: {blockNum: 0, blockId: '0'.repeat(64)}, maximumPendingFrames: 1});
        for (let n = 1; n <= failedBlock.blockNum; n++) {
            const block = {...source[n - 1], previousBlockId: n === 1 ? '0'.repeat(64) : source[n - 2].blockId};
            if (n <= checkpoint.blockNum) await adapter.apply({binding, previous: {blockNum: n - 1, blockId: block.previousBlockId}, block, mutations: []});
            await healthy.process({chainId: binding.chainId, block, changes: n === failedBlock.blockNum ? [change] : []});
        }
        await assert.rejects(runtime.process(frame), /Required source field is missing/);
        baseline = structuredClone(fixture.storage);
    }
    const replicaSet = 'h45rs_' + '1'.repeat(32), state = {metadataReads: 0, hellos: 0, calls: [], beforeMetadata: undefined,
        beforeCount: undefined, beforeRows: undefined, changeHello: undefined, changeCollections: undefined, largeBuild: false};
    const values = (name, session) => [...(session?.storage ?? fixture.storage).get(name)?.values() ?? []];
    const cursor = (get, before = async () => {}) => {
        let maximum = Infinity;
        const c = {sort() {return c;}, limit(value) {maximum = value; return c;}, async close() {},
            async *[Symbol.asyncIterator]() {await before(); for (const item of get().slice(0, maximum)) yield structuredClone(item);}};
        return c;
    };
    const auditDb = {admin() {return {async command(command, options) {
        state.calls.push({operation: command.hello ? 'hello' : 'buildInfo', options});
        if (command.hello) {const value = {setName: replicaSet, isWritablePrimary: true, me: 'controlled-memory-only', primary: 'controlled-memory-only',
            topologyVersion: {processId: 'controlled-memory-only'}, maxWireVersion: 25}; state.hellos++; state.changeHello?.(value, state.hellos); return value;}
        return {version: state.buildVersion ?? '8.0.34', gitVersion: 'controlled-memory-only', ...(state.largeBuild ? {noise: 'x'.repeat(1024 * 1024)} : {})};
    }};}, listCollections(_filter, options) {
        state.calls.push({operation: 'listCollections', options});
        return cursor(() => {const values = [...fixture.storage.keys()].map(name => ({name, type: 'collection', options: {collation: {locale: 'simple'}}}));
            state.changeCollections?.(values); return values;});
    }, collection(name) {return {find(_filter, options) {
        state.calls.push({operation: 'find', name, options});
        return cursor(() => values(name, options.session), async () => {
            if (name === 'h45_projection_metadata') {await state.beforeMetadata?.(++state.metadataReads, options.session);
                if (options.session && !options.session.storage) options.session.storage = structuredClone(fixture.storage);}
            else await state.beforeRows?.(name, options.session);
        });
    }, async countDocuments(_filter, options) {
        state.calls.push({operation: 'countDocuments', name, options}); await state.beforeCount?.(name, options.session);
        return values(name, options.session).length;
    }};}};
    const client = {options: {directConnection: true, replicaSet, hosts: [{host: '127.0.0.1', port: 35000}]},
        startSession() {return {storage: null, startTransaction(options) {state.calls.push({operation: 'startTransaction', options});},
            async abortTransaction(options) {state.calls.push({operation: 'abortTransaction', options});}, async endSession() {state.calls.push({operation: 'endSession'});}};}, db() {return auditDb;}};
    const input = {client, database: backend.database, backendId: backend.id, chainId: binding.chainId, replicaSet,
        version: '8.0.34', through: recorded.actualBarrier, source, expectations: [
            {definition: healthyDefinition, binding: healthyBinding, checkpoint: source[1243], rows: template.barriers[0].rows[healthyDefinition.id]},
            {definition, binding, rows: [], checkpoint, failedBlock}]};
    let proofCalls = 0;
    const noProof = async () => {proofCalls++; assert.fail('Controlled sampling never returns source proof authority');};
    const app = Fastify();
    const gate = createPortableStateReadGate({chainId: binding.chainId, configuration, adapter,
        source: {open: noProof, revalidate: noProof, assertDefinition: noProof}});
    app.decorate('portableState', createPortableStateQueryService({chainId: binding.chainId, configuration, adapter, gate}));
    app.post('/v2/state/query', portableStateQueryHandler(app));
    return {input, fixture, adapter, runtime, frame, binding, definition, healthyBinding, state,
        async query() {const response = await app.inject({method: 'POST', url: '/v2/state/query', payload: {
            projection: definition.id, query: {filter: [], limit: 1}}});
            return {status: response.statusCode, headers: response.headers, body: response.json()};},
        recovery: operationTimeoutMS => (operationTimeoutMS === undefined ? adapter : fixture.adapter({backendId: backend.id,
            databaseName: backend.database, operationTimeoutMS})).recovery(binding), audit: options => auditPortablePhysicalMongo(input, options),
        async settle() {await assert.rejects(runtime.process(frame), /Required source field is missing/);},
        metadata: () => [...fixture.storage.get('h45_projection_metadata').values()].find(value => value.binding.projectionId === binding.projectionId),
        healthyMetadata: () => [...fixture.storage.get('h45_projection_metadata').values()].find(value => value.binding.projectionId === healthyBinding.projectionId),
        async retry() {
            let entered, release; const admitted = new Promise(resolve => {entered = resolve;}), held = new Promise(resolve => {release = resolve;});
            const config = resolvePortableStateConfiguration({backend, projections: [definition]}, binding.chainId);
            const controller = await PortableStateController.create({chainId: binding.chainId, configuration: config, adapter,
                source: {async frame(number, actual, admit) {assert.equal(number, failedBlock.blockNum); assert.equal(actual.id, definition.id);
                    await admit(failedBlock); entered(); await held; throw new Error('Controlled source boundary returns no proof');}, revalidate: noProof}});
            const draining = controller.drain(); await admitted;
            return {async close() {release(); await draining; await controller.stop();}};
        }, async close() {await app.close(); assert.equal(proofCalls, 0);}};
}
