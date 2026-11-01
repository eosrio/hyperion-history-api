import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
import type {MongoClient} from 'mongodb';
import {captureStatefulDeclaration} from '@eosrio/hyperion-sdk/projection-stateful';
import type {StatefulView} from '@eosrio/hyperion-sdk/projection-stateful';
import {negotiateStatefulActionMetadataV2, type StatefulActionMetadataOptionsV2} from '@eosrio/hyperion-sdk/projection-stateful-source-v2';
import {captureStatefulOwnerDeclarationV2, negotiateStatefulOwnerV2, STATEFUL_OWNER_FAMILY_V2,
    STATEFUL_OWNER_HOST_CAPABILITIES_V2, type StatefulOwnerAdapterV2, type StatefulOwnerDeclarationV2,
    type StatefulReductionV2, STATEFUL_COMPLETE_KIND_FAMILY_V1, negotiateStatefulCompleteKindV1,
    type StatefulCompleteKindAdapterV1, type StatefulCompleteKindSelectionV1} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {createMongoDbStatefulOwnerAdapterV2} from '@eosrio/hyperion-backend-mongodb/stateful-owner-v2';
import {createMongoDbStatefulCompleteKindAdapterV1} from '@eosrio/hyperion-backend-mongodb/stateful-owner-complete-kind-v1';
import {createMongoDbStatefulIndexedAdapterV1, type MongoDbStatefulIndexedAdapterV1} from '@eosrio/hyperion-backend-mongodb/stateful-owner-indexed-query-v1';
import {captureIndexedDeclarationV1, negotiateIndexedQueryV1, STATEFUL_INDEXED_QUERY_FAMILY_V1, type IndexedDeclarationV1, type IndexedLimitsV1}
    from '@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1';
import type {HyperionModuleLoader} from '../modules/loader.js';
import {installedRuntimeArtifacts} from '../helpers/runtime-artifacts.js';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';
import type {ProtocolSourceProfile} from '../protocol/source-bindings.js';
import type {PortableProjectionSource} from './source.js';
import type {ResolvedStatefulOwnerConfigurationV2} from './stateful-config.js';
import type {StatefulPluginProjectionV2, StatefulPluginRegistrationV2} from './stateful-plugin.js';
import {STATEFUL_SOURCE_CAPABILITIES_V2} from './stateful-source.js';

const hash = (input: unknown) => createHash('sha256').update(protocolImmutableJson(input)).digest('hex');
export interface RegisteredStatefulProjectionV2 {
    readonly declaration: StatefulOwnerDeclarationV2; readonly adapter: StatefulOwnerAdapterV2;
    readonly reduce: (port: StatefulReductionV2) => Promise<void>;
    readonly sourceMetadata: StatefulActionMetadataOptionsV2;
    readonly completeKind?: {readonly adapter: StatefulCompleteKindAdapterV1; readonly selection: StatefulCompleteKindSelectionV1};
    readonly indexed?: {readonly adapter: MongoDbStatefulIndexedAdapterV1;
        readonly models: ReadonlyMap<string, {readonly declaration: IndexedDeclarationV1; readonly limits: IndexedLimitsV1}>};
}
interface RegistryOptions {
    chainId: string; configuration: ResolvedStatefulOwnerConfigurationV2; mongo: MongoClient; client: Client;
    source: PortableProjectionSource; profile: ProtocolSourceProfile; onError?: (projection: string, error: unknown) => void;
    completeKindMongo?: () => Promise<MongoClient>;
}
/** Existing enabled plugins, one host-owned immutable declaration per projection ID. */
export class StatefulProjectionRegistryV2 {
    readonly entries = new Map<string, RegisteredStatefulProjectionV2>();
    private readonly templates = new Map<string, {template: StatefulPluginProjectionV2; binding: import('@eosrio/hyperion-sdk/projection-stateful').StatefulDefinition['binding']}>();
    private readonly invalid = new Set<string>();
    private initializing?: Promise<void>;
    private constructor(private readonly options: RegistryOptions) {}
    static async create(options: RegistryOptions, loader: HyperionModuleLoader) {
        const registry = new StatefulProjectionRegistryV2(options), runtime = await installedRuntimeArtifacts(true);
        for (const entry of loader.statefulPluginsV2()) {
            const binding = Object.freeze({chainId: options.chainId, backendId: options.configuration.backend.id,
                generation: hash(['hyperion-stateful-instance-v2', options.chainId, options.configuration.generation]),
                mappingRevision: hash(['hyperion-stateful-plugin-mapping-v2', entry.configuration]),
                hookArtifact: entry.hookArtifact, hookRevision: hash(['hyperion-stateful-hook-v2', entry.hookArtifact, entry.configuration]),
                codecRevision: hash(['hyperion-stateful-codecs-v2', runtime.executableSha256, entry.hookArtifact, options.profile]),
                normalizerRevision: hash(['hyperion-stateful-normalizer-v2', runtime.executableSha256, options.profile])});
            let registration: StatefulPluginRegistrationV2;
            try {
                registration = await entry.plugin.getStatefulProjectionsV2(Object.freeze({binding, sourceCapabilities: STATEFUL_SOURCE_CAPABILITIES_V2,
                    ...(options.completeKindMongo ? {indexedQuery:Object.freeze({family:STATEFUL_INDEXED_QUERY_FAMILY_V1, interfaceVersion:1 as const})} : {}),
                    ...(options.completeKindMongo ? {completeKindRead: Object.freeze({family: STATEFUL_COMPLETE_KIND_FAMILY_V1, interfaceVersion: 1 as const})} : {})}));
                if (registration?.interfaceVersion !== 2 || registration.sourceInputVersion !== 2 || !Array.isArray(registration.projections)
                    || registration.projections.length > 32)
                    throw new Error('Plugin did not negotiate stateful owner/source version2');
            } catch (error) {options.onError?.(entry.plugin.internalPluginName, error); continue;}
            for (const template of registration.projections) {
                try {
                    const required = Object.getOwnPropertyDescriptor(template, 'requiredSourceCapabilities');
                    if (required && (!required.enumerable || !Object.hasOwn(required, 'value')))
                        throw new Error('Stateful source requirements must be inert data');
                    const requiredSourceCapabilities = required ? required.value : [];
                    negotiateStatefulActionMetadataV2(requiredSourceCapabilities, STATEFUL_SOURCE_CAPABILITIES_V2);
                    const complete = Object.getOwnPropertyDescriptor(template, 'requiredCompleteKindRead');
                    if (complete && (!complete.enumerable || !Object.hasOwn(complete, 'value') || !complete.value
                        || typeof complete.value !== 'object' || Array.isArray(complete.value) || !options.completeKindMongo))
                        throw new Error('Complete-kind requirements must be supported inert data');
                    const indexed = Object.getOwnPropertyDescriptor(template, 'requiredIndexedQueries');
                    if (indexed && (!indexed.enumerable || !Object.hasOwn(indexed,'value') || !Array.isArray(indexed.value)
                        || indexed.value.length > 32)) throw new Error('Indexed model requirements must be finite inert data');
                    const inert = JSON.parse(protocolImmutableJson({definition: template.definition, limits: template.limits,
                        requiredSourceCapabilities, ...(complete ? {requiredCompleteKindRead: complete.value} : {}),
                        ...(indexed ? {requiredIndexedQueries:indexed.value} : {})}));
                    const id = inert.definition.id;
                    if (typeof id !== 'string' || !id || typeof template.reduce !== 'function') throw new Error('Invalid stateful plugin template');
                    if (registry.templates.size + registry.invalid.size >= 32 && !registry.templates.has(id)) throw new Error('Per-chain projection budget exceeded');
                    if (registry.templates.has(id) || registry.invalid.has(id)) {
                        registry.templates.delete(id); registry.invalid.add(id); throw new Error('Stateful plugin projection ID is ambiguous');
                    }
                    const reduce = template.reduce;
                    registry.templates.set(id, {template: Object.freeze({...inert, reduce: (port: StatefulReductionV2) => Reflect.apply(reduce, template, [port])}), binding});
                } catch (error) {options.onError?.(entry.plugin.internalPluginName, error);}
            }
        }
        return registry;
    }
    initializeMissing(): Promise<void> {
        if (this.initializing) return this.initializing;
        this.initializing = this.initialize().finally(() => {this.initializing = undefined;}); return this.initializing;
    }
    async assertSourceView(declaration: StatefulOwnerDeclarationV2, view: StatefulView): Promise<void> {
        const proof = await this.options.source.open(view.checkpoint);
        await this.options.source.assertStatefulView(proof, declaration);
        await this.options.source.revalidate(proof);
    }
    private async initialize(): Promise<void> {
        for (const [id, entry] of this.templates) {
            if (this.entries.has(id)) continue;
            try {
                const {template, binding} = entry, selected = await this.options.source.statefulSelectors(template.definition.selectors);
                const projection = await captureStatefulDeclaration({...template.definition, binding, selectors: selected.selectors}, template.limits);
                const declaration = await captureStatefulOwnerDeclarationV2(projection, 2), c = this.options.configuration;
                // The explicit generation chooses a private namespace. Changing an ABI does not silently adopt or mutate it.
                const prefix = 'h45s_' + hash([this.options.chainId, c.generation]).slice(0, 24);
                const required = template.requiredCompleteKindRead, requestedIndexed = template.requiredIndexedQueries ?? [];
                if (required && !this.options.completeKindMongo) throw new Error('Complete-kind native query capability unavailable');
                const nativeOptions = {client: required || requestedIndexed.length && this.options.completeKindMongo ? await this.options.completeKindMongo!() : this.options.mongo,
                    databaseName: c.backend.database, backendId: c.backend.id, collectionPrefix: prefix, declaration, receiptRetention: c.recovery.receipts,
                    rollbackRetentionBlocks: c.recovery.blocks, rollbackRetentionBytes: c.recovery.bytes, rollbackMaxBlockBytes: c.recovery.maxBlockBytes,
                    operationTimeoutMS: c.operationTimeoutMS, transactionTimeoutMS: c.transactionTimeoutMS};
                const original = required ? await createMongoDbStatefulCompleteKindAdapterV1(nativeOptions, required.limits)
                    : await createMongoDbStatefulOwnerAdapterV2(nativeOptions);
                const negotiated = await negotiateStatefulOwnerV2(projection, {family:STATEFUL_OWNER_FAMILY_V2, interfaceVersion:2,
                    sourceInputVersions:[2], supported:STATEFUL_OWNER_HOST_CAPABILITIES_V2, limits:projection.limits}, original.capabilities);
                // Capture models only after actual native owner negotiation. This is declarative syntax capture;
                // the native receiving module recaptures independently and verifies each returned digest.
                const models = new Map<string, {declaration:IndexedDeclarationV1; limits:IndexedLimitsV1}>(), invalidModels = new Set<string>();
                for (const item of requestedIndexed) {
                    try {
                        const captured = await captureIndexedDeclarationV1(negotiated,item.modelRevision,item.model), id = captured.model.id;
                        if (models.has(id) || invalidModels.has(id)) {models.delete(id); invalidModels.add(id); throw new Error('Indexed model ID is ambiguous');}
                        const syntax = {family:STATEFUL_INDEXED_QUERY_FAMILY_V1, interfaceVersion:1 as const, queryDeclarationDigests:[captured.digest],
                            comparisonProfiles:[captured.model.textComparison], limits:item.limits};
                        const checked = negotiateIndexedQueryV1(captured,item.limits,syntax,syntax);
                        models.set(id,Object.freeze({declaration:captured,limits:checked.limits}));
                    } catch (error) {this.options.onError?.(id,error);}
                }
                const indexedEnabled = models.size > 0 && !!this.options.completeKindMongo;
                const adapter = indexedEnabled ? await createMongoDbStatefulIndexedAdapterV1(nativeOptions,[...models.values()],required?.limits,original) : original;
                await this.options.source.revalidate(selected.proof);
                const sourceMetadata = negotiateStatefulActionMetadataV2(template.requiredSourceCapabilities, STATEFUL_SOURCE_CAPABILITIES_V2);
                const completeKind = required ? {adapter: adapter as StatefulCompleteKindAdapterV1,
                    selection: negotiateStatefulCompleteKindV1(negotiated, required.limits, required,
                        (adapter as StatefulCompleteKindAdapterV1).completeKindCapabilities)} : undefined;
                this.entries.set(id, Object.freeze({declaration: negotiated, adapter, sourceMetadata, ...(completeKind ? {completeKind: Object.freeze(completeKind)} : {}),
                    ...(indexedEnabled ? {indexed:Object.freeze({adapter:adapter as MongoDbStatefulIndexedAdapterV1,models})} : {}),
                    reduce: async port => {await template.reduce(port);}}));
            } catch (error) {this.options.onError?.(id, error);}
        }
    }
}
