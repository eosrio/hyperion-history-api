import {currentProofConsumerScope, type ProofConsumerScope} from '../protocol/proof-consumer-scope.js';
import {
    ProjectionContractError,
    PROJECTION_LIMITS,
    projectTableValue,
    projectionRowKey,
    validateProjectionActivation,
    validateProjectionApply,
    validateProjectionQuery,
    validateProjectionView,
    type ProjectionAdapter,
    type ProjectionApplyRequest,
    type ProjectionApplyResult,
    type ProjectionBinding,
    type ProjectionBlock,
    type ProjectionCheckpoint,
    type ProjectionDefinition,
    type ProjectionMutation,
    type ProjectionQuery,
    type ProjectionQueryResult,
    type ProjectionReadView,
    type ProjectionValidationResult,
} from '@eosrio/hyperion-sdk/projection';

/** Protocol normalization and ABI applicability are established by the caller before this seam. */
export interface ProjectionTableChange {
    readonly contract: string;
    readonly table: string;
    readonly scope: string;
    readonly primaryKey: string;
    readonly abiDeployment: string;
    readonly abiSha256: string;
    readonly present: boolean;
    readonly value?: unknown;
}

/** Every contiguous source block is supplied, including blocks without matching table changes. */
export interface ProjectionFrame {
    readonly chainId: string;
    readonly block: ProjectionBlock;
    readonly changes: readonly ProjectionTableChange[];
}

export interface ProjectionRuntimeOptions {
    readonly adapter: ProjectionAdapter;
    readonly definition: ProjectionDefinition;
    readonly binding: ProjectionBinding;
    readonly genesis: ProjectionCheckpoint;
    readonly maximumPendingFrames?: number;
    readonly maximumPendingBytes?: number;
}

function checked<T>(result: ProjectionValidationResult<T>): T {
    if (result.valid) return result.value;
    const capability = result.errors.some(error => error.code === 'projection.capability-unavailable');
    throw new ProjectionContractError(capability ? 'projection.capability-unavailable' : 'projection.invalid-contract',
        result.errors.map(error => `${error.path}: ${error.message}`).join('; '));
}

function bounded(value: number | undefined, fallback: number, maximum: number, name: string): number {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
        throw new ProjectionContractError('projection.invalid-contract', `${name} must be between 1 and ${maximum}`);
    }
    return selected;
}

function sameBinding(a: ProjectionBinding, b: ProjectionBinding): boolean {
    return (['chainId', 'backendId', 'projectionId', 'mappingRevision', 'abiDeployment', 'abiSha256', 'generation'] as const)
        .every(field => a[field] === b[field]);
}

function sameView(a: ProjectionReadView, b: ProjectionReadView): boolean {
    return a.checkpoint.blockNum === b.checkpoint.blockNum && a.checkpoint.blockId === b.checkpoint.blockId
        && sameBinding(a.binding, b.binding);
}

// Issued only by the actual mapping result after its failure marker completes. Neither an error
// class/code nor a caller-authored property can create a rejection for another process promise.
const mappingRejections = new WeakMap<Promise<ProjectionApplyResult>, {runtime: DeclarativeProjectionRuntime;
    error: unknown; block: ProjectionBlock; scope: ProofConsumerScope | undefined}>();
export function consumeDeclarativeMappingRejection(runtime: DeclarativeProjectionRuntime,
                                                  work: Promise<ProjectionApplyResult>, error: unknown): ProjectionBlock | undefined {
    const issued = mappingRejections.get(work);
    mappingRejections.delete(work);
    if (!issued || issued.runtime !== runtime || issued.error !== error || issued.scope?.signal.aborted) return;
    try {if (currentProofConsumerScope() !== issued.scope) return; issued.scope?.assertActive();} catch {return;}
    return issued.block;
}

/** One fixed definition/instance: ordering is local to the projection, never a global chain writer. */
export class DeclarativeProjectionRuntime {
    private tail: Promise<void> = Promise.resolve();
    private pendingFrames = 0;
    private pendingBytes = 0;

    private constructor(
        private readonly adapter: ProjectionAdapter,
        readonly definition: ProjectionDefinition,
        readonly binding: ProjectionBinding,
        private readonly maximumPendingFrames: number,
        private readonly maximumPendingBytes: number,
    ) {}

    static async create(options: ProjectionRuntimeOptions): Promise<DeclarativeProjectionRuntime> {
        currentProofConsumerScope()?.assertActive();
        const activation = checked(validateProjectionActivation(options.definition, options.binding, options.adapter.capabilities));
        const maximumPendingFrames = bounded(options.maximumPendingFrames, 32, 256, 'maximumPendingFrames');
        const maximumPendingBytes = bounded(options.maximumPendingBytes, 16 * 1024 * 1024, 64 * 1024 * 1024, 'maximumPendingBytes');
        try {
            await options.adapter.initialize(activation.definition, activation.binding, structuredClone(options.genesis));
        } catch (error) {
            // initialize checks immutable identity before reporting an existing incomplete projection.
            // Attach for exact replay; open/query still consult durable readiness before serving.
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'projection.incomplete') throw error;
        }
        currentProofConsumerScope()?.assertActive();
        return new DeclarativeProjectionRuntime(options.adapter, activation.definition, activation.binding,
            maximumPendingFrames, maximumPendingBytes);
    }

    process(frame: ProjectionFrame, admitSource?: (block: ProjectionBlock) => Promise<void>): Promise<ProjectionApplyResult> {
        // A source from another chain must not poison this projection's durable readiness.
        if (frame.chainId !== this.binding.chainId) {
            return Promise.reject(new ProjectionContractError('projection.invalid-contract', 'Projection frame belongs to another chain'));
        }
        let header: ProjectionApplyRequest;
        try {
            header = checked(validateProjectionApply(this.definition, {
                binding: this.binding,
                previous: {blockNum: frame.block.blockNum - 1, blockId: frame.block.previousBlockId},
                block: frame.block,
                mutations: [],
            }));
        } catch (error) {
            return Promise.reject(error);
        }
        let changes: readonly ProjectionTableChange[] = [];
        let frameError: ProjectionContractError | undefined;
        let bytes = 1;
        try {
            if (!Array.isArray(frame.changes)) throw new Error('Invalid source envelope');
            const selected: ProjectionTableChange[] = [];
            for (const change of frame.changes) {
                if (change.contract !== this.definition.source.contract || change.table !== this.definition.source.table) continue;
                selected.push(change);
                if (selected.length > 10000) throw new Error('Invalid projection change count');
            }
            changes = structuredClone(selected);
            // Retain original values for validation: estimating bytes must not convert NaN or bigint into valid data.
            bytes = Buffer.byteLength(JSON.stringify(changes, (_key, value) => typeof value === 'bigint' ? String(value) : value));
            if (bytes > PROJECTION_LIMITS.batchBytes) throw new Error('Source frame exceeds the supported byte budget');
        } catch {
            changes = [];
            bytes = 1;
            frameError = new ProjectionContractError('projection.invalid-contract', 'Selected projection changes must be bounded cloneable JSON');
        }
        if (this.pendingFrames >= this.maximumPendingFrames || bytes > this.maximumPendingBytes - this.pendingBytes) {
            return Promise.reject(new ProjectionContractError('projection.apply-unavailable', 'Projection pending-work budget is full; retry this frame'));
        }
        this.pendingFrames++;
        this.pendingBytes += bytes;
        let result: Promise<ProjectionApplyResult>;
        const work = this.tail.then(async () => {
            const scope = currentProofConsumerScope();
            currentProofConsumerScope()?.assertActive();
            // Production admission is durable before mapping can reject. Ordinary callers retain exact
            // adapter duplicate-replay behavior and need not reserve an already completed source again.
            await admitSource?.(header.block);
            currentProofConsumerScope()?.assertActive();
            let request: ProjectionApplyRequest;
            let mappingRejected = false;
            try {
                if (frameError) throw frameError;
                const mutations: ProjectionMutation[] = [];
                for (const change of changes) {
                    if (change.abiDeployment !== this.binding.abiDeployment || change.abiSha256 !== this.binding.abiSha256) {
                        throw new ProjectionContractError('projection.invalid-contract', 'Projection source ABI does not match its fixed deployment');
                    }
                    if (typeof change.present !== 'boolean') {
                        throw new ProjectionContractError('projection.invalid-contract', 'Projection change must declare presence');
                    }
                    const key = projectionRowKey(change.scope, change.primaryKey);
                    if (change.present) {
                        const mapped = projectTableValue(this.definition, change.value);
                        mappingRejected = !mapped.valid;
                        mutations.push({kind: 'put', key, value: checked(mapped)});
                    } else mutations.push({kind: 'delete', key});
                }
                request = checked(validateProjectionApply(this.definition, {...header, mutations}));
            } catch (error) {
                currentProofConsumerScope()?.assertActive();
                try {
                    await this.adapter.markIncomplete(this.binding, header.block,
                        error instanceof Error ? error.message : 'Projection contract processing failed');
                } catch (storageError) {
                    const unavailable = new ProjectionContractError('projection.apply-unavailable',
                        'Projection processing failed and durable failure marking must be retried');
                    Object.assign(unavailable, {cause: new AggregateError([error, storageError])});
                    throw unavailable;
                }
                if (mappingRejected) {
                    // A late cancellation must preserve the original mapping error and mint no eligibility.
                    try {if (currentProofConsumerScope() !== scope) throw error; scope?.assertActive();} catch {throw error;}
                    mappingRejections.set(result, {runtime: this, error, block: header.block, scope});
                }
                throw error;
            }
            currentProofConsumerScope()?.assertActive();
            const applied = await this.adapter.apply(request);
            currentProofConsumerScope()?.assertActive();
            return applied;
        });
        this.tail = work.then(() => undefined, () => undefined);
        result = work.finally(() => {this.pendingFrames--; this.pendingBytes -= bytes;});
        return result;
    }

    open(): Promise<ProjectionReadView> {
        return this.adapter.open(this.binding);
    }

    async query(query: ProjectionQuery, view?: ProjectionReadView): Promise<ProjectionQueryResult> {
        const logical = checked(validateProjectionQuery(this.definition, query));
        const selected = view === undefined ? await this.open() : checked(validateProjectionView(view));
        if (!sameBinding(selected.binding, this.binding)) {
            throw new ProjectionContractError('projection.stale-view', 'Projection read context belongs to another instance');
        }
        const result = await this.adapter.query(selected, logical);
        // Domain shaping or the adapter query may await: validate the actual served checkpoint again.
        const current = await this.open();
        if (!sameView(selected, result.view) || !sameView(selected, current)) {
            throw new ProjectionContractError('projection.stale-view', 'Projection read context changed before publication');
        }
        return result;
    }
}
