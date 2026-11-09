import {expect, test} from 'bun:test';
import {installProtocolStateRoutes, queryProtocolStateRoute, resolveProtocolRouteBacking, assertProtocolRouteReady,
    ProtocolProjectionUnavailableError} from '../../src/api/helpers/protocol-state-readiness.js';

function app(provider?: string) {
    const instance: any = {manager: {config: {settings: {protocol: provider ? {provider} : undefined}, api: {limits: {get_tokens: 25, get_top_holders: 0}}}},
        decorate(name: string, value: unknown) {instance[name] = value;}};
    return instance;
}
function context(completeKind = true) {
    const calls: unknown[][] = [];
    const host = (kind: string) => ({compose: async (projectionId: string, compose: (reader: unknown) => Promise<unknown>) => {
        calls.push([kind, projectionId]);
        return {view: {}, value: Object.freeze(await compose({kind}) as object)};
    }});
    return {calls, value: Object.freeze({statefulQueryHost: () => host('keyed'),
        ...(completeKind ? {statefulCompleteKindQueryHost: async () => host('complete-kind')} : {})})};
}
const keyed = (projectionId = 'tokens') => ({projectionId, read: 'keyed', compose: async (reader: unknown, request: unknown) => ({reader, request})});
const plugin = (routes: unknown, name = 'tokens-plugin') => ({internalPluginName: name, getLegacyStateRoutesV1: () => ({interfaceVersion: 1, routes})});
const lag = {maximumServingLagBlocks: 10};
const quiet = () => {};

test('extension routes without a backing refuse, and other providers keep their own path', () => {
    expect(resolveProtocolRouteBacking(app('extension'), 'get_tokens')).toEqual({kind: 'unavailable', projection: 'contract-state'});
    expect(() => assertProtocolRouteReady(app('extension'), 'get_links')).toThrow(ProtocolProjectionUnavailableError);
    expect(resolveProtocolRouteBacking(app(), 'get_tokens')).toBeUndefined();
    expect(resolveProtocolRouteBacking(app('extension'), 'get_actions')).toBeUndefined();
});

test('declared backings resolve per route; disallowed, malformed and ambiguous claims leave routes unavailable', async () => {
    const fastify = app('extension'), {value} = context(), logs: string[] = [];
    const accessor = {projectionId: 'tokens', read: 'keyed', get compose() {return async () => ({});}};
    await installProtocolStateRoutes(fastify, [
        plugin({get_tokens: keyed(), get_table_rows: keyed(), get_proposals: keyed(), get_deltas: keyed(),
            get_voters: {...keyed(), extra: true}, get_links: accessor, get_voter_scopes: {...keyed(), read: 'indexed'}}),
        plugin({get_top_holders: keyed('one')}, 'first'), plugin({get_top_holders: keyed('two')}, 'second'),
        {internalPluginName: 'broken', getLegacyStateRoutesV1: () => {throw new Error('broken plugin');}},
        {internalPluginName: 'old-version', getLegacyStateRoutesV1: () => ({interfaceVersion: 2, routes: {get_tokens: keyed()}})},
        {internalPluginName: 'without-hook'},
    ], value, lag, (...message: unknown[]) => logs.push(message.map(String).join(' ')));
    expect(resolveProtocolRouteBacking(fastify, 'get_tokens')).toMatchObject({kind: 'stateful', route: 'get_tokens', plugin: 'tokens-plugin',
        backing: {projectionId: 'tokens', read: 'keyed'}});
    for (const route of ['get_table_rows', 'get_proposals', 'get_deltas', 'get_voters', 'get_links', 'get_voter_scopes', 'get_top_holders'])
        expect(resolveProtocolRouteBacking(fastify, route)?.kind).toBe('unavailable');
    expect(logs.some(line => line.includes('more than one plugin'))).toBe(true);
    expect(logs.some(line => line.includes('broken plugin'))).toBe(true);
    expect(logs.some(line => line.includes('version1'))).toBe(true);
});

test('a complete-kind backing needs the host offer and a lag bound is required for any backing', async () => {
    const withoutOffer = app('extension');
    await installProtocolStateRoutes(withoutOffer, [plugin({get_top_holders: {...keyed(), read: 'complete-kind'}})], context(false).value, lag, quiet);
    expect(resolveProtocolRouteBacking(withoutOffer, 'get_top_holders')?.kind).toBe('unavailable');
    const withoutLag = app('extension');
    await installProtocolStateRoutes(withoutLag, [plugin({get_tokens: keyed()})], context().value, {}, quiet);
    expect(resolveProtocolRouteBacking(withoutLag, 'get_tokens')?.kind).toBe('unavailable');
});

test('the host composes each backing with a detached request and the right read', async () => {
    const fastify = app('extension'), {calls, value} = context();
    await installProtocolStateRoutes(fastify, [plugin({get_tokens: keyed('tokens'),
        get_top_holders: {projectionId: 'holders', read: 'complete-kind', compose: async (reader: unknown, request: unknown) => ({reader, request})}})], value, lag, quiet);
    const query = {account: 'alpha', nested: {limit: 5}}, request: any = {query};
    const tokens = await queryProtocolStateRoute(fastify, request, resolveProtocolRouteBacking(fastify, 'get_tokens') as any);
    expect(tokens).toEqual({reader: {kind: 'keyed'}, request: {route: 'get_tokens', query, configuredLimit: 25}});
    expect(Object.isFrozen(tokens)).toBe(false);
    expect((tokens.request as any).query).not.toBe(query);
    expect(Object.isFrozen((tokens.request as any).query)).toBe(true);
    const holders = await queryProtocolStateRoute(fastify, request, resolveProtocolRouteBacking(fastify, 'get_top_holders') as any);
    // A zero configured limit is not a limit; the plugin applies its own default.
    expect(holders).toEqual({reader: {kind: 'complete-kind'}, request: {route: 'get_top_holders', query}});
    expect(calls).toEqual([['keyed', 'tokens'], ['complete-kind', 'holders']]);
    // A backing that is not the installed one never reaches a host.
    await expect(queryProtocolStateRoute(fastify, request, {kind: 'stateful', projection: 'contract-state', route: 'get_tokens',
        plugin: 'forged', backing: keyed('tokens')} as any)).rejects.toBeInstanceOf(ProtocolProjectionUnavailableError);
    expect(calls.length).toBe(2);
});
