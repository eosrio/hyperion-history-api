import {randomUUID} from 'node:crypto';
import {ProjectionContractError, validateProjectionRecoveryActivation, validateProjectionRetainedCheckpoints,
    type ProjectionRecoveryAdapter, type ProjectionBinding, type ProjectionBlock, type ProjectionCheckpoint,
    type ProjectionRollbackRecoveryView, type ProjectionRollbackRequest} from '@eosrio/hyperion-sdk/projection';
import {RecoverableProjectionRuntime} from './recoverable-runtime.js';
import {portableStateBinding, type ResolvedPortableStateConfiguration} from './config.js';
import {PortableProjectionFrameError, type PortableProjectionSource, type PortableProjectionSourceEvidence,
    type PortableProjectionRecoveryPlan} from './source.js';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';

export interface PortableStateProgress {
    readonly projectionId: string; readonly binding: ProjectionBinding;
    readonly status: 'applied' | 'duplicate' | 'incomplete' | 'waiting' | 'recovering';
    readonly checkpoint?: ProjectionCheckpoint;
    readonly recovery?: ProjectionRollbackRecoveryView;
    readonly evidence?: PortableProjectionSourceEvidence;
    readonly reason?: string;
}
interface ControllerOptions {
    chainId: string; configuration: ResolvedPortableStateConfiguration; adapter: ProjectionRecoveryAdapter;
    source: Pick<PortableProjectionSource, 'frame' | 'revalidate' | 'planRecovery' | 'revalidateRecovery'>;
    onProgress?: (value: PortableStateProgress) => void;
    maximumFramesPerProjection?: number;
}
const zero = '0'.repeat(64);
const json = protocolImmutableJson;
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).toWellFormed().slice(0, 1000);

/** One supervised owner; independent projection lanes, no cross-store history acknowledgment barrier. */
export class PortableStateController {
    private readonly runtimes = new Map<string, RecoverableProjectionRuntime>();
    private current?: Promise<void>;
    private stopped = false;
    private constructor(private readonly options: ControllerOptions, private readonly maximumFrames: number) {}
    static async create(options: ControllerOptions): Promise<PortableStateController> {
        if (typeof options.adapter.recovery !== 'function' || typeof options.adapter.retainedCheckpoints !== 'function'
            || typeof options.source.planRecovery !== 'function' || typeof options.source.revalidateRecovery !== 'function')
            throw new ProjectionContractError('projection.capability-unavailable', 'Production projections require canonical rollback and retained checkpoint inspection');
        const maximum = options.maximumFramesPerProjection ?? 8;
        if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32)
            throw new ProjectionContractError('projection.invalid-contract', 'Projection drain budget must be between 1 and 32');
        // Reject incompatible adapters before initializing any configured projection.
        for (const definition of options.configuration.projections) {
            const result = validateProjectionRecoveryActivation(definition, portableStateBinding(options.configuration, definition, options.chainId),
                options.adapter.capabilities, options.adapter.recoveryCapabilities);
            if (!result.valid) throw new ProjectionContractError('projection.capability-unavailable', 'Production projection recovery capabilities are unavailable');
        }
        const controller = new PortableStateController(options, maximum);
        for (const definition of options.configuration.projections) {
            const binding = portableStateBinding(options.configuration, definition, options.chainId);
            controller.runtimes.set(definition.id, await RecoverableProjectionRuntime.create({adapter: options.adapter,
                definition, binding, genesis: {blockNum: 0, blockId: zero}, maximumPendingFrames: 1}));
        }
        return controller;
    }
    private report(value: PortableStateProgress) {
        // IPC is an observation only. Losing a hint must never erase durable source/application progress.
        try {this.options.onProgress?.(value);} catch {}
    }
    private originalRollback(recovery: ProjectionRollbackRecoveryView): ProjectionRollbackRequest {
        const operation = recovery.rollback!;
        return {binding: recovery.binding, revision: operation.sourceRevision, operationId: operation.operationId,
            from: operation.from, ancestor: operation.ancestor, maxBlocks: this.maximumFrames};
    }
    private async drainProjection(runtime: RecoverableProjectionRuntime) {
        const common = {projectionId: runtime.definition.id, binding: runtime.binding};
        for (let count = 0; count < this.maximumFrames && !this.stopped; count++) {
            let recovery: ProjectionRollbackRecoveryView | undefined;
            let admit: ((block: ProjectionBlock) => Promise<void>) | undefined;
            try {
                recovery = await runtime.resumeRecovery();
                if (recovery.rollback?.status === 'unavailable')
                    throw new ProjectionContractError('projection.rollback-unavailable', recovery.rollback.reason!);
                // Resume the admitted operation unchanged before planning another canonical move.
                if (recovery.rollback?.status === 'running') {
                    if (this.stopped) return;
                    const result = await runtime.rollback(this.originalRollback(recovery));
                    this.report({...common, status: 'recovering', recovery: result.recovery, checkpoint: result.recovery.checkpoint});
                    continue;
                }
                const inspected = validateProjectionRetainedCheckpoints(await this.options.adapter.retainedCheckpoints({binding: runtime.binding,
                    revision: recovery.revision}));
                if (!inspected.valid || json(inspected.value.recovery.binding) !== json(runtime.binding)
                    || !inspected.value.recovery.initialized || inspected.value.recovery.revision !== recovery.revision)
                    throw new ProjectionContractError('projection.incomplete', 'Incompatible retained projection checkpoint inspection');
                recovery = inspected.value.recovery;
                const plan: PortableProjectionRecoveryPlan = await this.options.source.planRecovery(inspected.value, this.options.configuration.finality);
                if (this.stopped) return;
                await this.options.source.revalidateRecovery(plan);
                if (this.stopped) return;
                if (plan.rollback) {
                    const result = await runtime.rollback({binding: runtime.binding, revision: recovery.revision,
                        operationId: randomUUID(), from: recovery.checkpoint, ancestor: plan.rollback.ancestor, maxBlocks: this.maximumFrames});
                    this.report({...common, status: 'recovering', recovery: result.recovery, checkpoint: result.recovery.checkpoint,
                        reason: plan.rollback.reason});
                    continue;
                }
                if (plan.unavailableSource && recovery.pending === null && recovery.gap === null) {
                    const missing = plan.unavailableSource;
                    if (missing.block.blockNum !== plan.target.blockNum || missing.block.blockId !== plan.target.blockId
                        || missing.block.blockNum <= recovery.checkpoint.blockNum)
                        throw new ProjectionContractError('projection.invalid-contract', 'Unavailable source differs from the certified eligible target');
                    await this.options.adapter.markIncomplete({binding: runtime.binding, revision: recovery.revision,
                        block: missing.block, reason: missing.reason});
                    recovery = await runtime.recovery();
                    this.report({...common, status: 'incomplete', recovery, checkpoint: recovery.checkpoint, reason: missing.reason});
                    return;
                }
                if (plan.checkpointStatus !== 'canonical' || recovery.checkpoint.blockNum >= plan.target.blockNum) {
                    this.report({...common, status: recovery.pending || recovery.gap ? 'incomplete' : 'waiting', recovery,
                        checkpoint: recovery.checkpoint});
                    return;
                }
                const revision = recovery.revision;
                let admitted: ProjectionBlock | undefined;
                admit = async block => {
                    if (this.stopped) throw new ProjectionContractError('projection.apply-unavailable', 'Projection owner stopped before source admission');
                    await this.options.source.revalidateRecovery(plan);
                    if (this.stopped) throw new ProjectionContractError('projection.apply-unavailable', 'Projection owner stopped during source validation');
                    const target = Object.freeze(structuredClone(block));
                    if (target.blockNum > plan.target.blockNum)
                        throw new ProjectionContractError('projection.incomplete', 'Source target is beyond this finality view');
                    if (admitted) {
                        if (json(target) !== json(admitted))
                            throw new ProjectionContractError('projection.conflicting-replay', 'Interpreted frame differs from its admitted canonical target');
                        return;
                    }
                    await this.options.adapter.markIncomplete({binding: runtime.binding, revision, block: target,
                        reason: 'Canonical projection source admitted; durable application is pending'});
                    admitted = target;
                };
                const selected = await this.options.source.frame(recovery.checkpoint.blockNum + 1, runtime.definition, admit, plan.target);
                if (this.stopped) return;
                await this.options.source.revalidate(selected.proof);
                const applied = await runtime.process(selected.frame, admit);
                await this.options.source.revalidate(selected.proof);
                await this.options.source.revalidateRecovery(plan);
                this.report({...common, status: applied.status, checkpoint: applied.view.checkpoint, evidence: selected.evidence});
            } catch (error) {
                if (error instanceof PortableProjectionFrameError && admit) {
                    try {await admit(error.block);}
                    catch (markError) {
                        this.report({...common, status: 'incomplete', ...(recovery ? {recovery} : {}),
                            reason: 'Durable projection failure marking requires retry: ' + reason(markError)});
                        return;
                    }
                }
                // Mapping errors retain exact pending intent; failures never skip a source block.
                try {recovery = await runtime.recovery();} catch {}
                this.report({...common, status: recovery?.pending || recovery?.gap || recovery?.rollback?.status === 'unavailable'
                    || recovery?.rollback?.status === 'running' ? 'incomplete' : 'waiting',
                    ...(recovery ? {recovery, checkpoint: recovery.checkpoint} : {}), reason: reason(error)});
                return;
            }
        }
    }
    drain(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        if (this.current) return this.current;
        const work = Promise.all([...this.runtimes.values()].map(runtime => this.drainProjection(runtime))).then(() => undefined);
        this.current = work.finally(() => {this.current = undefined;});
        return this.current;
    }
    async stop(): Promise<void> {this.stopped = true; await this.current;}
}
