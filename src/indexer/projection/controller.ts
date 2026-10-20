import {ProjectionContractError, type ProjectionAdapter, type ProjectionBinding, type ProjectionCheckpoint,
    type ProjectionRecoveryView} from '@eosrio/hyperion-sdk/projection';
import {DeclarativeProjectionRuntime} from './runtime.js';
import {portableStateBinding, type ResolvedPortableStateConfiguration} from './config.js';
import {PortableProjectionFrameError, type PortableProjectionSource, type PortableProjectionSourceEvidence} from './source.js';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';

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
}
const zero = '0'.repeat(64);
const json = protocolImmutableJson;
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).toWellFormed().slice(0, 1000);

/** One supervised owner; independent projection lanes, no cross-store history acknowledgment barrier. */
export class PortableStateController {
    private readonly runtimes = new Map<string, DeclarativeProjectionRuntime>();
    private current?: Promise<void>;
    private stopped = false;
    private constructor(private readonly options: ControllerOptions, private readonly maximumFrames: number) {}
    static async create(options: ControllerOptions): Promise<PortableStateController> {
        if (typeof options.adapter.recovery !== 'function')
            throw new ProjectionContractError('projection.capability-unavailable', 'Production projections require a non-serving recovery checkpoint');
        const maximum = options.maximumFramesPerProjection ?? 8;
        if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32)
            throw new ProjectionContractError('projection.invalid-contract', 'Projection drain budget must be between1 and32');
        const controller = new PortableStateController(options, maximum);
        for (const definition of options.configuration.projections) {
            const binding = portableStateBinding(options.configuration, definition, options.chainId);
            controller.runtimes.set(definition.id, await DeclarativeProjectionRuntime.create({adapter: options.adapter,
                definition, binding, genesis: {blockNum: 0, blockId: zero}, maximumPendingFrames: 1}));
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
            let recovery: ProjectionRecoveryView | undefined;
            try {
                recovery = await this.recovery(runtime);
                const selected = await this.options.source.frame(recovery.checkpoint.blockNum + 1, runtime.definition);
                if (this.stopped) return;
                await this.options.source.revalidate(selected.proof);
                const applied = await runtime.process(selected.frame);
                await this.options.source.revalidate(selected.proof);
                this.report({...common, status: applied.status, checkpoint: applied.view.checkpoint, evidence: selected.evidence});
            } catch (error) {
                if (error instanceof PortableProjectionFrameError) {
                    try {await this.options.adapter.markIncomplete(runtime.binding, error.block, reason(error));}
                    catch (markError) {
                        this.report({...common, status: 'incomplete', ...(recovery ? {recovery} : {}),
                            reason: 'Durable projection failure marking requires retry: ' + reason(markError)});
                        return;
                    }
                }
                // Runtime mapping errors already mark incomplete. Transport/apply errors retain exact source intent.
                // Resume always asks the adapter for checkpoint+1; no failed target is skipped or acknowledged here.
                try {recovery = await this.recovery(runtime);} catch {}
                this.report({...common, status: recovery?.pending || recovery?.gap ? 'incomplete' : 'waiting',
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
