import {describe, expect, test} from 'bun:test';
import fastify from 'fastify';
import autoLoad from '@fastify/autoload';
import {fileURLToPath} from 'node:url';
import {ProjectionContractError, PROJECTION_CAPABILITIES, type ProjectionAdapter,
    type ProjectionDefinition, type ProjectionReadView} from '@eosrio/hyperion-sdk/projection';
import {portableStateBinding, resolvePortableStateConfiguration} from '../../src/indexer/projection/config.js';
import {createPortableStateQueryService, type PortableStateReadContext} from '../../src/indexer/projection/query-service.js';
import {HyperionConfigSchema} from '../../src/interfaces/hyperionConfig.js';

const chainId = 'a'.repeat(64);
const definition: ProjectionDefinition = {schemaVersion: 1, id: 'inventory', mappingRevision: 'b'.repeat(64),
    source: {contract: 'items', table: 'inventory', abiDeployment: 'actual-source-deployment', abiSha256: 'c'.repeat(64)},
    fields: [{name: 'owner', path: ['owner'], type: 'string'}, {name: 'active', path: ['active'], type: 'boolean'},
        {name: 'quantity', path: ['quantity'], type: 'integer'}], initialization: {kind: 'genesis'}};
const input = () => ({backend: {kind: 'mongodb', id: 'chain-backend', database: 'portable_fixture'}, projections: [structuredClone(definition)]});

function fixture() {
    const configuration = resolvePortableStateConfiguration(input(), chainId)!;
    const binding = portableStateBinding(configuration, configuration.projections[0], chainId);
    let view: ProjectionReadView = {binding, checkpoint: {blockNum: 3, blockId: 'd'.repeat(64)}};
    let calls = 0, asserted = 0, initialized = 0;
    let changed = false, incomplete = false, revoked = false;
    const adapter: ProjectionAdapter = {capabilities: {interfaceVersion: 1, supported: [...PROJECTION_CAPABILITIES]},
        async initialize() {initialized++; throw new Error('The API must never initialize storage');},
        async apply() {throw new Error('The API must never apply');},
        async markIncomplete() {throw new Error('The API must never mark readiness');},
        async open() {
            if (incomplete) throw new ProjectionContractError('projection.incomplete', 'durable failure');
            return structuredClone(view);
        },
        async query(selected, query) {calls++;
            if (changed) view = {...view, checkpoint: {blockNum: 4, blockId: 'e'.repeat(64)}};
            return {view: selected, rows: [{key: 'opaque-key', value: {owner: 'alice', active: false, quantity: 0}}],
                ...(query.count ? {count: {value: 1, exact: true}} : {})};
        }};
    const gate = {async readReady(): Promise<PortableStateReadContext> {
        return {definition: configuration.projections[0], view: await adapter.open(binding)};
    }, async assertCurrent() {asserted++; if (revoked) throw Object.assign(new Error('replaced owner'), {code: 'authority_changed'});}};
    const service = createPortableStateQueryService({chainId, configuration, adapter, gate});
    return {configuration, binding, service, calls: () => calls, asserted: () => asserted, initialized: () => initialized,
        change: () => {changed = true;}, fail: () => {incomplete = true;}, revoke: () => {revoked = true;},
        genesis: () => {view = {...view, checkpoint: {blockNum: 0, blockId: '0'.repeat(64)}};}};
}

describe('portable state configuration', () => {
    test('explicit allowlist definitions are detached and instance identities survive unrelated additions/restart', () => {
        const original = input(), first = resolvePortableStateConfiguration(original, chainId)!;
        const next = input(); next.projections.push({...definition, id: 'other'});
        const extended = resolvePortableStateConfiguration(next, chainId)!;
        expect(first.configDigest).not.toBe(extended.configDigest);
        expect(portableStateBinding(first, first.projections[0], chainId)).toEqual(
            portableStateBinding(extended, extended.projections.find(value => value.id === definition.id)!, chainId));
        (original.projections[0].source as {contract: string}).contract = 'changed';
        expect(first.projections[0].source.contract).toBe('items');
        expect(resolvePortableStateConfiguration(undefined, chainId)).toBeUndefined();
        expect(portableStateBinding(first, first.projections[0], 'f'.repeat(64)).generation).not.toBe(
            portableStateBinding(first, first.projections[0], chainId).generation);
    });
    test('rejects native backend escape, operator ready flags, duplicate IDs and malformed fixed definitions', () => {
        const duplicate = input(); duplicate.projections.push(structuredClone(definition));
        for (const value of [{}, {...input(), ready: true}, {...input(), backend: {...input().backend, uri: 'mongodb://escape'}},
            {...input(), projections: []}, duplicate, {...input(), projections: [{...definition, initialization: {kind: 'head'}}]}]) {
            expect(() => resolvePortableStateConfiguration(value, chainId)).toThrow();
        }
        expect(() => resolvePortableStateConfiguration(input(), 'wrong-chain')).toThrow();
        const schema = HyperionConfigSchema.shape.features.shape.portable_state;
        expect(schema.safeParse(input()).success).toBe(true);
        expect(schema.safeParse(undefined).success).toBe(true);
        expect(schema.safeParse({...input(), ready: true}).success).toBe(false);
    });
});

describe('portable logical query service', () => {
    test('serves typed false/zero equalities with the exact durable view and no initialization writes', async () => {
        const f = fixture();
        const result = await f.service.query('inventory', {filter: [{field: 'active', op: 'eq', value: false},
            {field: 'quantity', op: 'eq', value: 0}], limit: 1, count: {upTo: 10}});
        expect(result.view.binding).toEqual(f.binding); expect(result.view.checkpoint.blockNum).toBe(3);
        expect(result.rows[0].value).toMatchObject({active: false, quantity: 0});
        expect(result.count).toEqual({value: 1, exact: true});
        expect(f.asserted()).toBe(1); expect(f.initialized()).toBe(0);
    });
    test('rejects native/unknown logical queries before source or database work', async () => {
        const f = fixture();
        for (const query of [{filter: [{$where: 'native'}], limit: 1}, {filter: [], limit: 1, sort: {_id: 1}},
            {filter: [{field: 'unknown', op: 'eq', value: 0}], limit: 1}]) {
            await expect(f.service.query('inventory', query)).rejects.toMatchObject({statusCode: 400});
        }
        await expect(f.service.query('other', {filter: [], limit: 1})).rejects.toMatchObject({statusCode: 404});
        expect(f.calls()).toBe(0);
    });
    test('zero coverage, durable failure, checkpoint advance and source replacement cannot publish rows', async () => {
        for (const mark of ['genesis', 'fail', 'change', 'revoke'] as const) {
            const f = fixture(); f[mark]();
            await expect(f.service.query('inventory', {filter: [], limit: 1})).rejects.toMatchObject({statusCode: 503, retryable: true});
        }
    });
});

test('real Fastify autoload route rejects native extras and emits served-view headers without the history cache', async () => {
    const f = fixture(), server = fastify();
    server.decorate('portableState', f.service);
    await server.register(autoLoad, {dir: fileURLToPath(new URL('../../src/api/routes/v2-state/query/', import.meta.url)),
        dirNameRoutePrefix: false, ignorePattern: /.*(handler|schema).ts/, options: {prefix: '/v2/state'}});
    try {
        const response = await server.inject({method: 'POST', url: '/v2/state/query', payload: {
            projection: 'inventory', query: {filter: [{field: 'quantity', op: 'eq', value: 0}], limit: 1, count: {upTo: 2}},
        }});
        expect(response.statusCode).toBe(200); expect(response.json().view.checkpoint.blockNum).toBe(3);
        expect(response.headers['hyperion-state-block-num']).toBe('3');
        expect(response.headers['hyperion-state-block-id']).toBe('d'.repeat(64));
        expect(response.headers['hyperion-state-last-valid']).toBe('false');
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json()).not.toHaveProperty('last_indexed_block');
        const invalid = await server.inject({method: 'POST', url: '/v2/state/query', payload: {
            projection: 'inventory', query: {filter: [], limit: 1}, $where: 'must not be silently removed',
        }});
        expect(invalid.statusCode).toBe(400); expect(invalid.headers['cache-control']).toBe('no-store');
        f.fail();
        const unavailable = await server.inject({method: 'POST', url: '/v2/state/query', payload: {
            projection: 'inventory', query: {filter: [], limit: 1},
        }});
        expect(unavailable.statusCode).toBe(503); expect(unavailable.json()).toMatchObject({code: 'projection.incomplete', retryable: true});
        expect(unavailable.headers['retry-after']).toBe('1');
        expect(unavailable.headers).not.toHaveProperty('hyperion-state-block-num');
    } finally {await server.close();}
});
