import type {estypes} from '@elastic/elasticsearch';

export class ActionHistoryUnavailableError extends Error {
    readonly statusCode = 503;
    readonly code = 'ACTION_SEQUENCE_COVERAGE_UNAVAILABLE';

    constructor(message: string) {
        super(message);
        this.name = 'ActionHistoryUnavailableError';
    }
}

export interface ActionHistoryIndexIdentity {
    readonly name: string;
    readonly uuid: string;
}

export interface ActionHistorySnapshot {
    /** The actual PIT opened over exactly these concrete index identities. */
    readonly pitId: string;
    readonly indices: readonly ActionHistoryIndexIdentity[];
}

/**
 * Backend-private seam for the durable source/replay journal, not an operator
 * assertion that surviving Elasticsearch rows look complete. The authority must
 * cover missing rows, empty source blocks, producer/filter revisions and canonical
 * recovery as well as precision of the surviving metadata.
 *
 * A lease binds its coverage generation to this PIT and the concrete index UUIDs.
 * assertComplete proves the entire logical predicate, including all Boolean
 * branches, and every legacy sequence leaf used by the mixed-cohort compiler.
 * assertCurrent fences forks, replay/deletion and replacement of certified data.
 * Append-only writes outside this immutable PIT need not invalidate its lease.
 */
export interface ActionHistoryCoverageLease {
    readonly generation: string;
    readonly source: string;
    readonly indices: readonly ActionHistoryIndexIdentity[];
    assertComplete(query: estypes.QueryDslQueryContainer, signal: AbortSignal): Promise<void>;
    assertCurrent(signal: AbortSignal): Promise<void>;
    release(): Promise<void>;
}

export interface ActionHistoryCoverageAuthority {
    acquire(snapshot: ActionHistorySnapshot, signal: AbortSignal): Promise<ActionHistoryCoverageLease>;
}

/** Default until a source-backed coverage authority is integrated with the host. */
export const unavailableActionHistoryCoverage: ActionHistoryCoverageAuthority = {
    async acquire() {
        throw new ActionHistoryUnavailableError('Exact action history source coverage has not been qualified');
    }
};

export function assertCompleteActionHistorySearch(result: {
    timed_out?: boolean;
    terminated_early?: boolean;
    _shards?: {total?: number; successful?: number; failed?: number; skipped?: number};
}): void {
    if (result.timed_out === true || result.terminated_early === true) {
        throw new ActionHistoryUnavailableError('Elasticsearch action search did not complete');
    }
    const shards = result._shards;
    if (result.timed_out !== false || !shards ||
        ![shards.total, shards.successful, shards.failed, shards.skipped].every(value => Number.isSafeInteger(value) && value! >= 0) ||
        shards.failed !== 0 || shards.successful !== shards.total || shards.skipped! > shards.successful!) {
        throw new ActionHistoryUnavailableError('Elasticsearch action search returned incomplete shard metadata');
    }
}
