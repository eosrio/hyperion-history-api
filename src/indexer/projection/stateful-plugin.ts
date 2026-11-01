import type {StatefulDefinition, StatefulLimits, StatefulSelector} from '@eosrio/hyperion-sdk/projection-stateful';
import type {StatefulReductionV2, StatefulQueryHostV2, StatefulCompleteKindCapabilitiesV1,
    StatefulCompleteKindQueryHostV1} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
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
