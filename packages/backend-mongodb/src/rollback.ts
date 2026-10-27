import {
    canonicalProjectionBatch, PROJECTION_ROLLBACK_CAPABILITIES, validateProjectionDefinition,
    validateProjectionQuery, validateProjectionRollbackActivation, validateProjectionRollbackApply,
    validateProjectionRollbackApplyInput, type ProjectionApplyRequest, type ProjectionDefinition,
    type ProjectionRollbackAdapter, type ProjectionRollbackAdapterCapabilities,
} from '@eosrio/hyperion-sdk/projection';
import {valid} from './contract.js';
import {legacyMetadataDialect} from './rollback-contract.js';
import type {RecoveryDialect} from './rollback-dialect.js';
import {MongoDbRollbackEngine, type MongoDbRollbackAdapterOptions} from './rollback-engine.js';
export type {MongoDbRollbackAdapterOptions} from './rollback-engine.js';

const capabilities: ProjectionRollbackAdapterCapabilities = Object.freeze({
    interfaceVersion: 2, supported: PROJECTION_ROLLBACK_CAPABILITIES,
});
const dialect: RecoveryDialect<ProjectionDefinition, ProjectionApplyRequest, ProjectionRollbackAdapterCapabilities> = {
    ...legacyMetadataDialect, capabilities, allowLegacyAdoption: true,
    definition: input => valid(validateProjectionDefinition(input)),
    activate: (definition, binding) => {valid(validateProjectionRollbackActivation(definition, binding, capabilities));},
    capture: input => valid(validateProjectionRollbackApplyInput(input)),
    apply: (definition, input) => valid(validateProjectionRollbackApply(definition, input)),
    canonical: canonicalProjectionBatch,
    resolve: (_definition, mutation) => mutation.kind === 'delete' ? null : mutation.value,
    query: (definition, query) => valid(validateProjectionQuery(definition, query)),
};
/** Explicit opt-in: initialization upgrades only the selected immutable projection instance. */
export function createMongoDbRollbackAdapter(options: MongoDbRollbackAdapterOptions): ProjectionRollbackAdapter {
    return new MongoDbRollbackEngine(options, dialect);
}
