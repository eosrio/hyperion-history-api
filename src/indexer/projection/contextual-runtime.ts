import {
    CONTEXTUAL_PROJECTION_RECOVERY_HOST_CAPABILITIES, PROJECTION_LIMITS, ProjectionContractError,
    projectContextualTableChange, projectionRowKey, validateContextualProjectionContext,
    validateContextualProjectionRecoveryActivation, validateContextualProjectionRecoveryApplyInput,
    validateContextualProjectionQuery, validateProjectionRollbackIncomplete,
    validateProjectionRollbackRecovery, validateProjectionRollbackRequest, validateProjectionRollbackView,
    validateProjectionView, type ContextualProjectionApplyRequest, type ContextualProjectionDefinition,
    type ContextualProjectionRecoveryAdapter, type ContextualProjectionMutation, type ProjectionBinding,
    type ProjectionBlock, type ProjectionCheckpoint, type ProjectionQuery, type ProjectionRollbackApplyResult,
    type ProjectionRollbackReadView, type ProjectionRollbackQueryResult, type ProjectionRollbackRecoveryView,
    type ProjectionRollbackRequest, type ProjectionRollbackResult,
} from '@eosrio/hyperion-sdk/projection';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';
import {currentProofConsumerScope} from '../protocol/proof-consumer-scope.js';
import {contextualChecked as checked, type ContextualProjectionFrame} from './contextual-contract.js';
import {PortableProjectionFrameError, type PortableProjectionSource} from './source.js';

export interface ContextualProjectionRuntimeOptions {
    readonly adapter: ContextualProjectionRecoveryAdapter;
    readonly definition: ContextualProjectionDefinition;
    readonly binding: ProjectionBinding;
    readonly genesis: ProjectionCheckpoint;
    readonly maximumPendingFrames?: number;
    readonly maximumPendingBytes?: number;
}
interface Lane {readonly revision: string; active: boolean;}
const sameBinding = (a: ProjectionBinding, b: ProjectionBinding) => protocolImmutableJson(a) === protocolImmutableJson(b);
const sameView = (a: ProjectionRollbackReadView, b: ProjectionRollbackReadView) => a.revision === b.revision
    && sameBinding(a.binding, b.binding) && a.checkpoint.blockNum === b.checkpoint.blockNum && a.checkpoint.blockId === b.checkpoint.blockId;
function bounded(value: number | undefined, fallback: number, maximum: number): number {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum)
        throw new ProjectionContractError('projection.invalid-contract', 'Projection pending-work budget is invalid');
    return selected;
}

/** Separate opt-in standalone runtime. Production worker recovery/serving remain #246/#221. */
export class ContextualProjectionRuntime {
    private lane!: Lane;
    private tail: Promise<void> = Promise.resolve();
    private readonly pending = new Set<Promise<unknown>>();
    private pendingBytes = 0;
    private recovering = false;
    private source?: PortableProjectionSource;
    private rollbackWork?: Promise<ProjectionRollbackResult>;
    private constructor(private readonly adapter: ContextualProjectionRecoveryAdapter,
        readonly definition: ContextualProjectionDefinition, readonly binding: ProjectionBinding,
        private readonly maximumPendingFrames: number, private readonly maximumPendingBytes: number) {}

    static async create(options: ContextualProjectionRuntimeOptions): Promise<ContextualProjectionRuntime> {
        const scope = currentProofConsumerScope(); scope?.assertActive();
        const activation = checked(validateContextualProjectionRecoveryActivation(options.definition, options.binding,
            {family: 'contextual-table-recovery', interfaceVersion: 1, supported: CONTEXTUAL_PROJECTION_RECOVERY_HOST_CAPABILITIES},
            options.adapter.capabilities));
        const genesis = checked(validateProjectionView({binding: activation.binding, checkpoint: options.genesis})).checkpoint;
        if (genesis.blockNum !== 0 || genesis.blockId !== '0'.repeat(64))
            throw new ProjectionContractError('projection.invalid-contract', 'Contextual projection requires explicit genesis');
        const runtime = new ContextualProjectionRuntime(options.adapter, activation.definition, activation.binding,
            bounded(options.maximumPendingFrames, 32, 256), bounded(options.maximumPendingBytes, 16 * 1024 * 1024, 64 * 1024 * 1024));
        try {await options.adapter.initialize(activation.definition, activation.binding, genesis);}
        catch (error) {
            if (scope?.signal.aborted || !(error instanceof Error) || !('code' in error) || error.code !== 'projection.incomplete') throw error;
        }
        scope?.assertActive();
        const state = await runtime.recovery(); scope?.assertActive();
        runtime.lane = {revision: state.revision, active: true};
        runtime.recovering = state.rollback !== null && state.rollback.status !== 'complete';
        return runtime;
    }
    private assertLane(lane: Lane): void {
        if (!lane.active || this.lane !== lane || this.recovering)
            throw new ProjectionContractError('projection.stale-revision', 'Projection work belongs to a retired or recovering revision');
    }
    private enqueue(bytes: number, operation: (lane: Lane, assertActive: () => void) => Promise<ProjectionRollbackApplyResult>): Promise<ProjectionRollbackApplyResult> {
        if (this.recovering) return Promise.reject(new ProjectionContractError('projection.incomplete', 'Projection recovery is pending'));
        if (this.pending.size >= this.maximumPendingFrames || bytes > this.maximumPendingBytes - this.pendingBytes)
            return Promise.reject(new ProjectionContractError('projection.apply-unavailable', 'Projection pending-work budget is full; retry this frame'));
        const lane = this.lane, scope = currentProofConsumerScope();
        const assertActive = () => {scope?.assertActive(); this.assertLane(lane);};
        this.pendingBytes += bytes;
        const work = this.tail.then(async () => {assertActive(); return operation(lane, assertActive);});
        this.pending.add(work);
        this.tail = work.then(() => undefined, () => undefined);
        const release = () => {this.pending.delete(work); this.pendingBytes -= bytes;};
        work.then(release, release);
        return work;
    }
    private header(block: unknown, revision: string): ProjectionBlock {
        return checked(validateProjectionRollbackIncomplete({binding: this.binding, revision, block,
            reason: 'Original contextual source admitted'})).block;
    }
    private async failure(block: ProjectionBlock, lane: Lane, error: unknown, assertActive: () => void): Promise<never> {
        // Failure handling cannot replace an ordinary/foreign causal error with a later owned
        // cancellation. Preserve the original error if this lane/scope retires during fallback I/O.
        try {assertActive();} catch {throw error;}
        try {
            await this.adapter.markIncomplete({binding: this.binding, revision: lane.revision, block,
                reason: error instanceof Error ? Buffer.from(error.message.slice(0, 1024)).toString('utf8')
                    || 'Contextual projection mapping failed' : 'Contextual projection mapping failed'});
        } catch (storageError) {
            try {assertActive();} catch {throw error;}
            const unavailable = new ProjectionContractError('projection.apply-unavailable', 'Contextual failure marking must be retried');
            unavailable.cause = new AggregateError([error, storageError]); throw unavailable;
        }
        throw error;
    }
    private async applyFrame(frame: ContextualProjectionFrame, lane: Lane, assertActive: () => void,
        verifySource?: () => Promise<void>): Promise<ProjectionRollbackApplyResult> {
        if (frame.chainId !== this.binding.chainId)
            throw new ProjectionContractError('projection.invalid-contract', 'Contextual frame belongs to another chain');
        const block = this.header(frame.block, lane.revision);
        let request: ContextualProjectionApplyRequest;
        try {
            const context = checked(validateContextualProjectionContext(this.definition,
                {binding: this.binding, block, source: frame.context}));
            const mutations: ContextualProjectionMutation[] = [];
            if (!Array.isArray(frame.changes) || frame.changes.length > PROJECTION_LIMITS.mutations)
                throw new ProjectionContractError('projection.invalid-contract', 'Contextual changes must be a bounded complete vector');
            for (const change of frame.changes) {
                if (!change || typeof change !== 'object' || typeof change.contract !== 'string' || typeof change.table !== 'string')
                    throw new ProjectionContractError('projection.invalid-contract', 'Contextual change framing is invalid');
                if (change.contract !== this.definition.source.contract || change.table !== this.definition.source.table) continue;
                if (typeof change.present !== 'boolean')
                    throw new ProjectionContractError('projection.invalid-contract', 'Contextual change must declare exact boolean presence');
                if (change.abiDeployment !== this.binding.abiDeployment || change.abiSha256 !== this.binding.abiSha256)
                    throw new ProjectionContractError('projection.invalid-contract', 'Original source ABI differs from the fixed contextual mapping');
                const key = projectionRowKey(change.scope, change.primaryKey);
                mutations.push(checked(projectContextualTableChange(this.definition, context, change.present
                    ? {key, present: true, value: change.value} : {key, present: change.present})));
            }
            request = checked(validateContextualProjectionRecoveryApplyInput({revision: lane.revision,
                batch: {...context, previous: {blockNum: block.blockNum - 1, blockId: block.previousBlockId},
                    policy: {preserveOnReplace: this.definition.preserveOnReplace, onAbsent: this.definition.onAbsent}, mutations}})).batch;
        } catch (error) {return this.failure(block, lane, error, assertActive);}
        await verifySource?.(); assertActive();
        const result = await this.adapter.apply({revision: lane.revision, batch: request}); assertActive();
        await verifySource?.(); assertActive();
        const view = checked(validateProjectionRollbackView(result.view));
        if (view.revision !== lane.revision || !sameBinding(view.binding, this.binding))
            throw new ProjectionContractError('projection.stale-revision', 'Adapter returned a different contextual revision');
        return {...result, view};
    }
    /** Component frame seam; the caller owns source authority. Use processSource for retained source. */
    process(input: ContextualProjectionFrame): Promise<ProjectionRollbackApplyResult> {
        let block: ProjectionBlock, captured: ContextualProjectionFrame | undefined, error: unknown, bytes = 1;
        try {
            const descriptors = Object.getOwnPropertyDescriptors(input);
            const chain = descriptors.chainId?.value;
            if (chain !== this.binding.chainId)
                throw new ProjectionContractError('projection.invalid-contract', 'Contextual frame belongs to another chain');
            block = this.header(descriptors.block?.value, this.lane.revision);
            try {
                const json = protocolImmutableJson(input, PROJECTION_LIMITS.batchBytes);
                bytes = Buffer.byteLength(json); captured = JSON.parse(json);
            } catch (failure) {error = failure;}
        } catch (failure) {return Promise.reject(failure);}
        return this.enqueue(bytes, async (lane, assertActive) => captured
            ? this.applyFrame(captured, lane, assertActive) : this.failure(block, lane, error, assertActive));
    }
    /** Actual journal/proof source, original header time and post-await ABI/owner revalidation.
     * A not-yet-loaded source reserves this projection's existing byte budget conservatively;
     * no frame prefetch or additional queue/default is introduced.
     */
    processSource(source: PortableProjectionSource, blockNum: number): Promise<ProjectionRollbackApplyResult> {
        if (source.chainId !== this.binding.chainId)
            return Promise.reject(new ProjectionContractError('projection.invalid-contract', 'Original source belongs to another chain'));
        return this.enqueue(this.maximumPendingBytes, async (lane, assertActive) => {
            this.source = source;
            const before = await this.recovery(); assertActive();
            if (before.revision !== lane.revision) throw new ProjectionContractError('projection.stale-revision', 'Source lane revision changed');
            try {
                const retained = await source.contextualFrame(blockNum, this.definition, async block => {
                    assertActive(); const target = this.header(block, lane.revision);
                    if (block.blockNum > before.checkpoint.blockNum) {
                        await this.adapter.markIncomplete({binding: this.binding, revision: lane.revision, block: target,
                            reason: 'Original canonical source admitted before contextual mapping'}); assertActive();
                    }
                });
                assertActive();
                const serialized = protocolImmutableJson(retained.frame, PROJECTION_LIMITS.batchBytes);
                if (Buffer.byteLength(serialized) > this.maximumPendingBytes)
                    throw new ProjectionContractError('projection.apply-unavailable', 'Original contextual frame exceeds the pending-work byte budget');
                const frame: ContextualProjectionFrame = JSON.parse(serialized);
                return await this.applyFrame(frame, lane, assertActive,
                    () => source.revalidateContextualFrame(retained.proof, this.definition));
            } catch (error) {
                try {assertActive();} catch {throw error;}
                if (error instanceof PortableProjectionFrameError) return this.failure(error.block, lane, error, assertActive);
                throw error;
            }
        });
    }
    async recovery(): Promise<ProjectionRollbackRecoveryView> {
        const scope = currentProofConsumerScope(); scope?.assertActive();
        const state = checked(validateProjectionRollbackRecovery(await this.adapter.recovery(this.binding)));
        scope?.assertActive();
        if (!sameBinding(state.binding, this.binding) || !state.initialized)
            throw new ProjectionContractError('projection.incomplete', 'Contextual recovery is not this initialized instance');
        return state;
    }
    async open(): Promise<ProjectionRollbackReadView> {
        const scope = currentProofConsumerScope(); scope?.assertActive();
        const source = this.source;
        const lane = this.lane; this.assertLane(lane);
        const view = checked(validateProjectionRollbackView(await this.adapter.open(this.binding))); scope?.assertActive(); this.assertLane(lane);
        if (view.revision !== lane.revision || !sameBinding(view.binding, this.binding))
            throw new ProjectionContractError('projection.stale-revision', 'Contextual view belongs to another revision');
        if (this.source) {
            await this.verifySourceView(view); scope?.assertActive(); this.assertLane(lane);
            const settled = checked(validateProjectionRollbackView(await this.adapter.open(this.binding)));
            scope?.assertActive(); this.assertLane(lane);
            if (!sameView(view, settled)) throw new ProjectionContractError('projection.stale-view', 'Projection advanced during original-source validation');
            if (this.source !== source) throw new ProjectionContractError('projection.stale-view', 'Original source changed during contextual open');
        }
        return view;
    }
    private async verifySourceView(view: ProjectionRollbackReadView): Promise<void> {
        if (!this.source) return;
        const source = this.source;
        const proof = await source.open(view.checkpoint);
        await source.assertContextualDefinition(proof, this.definition);
        if (this.source !== source) throw new ProjectionContractError('projection.stale-view', 'Selected original source changed during the read');
    }
    async query(input: ProjectionQuery, view?: ProjectionRollbackReadView): Promise<ProjectionRollbackQueryResult> {
        const scope = currentProofConsumerScope(); scope?.assertActive();
        const source = this.source;
        const lane = this.lane; this.assertLane(lane);
        const query = checked(validateContextualProjectionQuery(this.definition, input));
        const selected = view === undefined ? await this.open() : checked(validateProjectionRollbackView(view)); scope?.assertActive(); this.assertLane(lane);
        if (selected.revision !== lane.revision || !sameBinding(selected.binding, this.binding))
            throw new ProjectionContractError('projection.stale-revision', 'Query belongs to another contextual revision');
        await this.verifySourceView(selected); scope?.assertActive(); this.assertLane(lane);
        const result = await this.adapter.query(selected, query); scope?.assertActive(); this.assertLane(lane);
        const current = await this.open(); scope?.assertActive(); this.assertLane(lane);
        if (!sameView(selected, result.view) || !sameView(selected, current))
            throw new ProjectionContractError('projection.stale-view', 'Contextual query changed before publication');
        if (this.source !== source) throw new ProjectionContractError('projection.stale-view', 'Original source changed before publication');
        return result;
    }
    /** The caller establishes canonical ancestry; exact intent is retained across restart/retry. */
    rollback(input: ProjectionRollbackRequest): Promise<ProjectionRollbackResult> {
        let request: ProjectionRollbackRequest;
        try {
            request = checked(validateProjectionRollbackRequest(input));
            if (!sameBinding(request.binding, this.binding)) throw new ProjectionContractError('projection.invalid-contract', 'Recovery names another projection');
        } catch (error) {return Promise.reject(error);}
        if (this.rollbackWork) return Promise.reject(new ProjectionContractError('projection.apply-unavailable', 'A contextual recovery call is running'));
        const previous = this.lane; previous.active = false; this.recovering = true;
        const work = (async () => {
            await Promise.allSettled([...this.pending]);
            let result: ProjectionRollbackResult;
            try {result = await this.adapter.rollback(request);}
            catch (error) {
                try {
                    const state = await this.recovery();
                    if (state.revision === previous.revision && (state.rollback === null || state.rollback.status === 'complete')) {
                        this.lane = {revision: state.revision, active: true}; this.recovering = false;
                    }
                } catch {}
                throw error;
            }
            const state = checked(validateProjectionRollbackRecovery(result.recovery));
            const operation = state.rollback;
            if (!sameBinding(state.binding, this.binding) || operation?.operationId !== request.operationId
                || operation.sourceRevision !== request.revision || operation.from.blockNum !== request.from.blockNum
                || operation.from.blockId !== request.from.blockId || operation.ancestor.blockNum !== request.ancestor.blockNum
                || operation.ancestor.blockId !== request.ancestor.blockId
                || (result.status === 'in-progress' ? operation.status !== 'running'
                    : !['rolled-back', 'duplicate'].includes(result.status) || operation.status !== 'complete'))
                throw new ProjectionContractError('projection.incomplete', 'Adapter did not return the exact contextual recovery intent');
            if (result.status !== 'in-progress') {this.lane = {revision: state.revision, active: true}; this.recovering = false;}
            return {...result, recovery: state};
        })();
        this.rollbackWork = work.finally(() => {this.rollbackWork = undefined;});
        return this.rollbackWork;
    }
}
