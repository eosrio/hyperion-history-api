import type {FastifyInstance, FastifyRequest} from 'fastify';
import type {StatefulRecord} from '@eosrio/hyperion-sdk/projection-stateful';
import {hLog} from '../../indexer/helpers/common_functions.js';
import type {ResolvedStatefulOwnerConfigurationV2} from '../../indexer/projection/stateful-config.js';
import {LEGACY_STATE_ROUTES_V1, type LegacyStateRequestV1, type LegacyStateRouteBackingV1, type LegacyStateRouteV1,
    type StatefulPluginApiContextV2} from '../../indexer/projection/stateful-plugin.js';

export type ProtocolProjection = 'contract-state' | 'native-permissions' | 'row-history' | 'action-filter';

export class ProtocolProjectionUnavailableError extends Error {
    readonly statusCode = 503;
    readonly code = 'protocol_projection_unavailable';
    readonly retryable = true;
    readonly headers = {'retry-after': '1'};
    constructor(readonly projection: ProtocolProjection) {
        super('The requested projection is not ready; retry later.');
        this.name = 'ProtocolProjectionUnavailableError';
    }
}

/** A backed route refused parameters its projection can never answer. Retrying does not help. */
export class ProtocolStateRequestError extends Error {
    readonly statusCode = 400;
    readonly code = 'invalid_state_request';
    constructor(message: string) {
        super(message);
        this.name = 'ProtocolStateRequestError';
    }
}

/** Legacy projections lack a qualified extension read view and canonical rollback.
 * A block-local ABI proof does not establish complete current state or query membership.
 * Routes leave this gate only through a backing resolved by resolveProtocolRouteBacking.
 */
export function assertProtocolProjectionReady(fastify: FastifyInstance, projection: ProtocolProjection): void {
    if (fastify.manager.config.settings?.protocol?.provider === 'extension') {
        throw new ProtocolProjectionUnavailableError(projection);
    }
}

const projections: Readonly<Record<string, ProtocolProjection>> = {
    get_deltas: 'row-history',
    get_table_state: 'row-history',
    get_table_rows: 'contract-state',
    get_tokens: 'contract-state',
    get_top_holders: 'contract-state',
    get_voters: 'contract-state',
    get_proposals: 'contract-state',
    get_voter_scopes: 'contract-state',
    get_links: 'native-permissions',
    // get_account is not listed: for extension providers it serves only node state and metadata action search.
};

interface StatefulRouteEntry {readonly plugin: string; readonly backing: LegacyStateRouteBackingV1}
/** Installed once, before core routes register; every request still needs its own ready owner. */
export interface ProtocolStateRoutes {
    readonly context: StatefulPluginApiContextV2;
    readonly routes: ReadonlyMap<LegacyStateRouteV1, StatefulRouteEntry>;
}
/** What answers a protocol route. A delta history watermark is the next kind, for row history. */
export type ProtocolRouteBacking =
    | {readonly kind: 'unavailable'; readonly projection: ProtocolProjection}
    | {readonly kind: 'stateful'; readonly projection: ProtocolProjection; readonly route: LegacyStateRouteV1} & StatefulRouteEntry;

/** Undefined keeps the route's own path: it is not a projection route, or the provider is not an extension. */
export function resolveProtocolRouteBacking(fastify: FastifyInstance, route: string): ProtocolRouteBacking | undefined {
    if (!Object.hasOwn(projections, route)) return undefined;
    const stateful = fastify.protocolStateRoutes?.routes.get(route as LegacyStateRouteV1);
    if (stateful) return {kind: 'stateful', projection: projections[route], route: route as LegacyStateRouteV1, ...stateful};
    if (fastify.manager.config.settings?.protocol?.provider !== 'extension') return undefined;
    return {kind: 'unavailable', projection: projections[route]};
}

/** Check before response-cache access as well as the underlying projection query. */
export function assertProtocolRouteReady(fastify: FastifyInstance, route: string): ProtocolRouteBacking | undefined {
    const backing = resolveProtocolRouteBacking(fastify, route);
    if (backing?.kind === 'unavailable') throw new ProtocolProjectionUnavailableError(backing.projection);
    return backing;
}

function data(value: object, name: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error(`Legacy state route field ${name} must be inert data`);
    return descriptor.value;
}
function plain(value: unknown, message: string): asserts value is object {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(message);
}
function backingFor(value: unknown, completeKind: boolean): LegacyStateRouteBackingV1 {
    plain(value, 'Legacy state route backing must be a plain object');
    const validates = Object.hasOwn(value, 'validate');
    if (Object.keys(value).length !== (validates ? 4 : 3)) throw new Error('Legacy state route backing has unknown fields');
    const projectionId = data(value, 'projectionId'), read = data(value, 'read'), compose = data(value, 'compose');
    const validate = validates ? data(value, 'validate') : undefined;
    if (validates && typeof validate !== 'function') throw new Error('Legacy state route validate must be a function');
    if (typeof projectionId !== 'string' || !projectionId.length || Buffer.byteLength(projectionId) > 256 || !projectionId.isWellFormed())
        throw new Error('Legacy state route projection ID is invalid');
    if (read !== 'keyed' && read !== 'complete-kind') throw new Error('Legacy state route read must be keyed or complete-kind');
    if (read === 'complete-kind' && !completeKind) throw new Error('Complete-kind reads are not offered by this host');
    if (typeof compose !== 'function') throw new Error('Legacy state route compose must be a function');
    return Object.freeze({projectionId, read, compose: (reader: unknown, request: LegacyStateRequestV1) => Reflect.apply(compose, value, [reader, request]),
        ...(validate ? {validate: (request: LegacyStateRequestV1) => Reflect.apply(validate as Function, value, [request])} : {})}) as LegacyStateRouteBackingV1;
}

/** Collect plugin backings for core state routes. Two plugins claiming one route leave it unavailable. */
export async function installProtocolStateRoutes(fastify: FastifyInstance, plugins: readonly object[], context: StatefulPluginApiContextV2,
    configuration: Pick<ResolvedStatefulOwnerConfigurationV2, 'maximumServingLagBlocks'>, log: (...message: unknown[]) => void = hLog): Promise<ProtocolStateRoutes> {
    const routes = new Map<LegacyStateRouteV1, StatefulRouteEntry>(), ambiguous = new Set<LegacyStateRouteV1>();
    const completeKind = typeof context.statefulCompleteKindQueryHost === 'function';
    const offer = Object.freeze({interfaceVersion: 1 as const, routes: LEGACY_STATE_ROUTES_V1, completeKindRead: completeKind});
    for (const plugin of plugins) {
        const hook = (plugin as {getLegacyStateRoutesV1?: unknown}).getLegacyStateRoutesV1;
        if (typeof hook !== 'function') continue;
        const name = String((plugin as {internalPluginName?: unknown}).internalPluginName ?? 'unnamed');
        try {
            const registration: unknown = await Reflect.apply(hook, plugin, [offer]);
            plain(registration, 'Legacy state routes must be a plain object');
            if (data(registration, 'interfaceVersion') !== 1) throw new Error('Plugin did not negotiate legacy state routes version1');
            const declared = data(registration, 'routes');
            plain(declared, 'Legacy state routes must map route names to backings');
            for (const route of Object.keys(declared)) {
                try {
                    if (!(LEGACY_STATE_ROUTES_V1 as readonly string[]).includes(route)) throw new Error(`Route ${route} cannot be backed by a plugin`);
                    const selected = route as LegacyStateRouteV1, backing = backingFor(data(declared, route), completeKind);
                    if (routes.has(selected) || ambiguous.has(selected)) {
                        routes.delete(selected); ambiguous.add(selected);
                        throw new Error(`Route ${route} is claimed by more than one plugin and stays unavailable`);
                    }
                    routes.set(selected, Object.freeze({plugin: name, backing}));
                } catch (error) {log(`Legacy state route from plugin "${name}" refused:`, error);}
            }
        } catch (error) {log(`Legacy state routes from plugin "${name}" unavailable:`, error);}
    }
    // Legacy bodies carry no view metadata clients check, so a catching-up owner must refuse instead.
    if (routes.size && configuration.maximumServingLagBlocks === undefined) {
        log('Plugin-backed state routes need features.stateful_owner_v2.maximumServingLagBlocks; they stay unavailable');
        routes.clear();
    }
    for (const [route, entry] of routes) log(`State route ${route} is backed by plugin "${entry.plugin}" projection ${entry.backing.projectionId}`);
    const installed: ProtocolStateRoutes = Object.freeze({context, routes});
    fastify.decorate('protocolStateRoutes', installed);
    return installed;
}

/** One request-local owner-v2 read. The host's final onSend check publishes or refuses the serialized body. */
export async function queryProtocolStateRoute(fastify: FastifyInstance, request: FastifyRequest,
    selected: Extract<ProtocolRouteBacking, {kind: 'stateful'}>): Promise<Record<string, unknown>> {
    const installed = fastify.protocolStateRoutes;
    if (!installed || installed.routes.get(selected.route)?.backing !== selected.backing) throw new ProtocolProjectionUnavailableError(selected.projection);
    const limit = (fastify.manager.config.api?.limits as Record<string, unknown> | undefined)?.[selected.route];
    const input: LegacyStateRequestV1 = Object.freeze({route: selected.route,
        query: Object.freeze(JSON.parse(JSON.stringify(request.query ?? {}))),
        ...(typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? {configuredLimit: limit} : {})});
    const backing = selected.backing, {projectionId} = backing;
    let refusal: unknown;
    try {refusal = backing.validate?.(input);} catch {throw new ProtocolProjectionUnavailableError(selected.projection);}
    if (refusal !== undefined) throw new ProtocolStateRequestError(typeof refusal === 'string' && refusal.length && refusal.isWellFormed()
        ? refusal.slice(0, 256) : 'This state route cannot answer the request');
    let value: object;
    if (backing.read === 'complete-kind') {
        const host = await installed.context.statefulCompleteKindQueryHost!(request, projectionId);
        value = (await host.compose(projectionId, reader => backing.compose(reader, input) as Promise<StatefulRecord>)).value;
    } else {
        value = (await installed.context.statefulQueryHost(request).compose(projectionId, reader => backing.compose(reader, input) as Promise<StatefulRecord>)).value;
    }
    // Composed records are frozen; the route adds its timing fields to this copy.
    return {...value};
}
