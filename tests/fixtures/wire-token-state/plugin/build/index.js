import { check } from './codec.js';
import { resolveTokenProjectionOptions, tokenProjectionDefinition, tokenReducer } from './token-projection.js';
import { tokenRoutes } from './token-routes.js';
export { PROJECTION_ID, VERIFIED_TOKEN_CONTRACTS, balanceKey, holdersKind, symbolKey, resolveTokenProjectionOptions, tokenProjectionDefinition, tokenReducer } from './token-projection.js';
export { decodeScopedKey, formatAsset, nameFromUint64, parseAsset, symbolCodeFromUint64, TokenProjectionError } from './codec.js';
export { tokenRoutes } from './token-routes.js';
/** SDK bounds for one block of token rows and for each read. A block or response beyond them fails closed. */
export const TOKEN_PROJECTION_LIMITS = Object.freeze({
    value: Object.freeze({ depth: 8, nodes: 8192, fields: 32, arrayElements: 1024, stringBytes: 1024, recordBytes: 131072, integerFields: 4, pathSegments: 4 }),
    envelope: Object.freeze({ depth: 48, nodes: 200000, fields: 64, arrayElements: 8192, stringBytes: 2097152, recordBytes: 4194304,
        integerFields: 8, pathSegments: 16 }),
    selectors: 8, recordKinds: 16, inputOccurrences: 2048, inputBytes: 2097152, keyBytes: 256, readKeys: 32, readAttempts: 8192,
    mutations: 8192, candidateBytes: 4194304, responseRecords: 4096, responseBytes: 4194304,
});
/** Ranking reads every holder of one symbol; more holders than this refuse rather than rank part of them. */
export const TOP_HOLDERS_READ = Object.freeze({ readAttempts: 64, responseRecords: 4096, responseBytes: 4194304 });
const COMPLETE_KIND = 'stateful-owner-complete-kind';
/**
 * Wire contract state for Hyperion 4.5: token balances, holdings and supply from token-shaped contracts.
 * HAPI owns the source, ABI authority, storage, recovery and HTTP; this plugin only reduces rows and composes bodies.
 */
export default class WireStatePlugin {
    internalPluginName = 'wire-state';
    hasApiRoutes = false;
    options;
    constructor(config = {}) {
        check(config.enabled === true, 'The wire-state plugin must be enabled explicitly');
        this.options = resolveTokenProjectionOptions(config.tokens ?? {});
    }
    getStatefulProjectionsV2(context = {}) {
        const completeKind = this.options.ranked.length > 0 && context.completeKindRead?.family === COMPLETE_KIND
            && context.completeKindRead.interfaceVersion === 1;
        const reduce = tokenReducer(this.options);
        return { interfaceVersion: 2, sourceInputVersion: 2, projections: [{
                    definition: tokenProjectionDefinition(this.options),
                    limits: TOKEN_PROJECTION_LIMITS,
                    reduce: (port) => reduce(port),
                    ...(completeKind ? { requiredCompleteKindRead: { family: COMPLETE_KIND, interfaceVersion: 1, limits: TOP_HOLDERS_READ } } : {}),
                }] };
    }
    getLegacyStateRoutesV1(context) {
        check(context?.interfaceVersion === 1, 'Unsupported legacy state route interface');
        const routes = tokenRoutes(this.options);
        return { interfaceVersion: 1, routes: {
                ...(context.routes.includes('get_tokens') ? { get_tokens: routes.get_tokens } : {}),
                ...(context.completeKindRead && this.options.ranked.length && context.routes.includes('get_top_holders')
                    ? { get_top_holders: routes.get_top_holders } : {}),
            } };
    }
}
