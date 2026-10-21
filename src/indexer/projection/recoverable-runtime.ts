import {
    PROJECTION_CAPABILITIES, ProjectionContractError,
    validateProjectionRollbackActivation, validateProjectionRollbackRecovery,
    validateProjectionRollbackRequest, validateProjectionRollbackView, validateProjectionView,
    type ProjectionAdapter, type ProjectionBinding, type ProjectionCheckpoint,
    type ProjectionDefinition, type ProjectionQuery, type ProjectionReadView,
    type ProjectionRollbackAdapter, type ProjectionRollbackApplyResult,
    type ProjectionRollbackQueryResult, type ProjectionRollbackReadView,
    type ProjectionRollbackRecoveryView, type ProjectionRollbackRequest,
    type ProjectionRollbackResult, type ProjectionValidationResult,
} from '@eosrio/hyperion-sdk/projection';
import {DeclarativeProjectionRuntime, type ProjectionFrame} from './runtime.js';

export interface RecoverableProjectionRuntimeOptions {
    readonly adapter: ProjectionRollbackAdapter;
    readonly definition: ProjectionDefinition;
    readonly binding: ProjectionBinding;
    readonly genesis: ProjectionCheckpoint;
    readonly maximumPendingFrames?: number;
    readonly maximumPendingBytes?: number;
}
export interface ProjectionRuntimeRollback {
    readonly operationId: string;
    readonly ancestor: ProjectionCheckpoint;
    readonly maxBlocks: number;
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
 * The existing production SHiP/controller path remains on v1 until its own recovery integration.
 */
export class RecoverableProjectionRuntime {
    private lane!: {revision: RevisionLane; runtime: DeclarativeProjectionRuntime};
    private readonly pending = new Set<Promise<unknown>>();
    private rollbackWork?: Promise<ProjectionRollbackResult>;
    private recovering = false;
    private constructor(private readonly options: RecoverableProjectionRuntimeOptions,
        readonly definition: ProjectionDefinition, readonly binding: ProjectionBinding,
        private readonly genesis: ProjectionCheckpoint) {}

    static async create(options: RecoverableProjectionRuntimeOptions): Promise<RecoverableProjectionRuntime> {
        const activation = checked(validateProjectionRollbackActivation(options.definition, options.binding, options.adapter.capabilities));
        const genesis = checked(validateProjectionView({binding: activation.binding, checkpoint: options.genesis})).checkpoint;
        if (genesis.blockNum !== 0 || genesis.blockId !== zero)
            throw new ProjectionContractError('projection.invalid-contract', 'Projection recovery requires explicit genesis initialization');
        bounded(options.maximumPendingFrames, 256);
        bounded(options.maximumPendingBytes, 64 * 1024 * 1024);
        const selected = new RecoverableProjectionRuntime({...options}, activation.definition, activation.binding, genesis);
        try {checked(validateProjectionRollbackView(await options.adapter.initialize(activation.definition, activation.binding, genesis)));}
        catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'projection.incomplete') throw error;
        }
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
        if (this.recovering)
            throw new ProjectionContractError('projection.incomplete', 'Projection canonical recovery is pending');
    }
    process(frame: ProjectionFrame): Promise<ProjectionRollbackApplyResult> {
        try {this.available();} catch (error) {return Promise.reject(error);}
        const lane = this.lane;
        // The callback runs before mapping inside the old queue. It never adopts a newer revision.
        const work = lane.runtime.process(frame, async () => lane.revision.assertActive())
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
        const result = checked(validateProjectionRollbackRecovery(await this.options.adapter.recovery(this.binding)));
        if (!sameBinding(result.binding, this.binding) || result.initialized !== true)
            throw new ProjectionContractError('projection.incomplete', 'Projection recovery belongs to another initialized instance');
        return result;
    }

    private rollbackInput(input: ProjectionRuntimeRollback): ProjectionRollbackRequest {
        if (typeof input !== 'object' || input === null || Array.isArray(input)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length)
            throw new ProjectionContractError('projection.invalid-contract', 'Expected plain rollback options');
        const properties = Object.getOwnPropertyDescriptors(input);
        const names = ['operationId', 'ancestor', 'maxBlocks'];
        if (Object.keys(properties).length !== names.length || names.some(name => !properties[name]?.enumerable
            || !Object.hasOwn(properties[name], 'value')))
            throw new ProjectionContractError('projection.invalid-contract', 'Expected bounded rollback options with data properties');
        // Use the SDK's inert snapshot before the first await, including for the nested ancestor.
        return checked(validateProjectionRollbackRequest({binding: this.binding, revision: zero,
            operationId: properties.operationId.value, from: properties.ancestor.value,
            ancestor: properties.ancestor.value, maxBlocks: properties.maxBlocks.value}));
    }
    rollback(input: ProjectionRuntimeRollback): Promise<ProjectionRollbackResult> {
        let captured: ProjectionRollbackRequest;
        try {captured = this.rollbackInput(input);} catch (error) {return Promise.reject(error);}
        if (this.rollbackWork)
            return Promise.reject(new ProjectionContractError('projection.apply-unavailable', 'A projection recovery call is already running'));
        const sourceRevision = this.lane.revision.revision;
        this.recovering = true;
        this.lane.revision.invalidate();
        const inflight = [...this.pending];
        const work = (async () => {
            // In-flight durable work may finish; queued old frames fail before mapping. Inspect only
            // after these settle so the expected source checkpoint includes every completed effect.
            await Promise.allSettled(inflight);
            const before = await this.recovery();
            const previous = before.rollback?.operationId === captured.operationId ? before.rollback : undefined;
            const request = checked(validateProjectionRollbackRequest({...captured,
                revision: previous?.sourceRevision ?? sourceRevision, from: previous?.from ?? before.checkpoint}));
            const result = await this.options.adapter.rollback(request);
            const recovery = checked(validateProjectionRollbackRecovery(result.recovery));
            if (!sameBinding(recovery.binding, this.binding) || recovery.rollback?.operationId !== captured.operationId
                || (result.status === 'in-progress' ? recovery.rollback.status !== 'running'
                    : !['rolled-back', 'duplicate'].includes(result.status) || recovery.rollback.status !== 'complete'))
                throw new ProjectionContractError('projection.incomplete', 'Adapter did not return the requested durable rollback operation');
            if (result.status !== 'in-progress') {
                await this.attach(recovery.revision);
                this.recovering = false;
            }
            return {...result, recovery};
        })();
        this.rollbackWork = work.finally(() => {this.rollbackWork = undefined;});
        return this.rollbackWork;
    }
}
