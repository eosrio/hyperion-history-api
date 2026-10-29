import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import Fastify from 'fastify';
import autoLoad from '@fastify/autoload';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import plugin from 'fastify-plugin';
import {createPortableStateQueryService} from '../../build/indexer/projection/query-service.js';
import {portableStateBinding, resolvePortableStateConfiguration} from '../../build/indexer/projection/config.js';
import {STATE_RESPONSE_HEADERS} from '../../build/api/helpers/state-headers.js';

const require = createRequire(import.meta.url);

test('malformed URLs cannot enter a sibling plugin fallback or skip its authentication', async t => {
    // Vendor regression control, not evidence that a deployed Hyperion fallback exposes private data.
    const app = Fastify({logger: false});
    t.after(() => app.close());
    const seen = [];
    app.register(async scope => {
        scope.get('/ok', async () => ({public: true}));
        scope.setNotFoundHandler(async (_request, reply) => {
            seen.push('public'); reply.code(404).send({public: 'missing'});
        });
    }, {prefix: '/public'});
    app.register(async scope => {
        scope.get('/ok', async () => ({private: true}));
        scope.setNotFoundHandler({preHandler: async (request, reply) => {
            seen.push('authenticate');
            if (request.headers.authorization !== 'fixture-token') reply.code(401).send({error: 'unauthorized'});
        }}, async () => {seen.push('private'); return {private: 'protected-fallback'};});
    }, {prefix: '/private'});
    await app.ready();
    for (const method of ['POST', 'TRACE']) {
        const response = await app.inject({method, url: '/public/%FF'});
        assert.equal(response.statusCode, 400);
        assert.doesNotMatch(response.body, /protected-fallback/);
    }
    assert.deepEqual(seen, []);
    assert.equal((await app.inject('/public/missing')).statusCode, 404);
    assert.equal((await app.inject('/private/missing')).statusCode, 401);
    const allowed = await app.inject({url: '/private/missing', headers: {authorization: 'fixture-token'}});
    assert.deepEqual(allowed.json(), {private: 'protected-fallback'});
    assert.deepEqual(seen, ['public', 'authenticate', 'authenticate', 'private']);
});

test('header schemas enforce canonical-case propertyNames constraints', async t => {
    const app = Fastify({logger: false});
    t.after(() => app.close());
    let handled = 0;
    app.get('/headers', {schema: {headers: {type: 'object',
        propertyNames: {not: {enum: ['X-Debug-Override']}}}}}, async () => {handled++; return {ok: true};});
    for (const key of ['X-Debug-Override', 'x-debug-override', 'X-DEBUG-OVERRIDE']) {
        const response = await app.inject({url: '/headers', headers: {[key]: 'forbidden'}});
        assert.equal(response.statusCode, 400);
    }
    assert.equal(handled, 0);
    assert.equal((await app.inject('/headers')).statusCode, 200);
    assert.equal(handled, 1);
});

test('pinned Fastify plugins declare compatible metadata and execute the HTTP-only plugin stack', async t => {
    const metadataApp = Fastify({logger: false});
    t.after(() => metadataApp.close());
    for (const name of ['cors', 'formbody', 'http-proxy', 'mongodb', 'rate-limit', 'redis', 'static', 'swagger', 'swagger-ui']) {
        const implementation = require(`@fastify/${name}`);
        const metadata = implementation[Symbol.for('plugin-meta')];
        assert.ok(metadata, `${name} exposes Fastify compatibility metadata`);
        // Validate original versions/dependency names without opening Redis/MongoDB/upstream connections.
        metadataApp.register(plugin(async function compatibilityProbe() {}, metadata));
    }
    await metadataApp.ready();
    const app = Fastify({logger: false});
    t.after(() => app.close());
    await app.register(cors, {exposedHeaders: [...STATE_RESPONSE_HEADERS]});
    await app.register(formbody);
    await app.register(rateLimit, {max: 2, timeWindow: '1 minute'});
    app.post('/form', async request => ({body: request.body}));
    const first = await app.inject({method: 'POST', url: '/form', headers: {
        origin: 'https://example.invalid', 'content-type': 'application/x-www-form-urlencoded'}, payload: 'amount=0&active=false'});
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), {body: {amount: '0', active: 'false'}});
    for (const header of STATE_RESPONSE_HEADERS) assert.ok(first.headers['access-control-expose-headers'].includes(header));
    assert.equal((await app.inject({method: 'POST', url: '/form', payload: {}})).statusCode, 200);
    assert.equal((await app.inject({method: 'POST', url: '/form', payload: {}})).statusCode, 429);
});

test('emitted state query autoload preserves exact view headers, validation and the final source fence', async t => {
    const chainId = 'a'.repeat(64);
    const definition = {schemaVersion: 1, id: 'inventory', mappingRevision: 'b'.repeat(64),
        source: {contract: 'items', table: 'inventory', abiDeployment: 'source-deployment', abiSha256: 'c'.repeat(64)},
        fields: [{name: 'quantity', path: ['quantity'], type: 'integer'}], initialization: {kind: 'genesis'}};
    const configuration = resolvePortableStateConfiguration({backend: {kind: 'mongodb', id: 'backend', database: 'fixture'},
        projections: [definition]}, chainId);
    const binding = portableStateBinding(configuration, configuration.projections[0], chainId);
    const view = {binding, checkpoint: {blockNum: 3, blockId: 'd'.repeat(64)}};
    let queried = 0, revoked = false, fenced = 0;
    const adapter = {async open() {return structuredClone(view);}, async query(selected) {
        queried++; return {view: selected, rows: [{key: 'opaque-key', value: {quantity: 0}}]};
    }};
    const service = createPortableStateQueryService({chainId, configuration, adapter, gate: {
        async readReady() {return {definition: configuration.projections[0], view: structuredClone(view)};},
        async assertCurrent() {fenced++; if (revoked) throw Object.assign(new Error('changed owner'), {code: 'authority_changed'});},
    }});
    const app = Fastify({logger: false});
    t.after(() => app.close());
    app.decorate('portableState', service);
    await app.register(autoLoad, {dir: fileURLToPath(new URL('../../build/api/routes/v2-state/query/', import.meta.url)),
        dirNameRoutePrefix: false, ignorePattern: /.*(handler|schema).js/, options: {prefix: '/v2/state'}});
    const payload = {projection: 'inventory', query: {filter: [{field: 'quantity', op: 'eq', value: 0}], limit: 1}};
    const good = await app.inject({method: 'POST', url: '/v2/state/query', payload});
    assert.equal(good.statusCode, 200);
    assert.equal(good.headers['cache-control'], 'no-store');
    assert.equal(good.headers['hyperion-state-block-num'], '3');
    assert.equal(good.headers['hyperion-state-block-id'], view.checkpoint.blockId);
    assert.equal(good.headers['hyperion-state-last-valid'], 'false');
    assert.deepEqual(good.json().rows, [{key: 'opaque-key', value: {quantity: 0}}]);
    const bad = await app.inject({method: 'POST', url: '/v2/state/query', payload: {...payload, $where: 'not removed'}});
    assert.equal(bad.statusCode, 400);
    assert.equal(queried, 1);
    revoked = true;
    const unavailable = await app.inject({method: 'POST', url: '/v2/state/query', payload});
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.headers['retry-after'], '1');
    assert.equal(unavailable.headers['cache-control'], 'no-store');
    assert.equal(unavailable.headers['hyperion-state-block-num'], undefined);
    assert.equal(unavailable.headers['hyperion-state-block-id'], undefined);
    assert.equal(unavailable.json().code, 'authority_changed');
    assert.equal(unavailable.json().retryable, true);
    assert.equal(Object.hasOwn(unavailable.json(), 'rows'), false);
    assert.equal(fenced, 2);
});
