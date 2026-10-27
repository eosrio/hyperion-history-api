import type {
    ProjectionApplyRequest, ContextualProjectionApplyRequest, ProjectionBinding, ProjectionQuery,
    ProjectionRecord, ProjectionRollbackRecoveryView,
} from '@eosrio/hyperion-sdk/projection';
import type {RollbackMetadataDialect} from './rollback-contract.js';

export type RecoveryBatch = ProjectionApplyRequest | ContextualProjectionApplyRequest;
export interface RecoveryEnvelope<B> {readonly revision: string; readonly batch: B;}
/** Closed internal algorithms, selected by the two explicit factories, never by stored labels. */
export interface RecoveryDialect<D, B extends RecoveryBatch, C> extends RollbackMetadataDialect<D> {
    readonly capabilities: C;
    readonly allowLegacyAdoption: boolean;
    definition(input: D): D;
    activate(definition: D, binding: ProjectionBinding): void;
    capture(input: RecoveryEnvelope<B>): RecoveryEnvelope<B>;
    apply(definition: D, input: RecoveryEnvelope<B>, current: ProjectionRollbackRecoveryView): RecoveryEnvelope<B>;
    canonical(batch: B): string;
    resolve(definition: D, mutation: B['mutations'][number], previous: ProjectionRecord | null): ProjectionRecord | null;
    query(definition: D, query: ProjectionQuery): ProjectionQuery;
}
