import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {statefulHostFixture} from './stateful-host-fixture.mjs';
import {definition, limits} from '../../packages/backend-mongodb/tests/stateful-fixture.mjs';
import {totals, offer} from '../../packages/backend-mongodb/tests/stateful-complete-kind-fixture.mjs';
import Plugin, {PROJECTION_ID} from '../fixtures/legacy-state-routes-v1/plugin/build/index.js';
assert.equal(process.versions.bun, undefined); assert.match(process.version, /^v(?:24|26)\./);

const load = path => import(new URL('../../build/' + path, import.meta.url));
const {installProtocolStateRoutes} = await load('api/helpers/protocol-state-readiness.js');
const routes = await Promise.all(['get_tokens', 'get_top_holders', 'get_voters'].map(async route =>
    (await load(`api/routes/v2-state/${route}/index.js`)).default));
const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(join(root, 'out'), {recursive: true}); // The fixture copies plugins under out/ so they resolve this checkout's SDK.
const template = () => {
    const {binding: _binding, ...rest} = definition();
    return {...rest, id: PROJECTION_ID, selectors: [{id: 'update', kind: 'action', contract: 'target', name: 'update'},
        {id: 'records', kind: 'table', contract: 'target', name: 'records'}]};
};
const configuration = completeKind => ({enabled: true, template: template(), limits: limits(),
    ...(completeKind ? {requiredCompleteKindRead: offer(totals())} : {})});

/** The actual owner-v2 host, worker probe and onSend fence, with core route modules registered after it. */
async function host({completeKind = false, lag = 64, provider = 'extension'} = {}) {
    const fixture = await statefulHostFixture({pluginDirectory: join(root, 'tests/fixtures/legacy-state-routes-v1/plugin'),
        pluginConfiguration: configuration(completeKind), projectionId: PROJECTION_ID, completeKind});
    const calls = [], logs = [];
    fixture.app.decorate('manager', {chain: 'legacy-state-routes', conn: {mongodb: {enabled: true, database_prefix: 'hyperion'}},
        config: {settings: {protocol: provider === 'extension' ? {provider: 'extension', package: '@eosrio/hyperion-wire-plugin'} : undefined},
            api: {enable_caching: true, cache_life: 60, limits: {get_tokens: 25}}, features: {tables: {voters: true}}}});
    fixture.app.decorate('redis', {
        get: async key => {calls.push(key.endsWith(':last_idx_block') ? 'last-indexed' : 'cache-read'); return null;},
        set: async () => {calls.push('cache-write'); return 'OK';}});
    const storage = async () => {calls.push('storage'); throw new Error('A plugin-backed route reached legacy storage');};
    fixture.app.decorate('mongo', {client: {db: storage}});
    fixture.app.decorate('elastic', {search: storage});
    await installProtocolStateRoutes(fixture.app, [new Plugin(configuration(completeKind))], fixture.context,
        lag === null ? {} : {maximumServingLagBlocks: lag}, (...message) => logs.push(message.join(' ')));
    for (const route of routes) await fixture.app.register(route, {prefix: '/v2/state'});
    return {fixture, calls, logs};
}
const legacyStorage = calls => calls.filter(call => call !== 'last-indexed');
let cases = 0;

for (const provider of ['extension', 'antelope']) {
    const {fixture, calls} = await host({provider});
    try {
        const response = await fixture.app.inject('/v2/state/get_tokens?account=alpha');
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json();
        assert.deepEqual({account: body.account, tokens: body.tokens},
            {account: 'alpha', tokens: [{symbol: 'HEIGHT', precision: 0, amount: 3, contract: 'target'}]});
        assert.equal(typeof body.query_time_ms, 'number');
        assert.equal(response.headers['hyperion-state-block-num'], '3');
        assert.equal(response.headers['hyperion-state-block-id'], fixture.p.positions[2].blockId);
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.ok(fixture.probes > 0, 'The worker must attest the served view');
        assert.deepEqual(legacyStorage(calls), [], `${provider}: a backed route touched the response cache or legacy storage`);
        cases++;
        if (provider === 'extension') {
            // A route without a backing keeps its refusal and never consults cache or storage.
            const voters = await fixture.app.inject('/v2/state/get_voters');
            assert.equal(voters.statusCode, 503, voters.body);
            assert.equal(voters.json().code, 'protocol_projection_unavailable');
            assert.deepEqual(legacyStorage(calls), []); cases++;
            // Retiring the owner refuses the backed route: declaring a backing grants nothing.
            fixture.supervisor.retire(fixture.parent);
            const retired = await fixture.app.inject('/v2/state/get_tokens?account=alpha');
            assert.equal(retired.statusCode, 503, retired.body);
            assert.equal(retired.headers['retry-after'], '1');
            assert.equal(retired.headers['hyperion-state-block-num'], undefined);
            assert(!retired.body.includes('HEIGHT'));
            assert.deepEqual(legacyStorage(calls), []); cases++;
        }
    } finally {await fixture.close();}
}

{
    const {fixture, calls} = await host({completeKind: true});
    try {
        const response = await fixture.app.inject('/v2/state/get_top_holders?contract=target&symbol=HEIGHT');
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json();
        assert.deepEqual(body.holders, [{owner: 'last', amount: 3, symbol: 'HEIGHT'}]);
        assert.equal(response.headers['hyperion-state-block-num'], '3');
        assert.deepEqual(legacyStorage(calls), []); cases++;
    } finally {await fixture.close();}
}

{
    // Without a serving lag bound a catching-up owner could answer, so nothing is installed.
    const {fixture, calls, logs} = await host({lag: null});
    try {
        const response = await fixture.app.inject('/v2/state/get_tokens?account=alpha');
        assert.equal(response.statusCode, 503, response.body);
        assert.equal(response.json().code, 'protocol_projection_unavailable');
        assert.ok(logs.some(line => line.includes('maximumServingLagBlocks')));
        assert.deepEqual(legacyStorage(calls), []); cases++;
    } finally {await fixture.close();}
}

console.log(JSON.stringify({cases, delegatedThroughOwnerHost: true, cacheBypassed: true, completeKindRoute: true,
    unbackedRoutesRefuse: true, lagBoundRequired: true}));
