import {
    PROJECTION_CAPABILITIES, ProjectionContractError,
    validateProjectionRollbackActivation, validateProjectionRollbackRecovery,
    validateProjectionRollbackRequest, validateProjectionRollbackView, validateProjectionView,
    type ProjectionAdapter, type ProjectionBinding, type ProjectionBlock, type ProjectionCheckpoint,
    type ProjectionDefinition, type ProjectionQuery, type ProjectionReadView,
    type ProjectionRollbackAdapter, type ProjectionRollbackApplyResult,
    type ProjectionRollbackQueryResult, type ProjectionRollbackReadView,
    type ProjectionRollbackRecoveryView, type ProjectionRollbackRequest,
    type ProjectionRollbackResult, type ProjectionRollbackState, type ProjectionValidationResult,
} from '@eosrio/hyperion-sdk/projection';
import {DeclarativeProjectionRuntime, type ProjectionFrame} from './runtime.js';
import {currentProofConsumerScope} from '../protocol/proof-consumer-scope.js';

export interface RecoverableProjectionRuntimeOptions {
    readonly adapter: ProjectionRollbackAdapter;
    readonly definition: ProjectionDefinition;
    readonly binding: ProjectionBinding;
    readonly genesis: ProjectionCheckpoint;
    readonly maximumPendingFrames?: number;
    readonly maximumPendingBytes?: number;
}
const zero = '0'.repeat(64);

function checked<T>(result: ProjectionValidationResult<T>): T {
    if (result.valid) return result.value;
    const capability = result.errors.some(error => error.code === 'projection.capability-unavailable');
    throw new ProjectionContractError(capability ? 'projection.capability-unavailable' : 'projection.invalid-contract',
        result.errors.map(error => `${error.path}: ${error.message}`).join('; '));
}
function sameBinding(a: ProjectionBinding, b: ProjectionBinding): boolean {
    return (['chainId', 'backendId', 'projectionId', 'mappingRevision', 'abiDeployment', 'abiSha256', 'generation'] as const)
        .every(field => a[field] === b[field]);
}
function sameOperation(state: ProjectionRollbackState, request: ProjectionRollbackRequest): boolean {
    return state.operationId === request.operationId && state.sourceRevision === request.revision
        && state.from.blockNum === request.from.blockNum && state.from.blockId === request.from.blockId
        && state.ancestor.blockNum === request.ancestor.blockNum && state.ancestor.blockId === request.ancestor.blockId;
}
function bounded(value: number | undefined, maximum: number): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum))
        throw new ProjectionContractError('projection.invalid-contract', 'Projection pending-work budget is invalid');
}

/** A revision is fixed for this entire lane, including work queued before a fork is detected. */
class RevisionLane {
    private active = true;
    constructor(readonly revision: string, private readonly adapter: ProjectionRollbackAdapter,
        private readonly binding: ProjectionBinding) {}
    invalidate(): void {this.active = false;}
    assertActive(): void {
        currentProofConsumerScope()?.assertActive();
        if (!this.active)
            throw new ProjectionContractError('projection.stale-revision', 'Projection work belongs to an invalidated revision');
    }
    view(value: ProjectionRollbackReadView): ProjectionRollbackReadView {
        this.assertActive();
        const selected = checked(validateProjectionRollbackView(value));
        if (selected.revision !== this.revision || !sameBinding(selected.binding, this.binding))
            throw new ProjectionContractError('projection.stale-revision', 'Projection revision changed during this operation');
        return selected;
    }
    private plain(value: ProjectionRollbackReadView): ProjectionReadView {
        const selected = this.view(value);
        return {binding: selected.binding, checkpoint: selected.checkpoint};
    }
    fenced(value: ProjectionReadView): ProjectionRollbackReadView {
        return this.view({...value, revision: this.revision});
    }
    /** Reuse the existing bounded mapper/FIFO; only the adapter calls gain a fixed revision. */
    bridge(): ProjectionAdapter {
        return {
            capabilities: {interfaceVersion: 1, supported: PROJECTION_CAPABILITIES},
            initialize: async (definition, binding, genesis) => {
                this.assertActive();
                return this.plain(await this.adapter.initialize(definition, binding, genesis));
            },
            open: async binding => {
                this.assertActive();
                return this.plain(await this.adapter.open(binding));
            },
            apply: async batch => {
                this.assertActive();
                const result = await this.adapter.apply({revision: this.revision, batch});
                return {status: result.status, view: this.plain(result.view)};
            },
            markIncomplete: async (binding, block, reason) => {
                this.assertActive();
                await this.adapter.markIncomplete({binding, revision: this.revision, block, reason});
                this.assertActive();
            },
            query: async (view, query) => {
                this.assertActive();
                const result = await this.adapter.query(this.fenced(view), query);
                return {...result, view: this.plain(result.view)};
            },
        };
    }
}

/**
 * Runtime-owned recovery of one projection. The caller establishes canonical ancestry before
 * supplying an ancestor; this seam does not infer chain authority from a matching block number.
 * Production canonical selection remains the source/controller's responsibility.
 */
export class RecoverableProjectionRuntime {
    private lane!: {revision: RevisionLane; runtime: DeclarativeProjectionRuntime};
    private readonly pending = new Set<Promise<unknown>>();
    private rollbackWork?: Promise<ProjectionRollbackResult>;
    private resumeWork?: Promise<ProjectionRollbackRecoveryView>;
    private interruptedRollback?: {request: ProjectionRollbackRequest; previousRevision: string};
    private recovering = false;
    private constructor(private readonly options: RecoverableProjectionRuntimeOptions,
        readonly definition: ProjectionDefinition, readonly binding: ProjectionBinding,
        private readonly genesis: ProjectionCheckpoint) {}

    static async create(options: RecoverableProjectionRuntimeOptions): Promise<RecoverableProjectionRuntime> {
        currentProofConsumerScope()?.assertActive();
        const activation = checked(validateProjectionRollbackActivation(options.definition, options.binding, options.adapter.capabilities));
        const genesis = checked(validateProjectionView({binding: activation.binding, checkpoint: options.genesis})).checkpoint;
        if (genesis.blockNum !== 0 || genesis.blockId !== zero)
            throw new ProjectionContractError('projection.invalid-contract', 'Projection recovery requires explicit genesis initialization');
        bounded(options.maximumPendingFrames, 256);
        bounded(options.maximumPendingBytes, 64 * 1024 * 1024);
        const selected = new RecoverableProjectionRuntime({...options}, activation.definition, activation.binding, genesis);
        try {checked(validateProjectionRollbackView(await options.adapter.initialize(activation.definition, activation.binding, genesis)));}
        catch (error) {
            currentProofConsumerScope()?.assertActive();
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'projection.incomplete') throw error;
        }
        currentProofConsumerScope()?.assertActive();
        const recovery = await selected.recovery();
        await selected.attach(recovery.revision);
        selected.recovering = recovery.rollback !== null && recovery.rollback.status !== 'complete';
        return selected;
    }

    private async attach(revision: string): Promise<void> {
        const lane = new RevisionLane(revision, this.options.adapter, this.binding);
        const runtime = await DeclarativeProjectionRuntime.create({adapter: lane.bridge(), definition: this.definition,
            binding: this.binding, genesis: this.genesis, maximumPendingFrames: this.options.maximumPendingFrames,
            maximumPendingBytes: this.options.maximumPendingBytes});
        this.lane = {revision: lane, runtime};
    }
    private available(): void {
        currentProofConsumerScope()?.assertActive();
        if (this.recovering)
            throw new ProjectionContractError('projection.incomplete', 'Projection canonical recovery is pending');
    }
    process(frame: ProjectionFrame, admitSource?: (block: ProjectionBlock) => Promise<void>): Promise<ProjectionRollbackApplyResult> {
        try {this.available();} catch (error) {return Promise.reject(error);}
        const lane = this.lane;
        // The callback runs before mapping inside the old queue. It never adopts a newer revision.
        const work = lane.runtime.process(frame, async block => {
            lane.revision.assertActive();
            await admitSource?.(block);
            lane.revision.assertActive();
        })
            .then(result => ({status: result.status, view: lane.revision.fenced(result.view)}));
        this.pending.add(work);
        work.then(() => this.pending.delete(work), () => this.pending.delete(work));
        return work;
    }
    async open(): Promise<ProjectionRollbackReadView> {
        this.available();
        const lane = this.lane;
        return lane.revision.fenced(await lane.runtime.open());
    }
    async query(query: ProjectionQuery, view?: ProjectionRollbackReadView): Promise<ProjectionRollbackQueryResult> {
        this.available();
        const lane = this.lane;
        const selected = view === undefined ? undefined : lane.revision.view(view);
        const plain = selected ? {binding: selected.binding, checkpoint: selected.checkpoint} : undefined;
        const result = await lane.runtime.query(query, plain);
        return {...result, view: lane.revision.fenced(result.view)};
    }
    async recovery(): Promise<ProjectionRollbackRecoveryView> {
        currentProofConsumerScope()?.assertActive();
        const result = checked(validateProjectionRollbackRecovery(await this.options.adapter.recovery(this.binding)));
        currentProofConsumerScope()?.assertActive();
        if (!sameBinding(result.binding, this.binding) || result.initialized !== true)
            throw new ProjectionContractError('projection.incomplete', 'Projection recovery belongs to another initialized instance');
        return result;
    }

    /** A rotated revision requires the exact interrupted operation receipt; refused work keeps its known lane. */
    resumeRecovery(): Promise<ProjectionRollbackRecoveryView> {
        if (this.resumeWork) return this.resumeWork;
        const work = (async () => {
            const recovery = await this.recovery(), attempt = this.interruptedRollback;
            if (!this.recovering || !attempt || this.rollbackWork) return recovery;
            const matching = recovery.rollback !== null && sameOperation(recovery.rollback, attempt.request);
            const completed = matching && recovery.rollback!.status === 'complete';
            // No admitted recovery rotated this known lane. Discard the refused request so the
            // controller obtains a fresh canonical plan, including after an in-flight commit.
            const unchanged = recovery.revision === attempt.previousRevision
                && (recovery.rollback === null || recovery.rollback.status === 'complete');
            if (!matching && !unchanged)
                throw new ProjectionContractError('projection.stale-revision', 'Another recovery operation owns this projection revision');
            if (completed || unchanged) {
                await this.attach(completed ? recovery.revision : attempt.previousRevision);
                this.recovering = false;
                this.interruptedRollback = undefined;
            }
            return recovery;
        })();
        this.resumeWork = work.finally(() => {this.resumeWork = undefined;});
        return this.resumeWork;
    }

    /** Preserve this complete original request on retry, including after a runtime restart. */
    rollback(input: ProjectionRollbackRequest): Promise<ProjectionRollbackResult> {
        let captured: ProjectionRollbackRequest;
        try {
            currentProofConsumerScope()?.assertActive();
            captured = checked(validateProjectionRollbackRequest(input));
            if (!sameBinding(captured.binding, this.binding))
                throw new ProjectionContractError('projection.invalid-contract', 'Rollback request belongs to another projection instance');
        } catch (error) {return Promise.reject(error);}
        if (this.rollbackWork || this.resumeWork)
            return Promise.reject(new ProjectionContractError('projection.apply-unavailable', 'A projection recovery call is already running'));
        const previousRevision = this.lane.revision.revision;
        this.interruptedRollback = {request: captured, previousRevision};
        this.recovering = true;
        this.lane.revision.invalidate();
        const inflight = [...this.pending];
        const work = (async () => {
            // In-flight durable work may finish; queued old frames fail before mapping. A stale
            // planned source must be refused, never rewritten with a newer revision/checkpoint.
            await Promise.allSettled(inflight);
            currentProofConsumerScope()?.assertActive();
            let result: ProjectionRollbackResult;
            try {result = await this.options.adapter.rollback(captured); currentProofConsumerScope()?.assertActive();}
            catch (error) {
                currentProofConsumerScope()?.assertActive();
                // A refused old request must not disable a still-current lane. Reattach only the
                // same durable revision; pending/rotated recovery still stays fenced. Initialization
                // and later open/query enforce readiness independently from recovery inspection.
                try {
                    const unchanged = await this.recovery();
                    if (unchanged.revision === previousRevision
                        && (unchanged.rollback === null || unchanged.rollback.status === 'complete')) {
                        await this.attach(previousRevision);
                        this.recovering = false;
                        this.interruptedRollback = undefined;
                    }
                } catch {}
                throw error;
            }
            const recovery = checked(validateProjectionRollbackRecovery(result.recovery));
            if (!sameBinding(recovery.binding, this.binding) || !recovery.rollback || !sameOperation(recovery.rollback, captured)
                || (result.status === 'in-progress' ? recovery.rollback.status !== 'running'
                    : !['rolled-back', 'duplicate'].includes(result.status) || recovery.rollback.status !== 'complete'))
                throw new ProjectionContractError('projection.incomplete', 'Adapter did not return the requested durable rollback operation');
            if (result.status !== 'in-progress') {
                await this.attach(recovery.revision);
                this.recovering = false;
                this.interruptedRollback = undefined;
            }
            return {...result, recovery};
        })();
        this.rollbackWork = work.finally(() => {this.rollbackWork = undefined;});
        return this.rollbackWork;
    }
}
