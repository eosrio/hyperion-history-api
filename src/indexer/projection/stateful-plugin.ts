import type {StatefulDefinition, StatefulLimits, StatefulQueryRead, StatefulSelector} from '@eosrio/hyperion-sdk/projection-stateful';
import type {StatefulReductionV2, StatefulQueryHostV2, StatefulCompleteKindCapabilitiesV1,
    StatefulCompleteKindQueryHostV1, StatefulCompleteKindReadV1} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import type {FastifyRequest} from 'fastify';
import type {IndexedLimitsV1, IndexedModelV1, IndexedQueryHostV1} from '@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1';

/** Plugins declare logical selection; only the canonical source host fills ABI occurrences/hashes. */
export interface StatefulProjectionTemplateV2 extends Omit<StatefulDefinition, 'binding' | 'selectors'> {
    readonly selectors: readonly Omit<StatefulSelector, 'abiDeployment' | 'abiSha256'>[];
}
export interface StatefulPluginProjectionV2 {
    readonly definition: StatefulProjectionTemplateV2;
    readonly limits: StatefulLimits;
    readonly reduce: (reduction: StatefulReductionV2) => void | Promise<void>;
    /** Source metadata requirements; the host must negotiate these before creating an owner. */
    readonly requiredSourceCapabilities?: readonly string[];
    /** Optional negotiated query extension with explicit totals; old get-only projections omit it. */
    readonly requiredCompleteKindRead?: StatefulCompleteKindCapabilitiesV1;
    /** Logical requirements only; materialization, native access paths and profile readiness remain adapter-owned. */
    readonly requiredIndexedQueries?: readonly {readonly modelRevision: string; readonly model: IndexedModelV1; readonly limits: IndexedLimitsV1}[];
}
export interface StatefulPluginRegistrationV2 {
    readonly interfaceVersion: 2;
    readonly sourceInputVersion: 2;
    readonly projections: readonly StatefulPluginProjectionV2[];
}
export interface StatefulPluginHostContextV2 {
    /** Host owns backend, stable instance, actual hook artifacts and mapping/codec revisions. */
    readonly binding: StatefulDefinition['binding'];
    /** Actual retained-original metadata supplied by this host, never a serving grant. */
    readonly sourceCapabilities?: readonly string[];
    readonly completeKindRead?: Pick<StatefulCompleteKindCapabilitiesV1, 'family' | 'interfaceVersion'>;
    readonly indexedQuery?: {readonly family: 'stateful-owner-indexed-query'; readonly interfaceVersion: 1};
}
/** Optional method on the existing loaded Hyperion plugin; it is not another executable loader. */
export interface StatefulPluginV2 {
    getStatefulProjectionsV2(context: StatefulPluginHostContextV2): StatefulPluginRegistrationV2 | Promise<StatefulPluginRegistrationV2>;
}
/** Version2 authority is request-local; metadata/open/read DTOs can never construct this host. */
export interface StatefulOwnerQueryHostV2 extends StatefulQueryHostV2 {
    readonly interfaceVersion: 2;
    readonly sourceInputVersion: 2;
}
/** Additive second argument to existing plugin.addRoutes; all HTTP authority remains in HAPI. */
export interface StatefulPluginApiContextV2 {
    readonly statefulQueryHost: (request: FastifyRequest) => StatefulOwnerQueryHostV2;
    readonly statefulCompleteKindQueryHost?: (request: FastifyRequest, projectionId: string) => Promise<StatefulCompleteKindQueryHostV1>;
    readonly statefulIndexedQueryHost?: (request: FastifyRequest, projectionId: string, modelId: string) => Promise<IndexedQueryHostV1>;
}

/** Core routes a plugin projection may answer. get_table_rows and get_proposals stay unavailable, and
 * row history (get_deltas, get_table_state) needs a history watermark rather than a projection. */
export const LEGACY_STATE_ROUTES_V1 = Object.freeze(['get_tokens', 'get_top_holders', 'get_voters', 'get_voter_scopes', 'get_links'] as const);
export type LegacyStateRouteV1 = typeof LEGACY_STATE_ROUTES_V1[number];
/** Validated request parameters only; the plugin never receives the HTTP request or reply. */
export interface LegacyStateRequestV1 {
    readonly route: LegacyStateRouteV1;
    readonly query: Readonly<Record<string, unknown>>;
    /** The operator's api.limits entry for this route, when set. */
    readonly configuredLimit?: number;
}
/** HAPI opens the request-local read and fences publication; the plugin only composes the legacy body. */
export type LegacyStateRouteBackingV1 = {
    readonly projectionId: string;
    readonly read: 'keyed';
    readonly compose: (reader: StatefulQueryRead, request: LegacyStateRequestV1) => Promise<unknown>;
} | {
    readonly projectionId: string;
    /** Requires the projection's negotiated complete-kind read; without it the route refuses. */
    readonly read: 'complete-kind';
    readonly compose: (reader: StatefulCompleteKindReadV1, request: LegacyStateRequestV1) => Promise<unknown>;
};
export interface LegacyStateRoutesContextV1 {
    readonly interfaceVersion: 1;
    readonly routes: readonly LegacyStateRouteV1[];
    readonly completeKindRead: boolean;
}
export interface LegacyStateRoutesV1 {
    readonly interfaceVersion: 1;
    readonly routes: Readonly<Partial<Record<LegacyStateRouteV1, LegacyStateRouteBackingV1>>>;
}
/** Optional, additive. Plugin routes register before core routes, so core delegates instead of the plugin
 * registering the same path. Declaring a backing grants nothing: each request still needs a ready owner. */
export interface LegacyStateRoutePluginV1 {
    getLegacyStateRoutesV1(context: LegacyStateRoutesContextV1): LegacyStateRoutesV1 | Promise<LegacyStateRoutesV1>;
}
