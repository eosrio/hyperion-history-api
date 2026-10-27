import {
    CONTEXTUAL_PROJECTION_RECOVERY_ADAPTER_CAPABILITIES, ProjectionContractError,
    canonicalContextualProjectionBatch, resolveContextualProjectionMutation,
    validateContextualProjectionBinding, validateContextualProjectionDefinition,
    validateContextualProjectionRecoveryApply, validateContextualProjectionRecoveryApplyInput,
    validateContextualProjectionQuery, validateProjectionQueryInput, validateProjectionView,
    type ContextualProjectionApplyRequest, type ContextualProjectionDefinition,
    type ContextualProjectionRecoveryAdapter, type ContextualProjectionRecoveryAdapterCapabilities,
    type ProjectionValidationResult,
} from '@eosrio/hyperion-sdk/projection';
import {hash, slot, stableJson, validateReceiptProgress} from './contract.js';
import {invalidStorage} from './rollback-contract.js';
import type {RecoveryDialect} from './rollback-dialect.js';
import {MongoDbRollbackEngine, type MongoDbRollbackAdapterOptions} from './rollback-engine.js';

const storageVersion = 'h45-contextual-mongodb-recovery-v1';
const capabilities: ContextualProjectionRecoveryAdapterCapabilities = Object.freeze({
    family: 'contextual-table-recovery', interfaceVersion: 1,
    supported: CONTEXTUAL_PROJECTION_RECOVERY_ADAPTER_CAPABILITIES,
});
function checked<T>(result: ProjectionValidationResult<T>): T {
    if (result.valid) return result.value;
    const error = result.errors[0];
    switch (error.code) {
        case 'projection.capability-unavailable': case 'projection.not-initialized': case 'projection.incomplete':
        case 'projection.stale-view': case 'projection.stale-revision': case 'projection.conflicting-replay':
        case 'projection.rollback-unavailable': throw new ProjectionContractError(error.code, error.message);
        default: throw new ProjectionContractError('projection.invalid-contract', error.message);
    }
}
const dialect: RecoveryDialect<ContextualProjectionDefinition, ContextualProjectionApplyRequest,
    ContextualProjectionRecoveryAdapterCapabilities> = {
    storageVersion, capabilities, allowLegacyAdoption: false,
    definition: input => checked(validateContextualProjectionDefinition(input)),
    activate: (definition, binding) => {checked(validateContextualProjectionBinding(definition, binding));},
    capture: input => checked(validateContextualProjectionRecoveryApplyInput(input)),
    apply: (definition, input, current) => checked(validateContextualProjectionRecoveryApply(definition, input, current)),
    canonical: canonicalContextualProjectionBatch,
    resolve: (definition, mutation, previous) => checked(resolveContextualProjectionMutation(definition, mutation, previous)),
    query: (definition, input) => checked(validateContextualProjectionQuery(definition, input)),
    validateBase: (input, binding) => {
        if (input._id !== slot(binding) || stableJson(input.binding) !== stableJson(binding)) return invalidStorage();
        const definition = checked(validateContextualProjectionDefinition(input.definition));
        if (!validateContextualProjectionBinding(definition, binding).valid || input.definitionHash !== hash(definition)
            || !validateProjectionView({binding, checkpoint: input.checkpoint}).valid) return invalidStorage();
        validateReceiptProgress(input);
    },
    validBlock: (_definition, binding, previous, block) => !!block && typeof block === 'object'
        && Object.keys(block).sort().join(',') === 'blockId,blockNum,previousBlockId'
        && validateProjectionView({binding, checkpoint: previous}).valid
        && validateProjectionView({binding, checkpoint: {blockNum: block.blockNum, blockId: block.blockId}}).valid
        && block.blockNum === previous.blockNum + 1 && block.previousBlockId === previous.blockId,
    validRecord: (definition, _binding, _block, key, value) => {
        // Undo is physical prior state, not an absent source event or a contextual apply.
        if (!validateProjectionQueryInput({filter: [], limit: 1, afterKey: key}).valid) return false;
        if (value === null) return true;
        return resolveContextualProjectionMutation(definition, definition.preserveOnReplace.length
            ? {kind: 'put-preserving', key, value, preserveFields: definition.preserveOnReplace}
            : {kind: 'put', key, value}, null).valid;
    },
};

/** Explicit SDK recovery family. No legacy storage adoption, production selection or host activation. */
export function createMongoDbContextualRecoveryAdapter(options: MongoDbRollbackAdapterOptions): ContextualProjectionRecoveryAdapter {
    return new MongoDbRollbackEngine(options, dialect);
}
