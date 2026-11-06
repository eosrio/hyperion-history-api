import {createMongoDbProjectionAdapter, createMongoDbRollbackAdapter, createMongoDbContextualRecoveryAdapter,
    type MongoDbRollbackAdapterOptions} from '@eosrio/hyperion-backend-mongodb';
import {CONTEXTUAL_PROJECTION_RECOVERY_HOST_CAPABILITIES, CONTEXTUAL_PROJECTION_RECOVERY_ADAPTER_CAPABILITIES,
    validateContextualProjectionRecoveryActivation, type ContextualProjectionDefinition,
    type ContextualProjectionRecoveryAdapter, type ProjectionRollbackAdapter} from '@eosrio/hyperion-sdk/projection';
if ([createMongoDbProjectionAdapter, createMongoDbRollbackAdapter, createMongoDbContextualRecoveryAdapter].some(value => typeof value !== 'function'))
    throw new Error('Installed adapter factories are missing');
const definition: ContextualProjectionDefinition = {schemaVersion:2,id:'installed',mappingRevision:'a'.repeat(64),
    source:{contract:'token',table:'items',abiDeployment:'deployment',abiSha256:'b'.repeat(64)},
    fields:[{name:'created',type:'string',source:{kind:'context',field:'blockNum',format:'decimal'}}],
    initialization:{kind:'genesis'},preserveOnReplace:['created'],onAbsent:'incomplete'};
const binding = {chainId:'c'.repeat(64),backendId:'installed',projectionId:definition.id,mappingRevision:definition.mappingRevision,
    abiDeployment:definition.source.abiDeployment,abiSha256:definition.source.abiSha256,generation:'instance'};
if (!validateContextualProjectionRecoveryActivation(definition,binding,
    {family:'contextual-table-recovery',interfaceVersion:1,supported:CONTEXTUAL_PROJECTION_RECOVERY_HOST_CAPABILITIES},
    {family:'contextual-table-recovery',interfaceVersion:1,supported:CONTEXTUAL_PROJECTION_RECOVERY_ADAPTER_CAPABILITIES}).valid)
    throw new Error('Installed exact SDK recovery family is unavailable');
function contextual(options: MongoDbRollbackAdapterOptions): ContextualProjectionRecoveryAdapter {
    return createMongoDbContextualRecoveryAdapter(options);
}
function legacy(options: MongoDbRollbackAdapterOptions): ProjectionRollbackAdapter {
    return createMongoDbRollbackAdapter(options);
}
function distinct(old: ProjectionRollbackAdapter): void {
    // @ts-expect-error Legacy capabilities and apply batches cannot silently become contextual recovery.
    const contextual: ContextualProjectionRecoveryAdapter = old;
    void contextual;
}
void contextual; void legacy; void distinct;
console.log('Installed legacy/contextual factories and exact SDK declarations passed; no database connection attempted.');
