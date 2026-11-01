import {ProjectionContractError, type ProjectionAdapter, type ProjectionBinding, type ProjectionBlock, type ProjectionCheckpoint,
    type ProjectionApplyResult, type ProjectionRecoveryView} from '@eosrio/hyperion-sdk/projection';
import {DeclarativeProjectionRuntime, consumeDeclarativeMappingRejection} from './runtime.js';
import {portableStateBinding, type ResolvedPortableStateConfiguration} from './config.js';
import {PortableProjectionFrameError, type PortableProjectionSource, type PortableProjectionSourceEvidence} from './source.js';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';
import {createHash} from 'node:crypto';
import {currentProofConsumerScope} from '../protocol/proof-consumer-scope.js';
import type {WorkerAttemptBinding} from '../protocol/worker-attempt-supervisor.js';

export interface PortableStateProgress {
    readonly projectionId: string; readonly binding: ProjectionBinding;
    readonly status: 'applied' | 'duplicate' | 'incomplete' | 'waiting';
    readonly checkpoint?: ProjectionCheckpoint;
    readonly recovery?: ProjectionRecoveryView;
    readonly evidence?: PortableProjectionSourceEvidence;
    readonly reason?: string;
}
interface ControllerOptions {
    chainId: string; configuration: ResolvedPortableStateConfiguration; adapter: ProjectionAdapter;
    source: Pick<PortableProjectionSource, 'frame' | 'revalidate'>;
    onProgress?: (value: PortableStateProgress) => void;
    maximumFramesPerProjection?: number;
    /** Source-only engineering option; zero retains the legacy immediate retry policy. */
    mappingRetryEligibilityMs?: number;
    /** Private actual-worker transport. Component controllers issue no master lifecycle authority. */
    attempts?: {run(metadata: unknown, operation: () => Promise<boolean>): Promise<boolean>; bind(fields: WorkerAttemptBinding): Promise<void>};
}
const zero = '0'.repeat(64);
const json = protocolImmutableJson;
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).toWellFormed().slice(0, 1000);
const recoveryDigest = (value: ProjectionRecoveryView): string | undefined => {
    // Unusual/oversized recovery data declines the optimization; it never replaces the primary failure.
    try {return createHash('sha256').update(json(value, 32 * 1024)).digest('hex');} catch {return;}
};

/** One supervised owner; independent projection lanes, no cross-store history acknowledgment barrier. */
export class PortableStateController {
    private readonly runtimes = new Map<string, DeclarativeProjectionRuntime>();
    // At most one small timing record per fixed projection. No source/proof or serving authority is retained.
    private readonly mappingRetries = new Map<DeclarativeProjectionRuntime, {recoverySha256: string; eligibleAt: number}>();
    private retryEpoch = {};
    private current?: Promise<void>;
    private stopped = false;
    private constructor(private readonly options: ControllerOptions, private readonly maximumFrames: number,
                        private readonly mappingRetryEligibilityMs: number) {}
    static async create(options: ControllerOptions): Promise<PortableStateController> {
        if (typeof options.adapter.recovery !== 'function')
            throw new ProjectionContractError('projection.capability-unavailable', 'Production projections require a non-serving recovery checkpoint');
        const maximum = options.maximumFramesPerProjection ?? 8;
        if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32)
            throw new ProjectionContractError('projection.invalid-contract', 'Projection drain budget must be between1 and32');
        const interval = options.mappingRetryEligibilityMs ?? 0;
        if (!Number.isSafeInteger(interval) || interval < 0 || interval > 1000)
            throw new ProjectionContractError('projection.invalid-contract', 'Mapping retry eligibility must be between0 and1000ms');
        const controller = new PortableStateController(options, maximum, interval);
        for (const definition of options.configuration.projections) {
            currentProofConsumerScope()?.assertActive();
            const binding = portableStateBinding(options.configuration, definition, options.chainId);
            controller.runtimes.set(definition.id, await DeclarativeProjectionRuntime.create({adapter: options.adapter,
                definition, binding, genesis: {blockNum: 0, blockId: zero}, maximumPendingFrames: 1}));
            currentProofConsumerScope()?.assertActive();
        }
        return controller;
    }
    private report(value: PortableStateProgress) {
        // IPC is an observation only. Losing a hint must never erase durable source/application progress.
        try {this.options.onProgress?.(value);} catch {}
    }
    private async recovery(runtime: DeclarativeProjectionRuntime) {
        const value = await this.options.adapter.recovery!(runtime.binding);
        if (json(value.binding) !== json(runtime.binding) || value.initialized !== true
            || !Number.isSafeInteger(value.checkpoint.blockNum) || value.checkpoint.blockNum < 0
            || !/^[0-9a-f]{64}$/.test(value.checkpoint.blockId)
            || (value.checkpoint.blockNum === 0 && value.checkpoint.blockId !== zero))
            throw new ProjectionContractError('projection.incomplete', 'Incompatible portable recovery checkpoint');
        return value;
    }
    private async drainProjection(runtime: DeclarativeProjectionRuntime) {
        const common = {projectionId: runtime.definition.id, binding: runtime.binding};
        for (let count = 0; count < this.maximumFrames && !this.stopped; count++) {
            const operation = async (): Promise<boolean> => {
                const scope = currentProofConsumerScope();
                const retryEpoch = this.retryEpoch;
                let recovery: ProjectionRecoveryView | undefined;
                let processed: Promise<ProjectionApplyResult> | undefined;
                try {
                    currentProofConsumerScope()?.assertActive();
                    recovery = await this.recovery(runtime);
                    currentProofConsumerScope()?.assertActive();
                    await this.options.attempts?.bind({projectionId: runtime.definition.id,
                        bindingSha256: createHash('sha256').update(json(runtime.binding)).digest('hex'),
                        checkpointBlockNum: recovery.checkpoint.blockNum, checkpointBlockId: recovery.checkpoint.blockId});
                    currentProofConsumerScope()?.assertActive();
                    const waiting = this.mappingRetries.get(runtime);
                    this.mappingRetries.delete(runtime);
                    if (waiting && waiting.recoverySha256 === recoveryDigest(recovery) && performance.now() < waiting.eligibleAt && !this.stopped) {
                        this.mappingRetries.set(runtime, waiting);
                        return false;
                    }
                    let admitted: ProjectionBlock | undefined;
                    const admit = async (block: ProjectionBlock) => {
                        currentProofConsumerScope()?.assertActive();
                        const target = Object.freeze(structuredClone(block));
                        if (admitted) {
                            if (json(target) !== json(admitted))
                                throw new ProjectionContractError('projection.conflicting-replay', 'Interpreted frame differs from its admitted canonical target');
                            return;
                        }
                        if (this.stopped) throw new ProjectionContractError('projection.apply-unavailable', 'Projection owner stopped before source admission');
                        await this.options.adapter.markIncomplete(runtime.binding, target,
                            'Canonical projection source admitted; durable application is pending');
                        currentProofConsumerScope()?.assertActive();
                        admitted = target;
                    };
                    const selected = await this.options.source.frame(recovery.checkpoint.blockNum + 1, runtime.definition, admit);
                    currentProofConsumerScope()?.assertActive();
                    await this.options.attempts?.bind({blockNum: selected.frame.block.blockNum, blockId: selected.frame.block.blockId});
                    currentProofConsumerScope()?.assertActive();
                    if (this.stopped) return false;
                    await this.options.source.revalidate(selected.proof);
                    currentProofConsumerScope()?.assertActive();
                    // Runtime repeats the admission after its immutable capture. This binds the exact target and
                    // also reserves before mapping for compatible source fixtures that omit the early callback.
                    processed = runtime.process(selected.frame, admit);
                    const applied = await processed;
                    currentProofConsumerScope()?.assertActive();
                    await this.options.source.revalidate(selected.proof);
                    currentProofConsumerScope()?.assertActive();
                    this.report({...common, status: applied.status, checkpoint: applied.view.checkpoint, evidence: selected.evidence});
                } catch (error) {
                    // Preserve the primary failure across every fallback await, including successful returns.
                    // A later cancellation or fallback error cannot replace it with fresh retry authority.
                    const assertErrorHandlingActive = () => {
                        if (scope?.signal.aborted) throw error;
                        currentProofConsumerScope()?.assertActive();
                    };
                    assertErrorHandlingActive();
                    this.mappingRetries.delete(runtime);
                    const rejected = processed ? consumeDeclarativeMappingRejection(runtime, processed, error) : undefined;
                    if (error instanceof PortableProjectionFrameError) {
                        try {await this.options.adapter.markIncomplete(runtime.binding, error.block, reason(error));}
                        catch (markError) {
                            assertErrorHandlingActive();
                            this.report({...common, status: 'incomplete', ...(recovery ? {recovery} : {}),
                                reason: 'Durable projection failure marking requires retry: ' + reason(markError)});
                            return false;
                        }
                        assertErrorHandlingActive();
                    }
                    // Runtime mapping errors already mark incomplete. Transport/apply errors retain exact source intent.
                    // Resume always asks the adapter for checkpoint+1; no failed target is skipped or acknowledged here.
                    assertErrorHandlingActive();
                    let failureRecovery: ProjectionRecoveryView | undefined;
                    try {recovery = failureRecovery = await this.recovery(runtime);} catch {assertErrorHandlingActive();}
                    assertErrorHandlingActive();
                    const recoverySha256 = rejected && this.mappingRetryEligibilityMs > 0 && failureRecovery ? recoveryDigest(failureRecovery) : undefined;
                    if (rejected && recoverySha256 && this.mappingRetryEligibilityMs > 0 && !this.stopped && retryEpoch === this.retryEpoch && failureRecovery
                        && failureRecovery.gap === null && failureRecovery.pending?.digest === null
                        && json(failureRecovery.pending.block) === json(rejected)
                        && failureRecovery.checkpoint.blockNum + 1 === rejected.blockNum
                        && failureRecovery.checkpoint.blockId === rejected.previousBlockId) {
                        this.mappingRetries.set(runtime, {recoverySha256,
                            eligibleAt: performance.now() + this.mappingRetryEligibilityMs});
                    }
                    this.report({...common, status: recovery?.pending || recovery?.gap ? 'incomplete' : 'waiting',
                        ...(recovery ? {recovery, checkpoint: recovery.checkpoint} : {}), reason: reason(error)});
                    return false;
                }
                return true;
            };
            const keepGoing = this.options.attempts ? await this.options.attempts.run(common, operation) : await operation();
            if (!keepGoing) return;
        }
    }
    drain(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        if (this.current) return this.current;
        const work = Promise.all([...this.runtimes.values()].map(runtime => this.drainProjection(runtime))).then(() => undefined);
        this.current = work.finally(() => {this.current = undefined;});
        return this.current;
    }
    /** Existing owner/fork/config lifecycle notifications can only discard timing, never create authority. */
    invalidateMappingRetryEligibility(): void {this.retryEpoch = {}; this.mappingRetries.clear();}
    async stop(): Promise<void> {this.stopped = true; this.invalidateMappingRetryEligibility(); await this.current;}
}
