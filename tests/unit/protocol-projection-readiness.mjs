import assert from 'node:assert/strict';
import Fastify from 'fastify';

const routes = [
    ['v2-history', 'get_deltas', 'getDeltasHandler'],
    ['v2-history', 'get_table_state', 'getTableStateHandler'],
    ['v2-state', 'get_table_rows', 'getTableRowsHandler'],
    ['v2-state', 'get_tokens', 'getTokensHandler'],
    ['v2-state', 'get_top_holders', 'getTopHoldersHandler'],
    ['v2-state', 'get_voters', 'getVotersHandler'],
    ['v2-state', 'get_proposals', 'getProposalsHandler'],
    ['v2-state', 'get_voter_scopes', 'getVoterScopesHandler'],
    ['v2-state', 'get_links', 'getLinksHandler'],
    ['v2-state', 'get_account', 'getAccountHandler'],
];
const factories = await Promise.all(routes.map(async ([domain, route, handler]) => {
    const module = await import(`../../build/api/routes/${domain}/${route}/${route}.js`);
    return {route, handler: module[handler]};
}));
const profileId = process.env.HYPERION_WIRE_PROFILE;
const poison = {rows: [{orphan: true}], tokens: [{orphan: true}], links: [{orphan: true}],
    actions: [{act: {data: {orphan: true}}}], retainedLegacyCache: true};

async function fixture(extension, disabled = false) {
    const app = Fastify({logger: false});
    const calls = [];
    app.decorate('manager', {chain: 'projection-readiness', conn: {mongodb: {enabled: !disabled}},
        config: {settings: {protocol: extension ? {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId} : undefined},
            api: {enable_caching: true, cache_life: 60, limits: {}},
            features: {tables: {voters: !disabled, proposals: !disabled}}}});
    app.decorate('redis', {get: async key => {
        calls.push('cache-read');
        return key.endsWith(':last_idx_block') ? null : JSON.stringify(poison);
    }, set: async () => {calls.push('cache-write'); return 'OK';}});
    const unexpected = async () => {calls.push('storage'); throw new Error('Unready projection reached storage');};
    app.decorate('elastic', {search: unexpected});
    app.decorate('mongo', {client: {db: unexpected}});
    app.decorate('antelope', {getAccountUntyped: unexpected});
    for (const {route, handler} of factories) app.get('/' + route, handler(app, route));
    await app.ready();
    return {app, calls};
}

for (const disabled of [false, true]) {
    const {app, calls} = await fixture(true, disabled);
    try {
        for (const {route} of factories) {
            const response = await app.inject({method: 'GET', url: '/' + route + '?account=alpha&contract=alpha&table=records'});
            assert.equal(response.statusCode, 503, route + ': ' + response.body);
            assert.equal(response.json().code, 'protocol_projection_unavailable', route);
            assert.equal(response.headers['retry-after'], '1', route);
            assert(!response.body.includes('orphan'), route);
        }
        assert.deepEqual(calls, [], 'Unready extension projections consulted or published cached/storage data');
    } finally {await app.close();}
}

// Retained Antelope projection caches remain usable; the extension gate does not cause a reindex.
const {app, calls} = await fixture(false);
try {
    for (const {route} of factories) {
        const response = await app.inject({method: 'GET', url: '/' + route});
        assert.equal(response.statusCode, 200, route + ': ' + response.body);
        assert.equal(response.json().retainedLegacyCache, true, route);
    }
    assert(calls.includes('cache-read'));
    assert(!calls.includes('storage'));
} finally {await app.close();}
console.log(JSON.stringify({passed: true, profileId, guardedRoutes: routes.length,
    poisonedCache: true, disabledFeatures: true, retainedAntelopeHistory: true}));
