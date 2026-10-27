import {ProjectionContractError, type ContextualProjectionContext, type ProjectionValidationResult} from '@eosrio/hyperion-sdk/projection';
import type {ProjectionFrame} from './runtime.js';

/** Original provider context remains outside decoded/untrusted table values. No authority in this DTO. */
export interface ContextualProjectionFrame extends ProjectionFrame {
    readonly context: ContextualProjectionContext['source'];
}
export function contextualChecked<T>(result: ProjectionValidationResult<T>): T {
    if (result.valid) return result.value;
    const error = result.errors[0];
    switch (error.code) {
        case 'projection.capability-unavailable': case 'projection.not-initialized': case 'projection.incomplete':
        case 'projection.stale-view': case 'projection.stale-revision': case 'projection.conflicting-replay':
        case 'projection.rollback-unavailable': throw new ProjectionContractError(error.code, error.message);
        default: throw new ProjectionContractError('projection.invalid-contract', error.message);
    }
}
/** Qualified Wire716 block_timestamp_type: canonical UTC without suffix, exact milliseconds.
 * No local-time parsing, coercion, wall-clock fallback or timestamp from a decoded row.
 */
export function originalProjectionTimeMs(input: unknown): number {
    if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(input))
        throw new ProjectionContractError('projection.invalid-contract', 'Original provider timestamp must be canonical UTC with exact milliseconds');
    const milliseconds = Date.parse(input + 'Z');
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || new Date(milliseconds).toISOString() !== input + 'Z')
        throw new ProjectionContractError('projection.invalid-contract', 'Original provider timestamp is not an exact supported UTC instant');
    return milliseconds;
}
