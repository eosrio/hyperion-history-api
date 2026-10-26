import {ProjectionContractError, validateProjectionRetainedCheckpoints,
    type ProjectionBlock, type ProjectionCheckpoint, type ProjectionDefinition,
    type ProjectionRetainedCheckpointView} from '@eosrio/hyperion-sdk/projection';
import {ProtocolAbiProofUnavailableError, type ProtocolAbiProofReader, type ProtocolAbiProofView} from '../protocol/abi-proof.js';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';
import type {ProtocolSourceBindingStore, ProtocolSourceProfile} from '../protocol/source-bindings.js';
import type {PortableStateFinality} from './config.js';

type IntentStatus = 'absent' | 'canonical' | 'orphaned' | 'unresolved';
export interface PortableProjectionRecoveryPlan {
    readonly target: ProjectionCheckpoint;
    /** Original source report; it may be ahead of the journal's covered head during historical replay. */
    readonly reportedIrreversible: ProjectionCheckpoint;
    readonly finality: PortableStateFinality;
    readonly checkpointStatus: 'canonical' | 'orphaned' | 'ahead' | 'unresolved';
    readonly intents: {readonly pending: IntentStatus; readonly gap: IntentStatus};
    /** Exact eligible source header for durable failure marking; never an old-branch membership grant. */
    readonly unavailableSource?: {readonly block: ProjectionBlock; readonly reason: string};
    readonly rollback: null | {
        readonly ancestor: ProjectionCheckpoint;
        readonly reason: 'orphaned-checkpoint' | 'orphaned-intent' | 'retention-unavailable';
    };
}
export interface PortableProjectionSourceState {
    readonly checkpoint: ProjectionCheckpoint;
    readonly target: ProjectionCheckpoint;
    readonly reportedIrreversible: ProjectionCheckpoint;
    readonly finality: PortableStateFinality;
}
interface Authority {
    readonly head: ProtocolAbiProofView;
    readonly target: ProjectionCheckpoint;
    readonly targetProof: ProtocolAbiProofView | null;
    readonly reportedIrreversible: ProjectionCheckpoint;
    readonly finality: PortableStateFinality;
    readonly ancestors: Map<number, ProtocolAbiProofView>;
}
interface Options {
    readonly reader: ProtocolAbiProofReader;
    readonly bindings: ProtocolSourceBindingStore;
    readonly profile: ProtocolSourceProfile;
    readonly maximumAncestry: number;
    readonly assertCoverage: () => Promise<{head: {commitId: string}}>;
    readonly assertDefinition: (proof: ProtocolAbiProofView, definition: ProjectionDefinition) => Promise<unknown>;
}
const zero: ProjectionCheckpoint = Object.freeze({blockNum: 0, blockId: '0'.repeat(64)});
const json = protocolImmutableJson;
const same = (a: ProjectionCheckpoint, b: ProjectionCheckpoint) => a.blockNum === b.blockNum && a.blockId === b.blockId;
const point = (value: ProjectionCheckpoint): ProjectionCheckpoint => Object.freeze({blockNum: value.blockNum, blockId: value.blockId});
function unavailable(message: string): never {throw new ProtocolAbiProofUnavailableError('projection_source_unavailable', message);}
const freeze = <T>(value: T): T => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
};
function checkpoint(input: ProjectionCheckpoint): ProjectionCheckpoint {
    const value = JSON.parse(json(input));
    if (!Number.isSafeInteger(value?.blockNum) || value.blockNum < 0 || value.blockNum > 0xffffffff
        || !/^[0-9a-f]{64}$/.test(value.blockId) || (value.blockNum === 0 && value.blockId !== zero.blockId))
        throw new ProjectionContractError('projection.invalid-contract', 'Invalid projection source checkpoint');
    return point(value);
}

/** Host-only canonical planning. Applied metadata is evidence of undo coverage, never canonical authority. */
export class PortableProjectionRecoverySource {
    private readonly plans = new WeakMap<PortableProjectionRecoveryPlan, Authority>();
    private readonly states = new WeakMap<PortableProjectionSourceState, {authority: Authority; proof: ProtocolAbiProofView}>();
    private lastIrreversible: ProjectionCheckpoint | undefined;
    constructor(private readonly options: Options) {}

    private async ancestor(authority: Authority, blockNum: number): Promise<ProtocolAbiProofView> {
        let proof = authority.ancestors.get(blockNum);
        if (!proof) {
            proof = await this.options.reader.ancestor(authority.head, blockNum);
            authority.ancestors.set(blockNum, proof);
        }
        return proof;
    }
    private async authority(finality: PortableStateFinality): Promise<Authority> {
        if (!['reversible', 'irreversible'].includes(finality))
            throw new ProjectionContractError('projection.invalid-contract', 'Invalid projection finality');
        await this.options.assertCoverage();
        const head = await this.options.reader.openHead();
        const {selection, context} = await this.options.bindings.readSelection(head.selectionId);
        if (json(selection.source) !== json(head.source) || json(context.protocol) !== json(this.options.profile)
            || context.chainId !== head.source.chainId) unavailable('Canonical source finality selection does not match its head');
        const reportedIrreversible = checkpoint(selection.irreversible);
        const prior = this.lastIrreversible;
        if (prior && (reportedIrreversible.blockNum < prior.blockNum
            || (reportedIrreversible.blockNum === prior.blockNum && reportedIrreversible.blockId !== prior.blockId)))
            unavailable('Source irreversible position regressed or changed identity');
        const authority: Authority = {head, target: point(head.source), targetProof: head, reportedIrreversible, finality,
            ancestors: new Map([[head.source.blockNum, head]])};
        // A source's LIB tuple is never replaced with an ID guessed from a capped height.
        let irreversibleProof: ProtocolAbiProofView | null = null;
        if (reportedIrreversible.blockNum > 0 && reportedIrreversible.blockNum <= head.source.blockNum) {
            irreversibleProof = await this.ancestor(authority, reportedIrreversible.blockNum);
            if (!same(irreversibleProof.source, reportedIrreversible)) unavailable('Reported irreversible block is not canonical');
        }
        const target = finality === 'irreversible' && reportedIrreversible.blockNum <= head.source.blockNum
            ? reportedIrreversible : point(head.source);
        const targetProof = finality === 'reversible' || reportedIrreversible.blockNum > head.source.blockNum ? head : irreversibleProof;
        const result: Authority = {...authority, target, targetProof};
        await this.assertCurrent(result);
        // This is an in-process revocation fence; source metadata still has to prove each report on every read.
        this.lastIrreversible = reportedIrreversible;
        return result;
    }
    private async assertCurrent(authority: Authority): Promise<void> {
        await this.options.reader.revalidate(authority.head);
        const control = await this.options.assertCoverage();
        if (control.head.commitId !== authority.head.commitId)
            unavailable('Canonical source head changed during finality validation');
    }
    private async canonicalPoint(authority: Authority, blockNum: number): Promise<ProjectionCheckpoint> {
        if (authority.head.source.blockNum - blockNum === this.options.maximumAncestry + 1) {
            const child = await this.ancestor(authority, blockNum + 1);
            const previous = child.source.previousBlockId;
            if (!previous || previous === zero.blockId) unavailable('Certified next block lacks an exact predecessor');
            // This proves only the parent identity, not its excluded capture or ABI state.
            return point({blockNum, blockId: previous});
        }
        return point((await this.ancestor(authority, blockNum)).source);
    }
    private async status(authority: Authority, value: ProjectionCheckpoint, block?: ProjectionBlock): Promise<'canonical' | 'orphaned' | 'unresolved'> {
        if (value.blockNum === 0) return same(value, zero) ? 'canonical' : 'orphaned';
        const distance = authority.head.source.blockNum - value.blockNum;
        if (distance < 0 || distance > this.options.maximumAncestry + 1) return 'unresolved';
        if (distance === this.options.maximumAncestry + 1) {
            if (!same(await this.canonicalPoint(authority, value.blockNum), value)) return 'orphaned';
            return block ? 'unresolved' : 'canonical';
        }
        const proof = await this.ancestor(authority, value.blockNum);
        return same(proof.source, value) && (!block || block.previousBlockId === (proof.source.previousBlockId ?? zero.blockId))
            ? 'canonical' : 'orphaned';
    }
    private async zeroAncestor(authority: Authority): Promise<boolean> {
        if (authority.head.source.blockNum - 1 > this.options.maximumAncestry) return false;
        const genesis = await this.ancestor(authority, 1);
        await this.options.reader.nativeGenesisFrame(genesis);
        return true;
    }

    async planRecovery(input: ProjectionRetainedCheckpointView, finality: PortableStateFinality): Promise<PortableProjectionRecoveryPlan> {
        // Capture the caller's atomic adapter snapshot before the first storage await.
        const validated = validateProjectionRetainedCheckpoints(input);
        if (!validated.valid) throw new ProjectionContractError('projection.invalid-contract', validated.errors.map(error => error.message).join('; '));
        const {recovery, checkpoints} = validated.value;
        if (recovery.rollback?.status === 'running') unavailable('Resume the original running rollback operation before canonical planning');
        const authority = await this.authority(finality);
        if (recovery.binding.chainId !== authority.head.source.chainId)
            throw new ProjectionContractError('projection.invalid-contract', 'Projection recovery belongs to another chain');
        const checkpointStatus: PortableProjectionRecoveryPlan['checkpointStatus'] = recovery.checkpoint.blockNum > authority.head.source.blockNum ? 'ahead'
            : await this.status(authority, recovery.checkpoint);
        // Instances are isolated by finality mode. An applied irreversible point is a durable
        // finality floor, even when a restarted source is still replaying an older LIB report.
        if (finality === 'irreversible' && checkpointStatus === 'orphaned')
            unavailable('Canonical source conflicts with the applied irreversible finality floor');
        let pending: IntentStatus = recovery.pending ? await this.status(authority, recovery.pending.block, recovery.pending.block) : 'absent';
        let gap: IntentStatus = recovery.gap ? await this.status(authority, recovery.gap.block, recovery.gap.block) : 'absent';
        // An exact predecessor mismatch proves a linked intent orphaned even before its height is covered.
        if (checkpointStatus === 'orphaned' && recovery.pending?.block.previousBlockId === recovery.checkpoint.blockId)
            pending = 'orphaned';
        if (checkpointStatus === 'orphaned' && recovery.gap?.block.blockNum === recovery.checkpoint.blockNum + 1
            && recovery.gap.block.previousBlockId === recovery.checkpoint.blockId) gap = 'orphaned';
        if (pending === 'orphaned' && recovery.pending && recovery.gap?.block.blockNum === recovery.pending.block.blockNum + 1
            && recovery.gap.block.previousBlockId === recovery.pending.block.blockId) gap = 'orphaned';
        let rollback: PortableProjectionRecoveryPlan['rollback'] = null;
        const orphanIntent = pending === 'orphaned' || gap === 'orphaned';
        // A canonical pending failure must be retried before cancelling a later orphan gap. Unknown inputs stay fenced.
        if ((checkpointStatus === 'orphaned' || orphanIntent) && recovery.checkpoint.blockNum <= authority.target.blockNum
            && checkpointStatus !== 'ahead' && checkpointStatus !== 'unresolved'
            && pending !== 'unresolved' && gap !== 'unresolved' && !(pending === 'canonical' && gap === 'orphaned')) {
            const upper = Math.min(recovery.checkpoint.blockNum, authority.target.blockNum);
            let ancestor: ProjectionCheckpoint | undefined;
            for (const retained of checkpoints) {
                if (retained.blockNum > upper) continue;
                if (retained.blockNum === 0) {
                    if (await this.zeroAncestor(authority)) ancestor = zero;
                } else if (authority.head.source.blockNum - retained.blockNum <= this.options.maximumAncestry + 1
                    && await this.status(authority, retained) === 'canonical') ancestor = point(retained);
                if (ancestor) break;
            }
            let reason: NonNullable<PortableProjectionRecoveryPlan['rollback']>['reason'] = checkpointStatus === 'orphaned'
                ? 'orphaned-checkpoint' : 'orphaned-intent';
            if (!ancestor) {
                // This is explicitly NOT a claimed old-branch ancestor: the adapter must durably reject absent undo coverage.
                if (upper === 0) {
                    if (!await this.zeroAncestor(authority)) unavailable('Native genesis lineage is outside retained source ancestry');
                    ancestor = zero;
                } else ancestor = await this.canonicalPoint(authority, upper);
                reason = 'retention-unavailable';
            }
            rollback = {ancestor, reason};
        }
        let unavailableSource: PortableProjectionRecoveryPlan['unavailableSource'];
        if (checkpointStatus === 'unresolved' && recovery.checkpoint.blockNum < authority.target.blockNum
            && recovery.pending === null && recovery.gap === null) {
            const eligible = authority.targetProof?.source;
            if (!eligible || !eligible.previousBlockId || eligible.previousBlockId === zero.blockId)
                unavailable('Eligible source lacks an exact certified gap header');
            unavailableSource = {block: {blockNum: eligible.blockNum, blockId: eligible.blockId, previousBlockId: eligible.previousBlockId},
                reason: 'Projection checkpoint is outside bounded canonical ancestry; historical recovery input is required'};
        }
        const plan = freeze({target: authority.target, reportedIrreversible: authority.reportedIrreversible,
            finality, checkpointStatus, intents: {pending, gap}, rollback, ...(unavailableSource ? {unavailableSource} : {})});
        this.plans.set(plan, authority);
        await this.assertCurrent(authority);
        return plan;
    }
    async revalidateRecovery(plan: PortableProjectionRecoveryPlan): Promise<void> {
        const authority = this.plans.get(plan);
        if (!authority) unavailable('Recovery plan was not issued by this source');
        await this.options.reader.revalidate(authority.head);
        const current = await this.authority(authority.finality);
        await this.options.reader.revalidate(authority.head);
        await this.assertCurrent(current);
    }
    async openState(input: ProjectionCheckpoint, finality: PortableStateFinality): Promise<PortableProjectionSourceState> {
        const completed = checkpoint(input);
        if (completed.blockNum === 0) unavailable('Checkpoint zero is not a serving grant');
        const authority = await this.authority(finality);
        if (completed.blockNum > authority.target.blockNum || await this.status(authority, completed) !== 'canonical')
            unavailable('Projection completed checkpoint is outside the current eligible canonical branch');
        const proof = await this.ancestor(authority, completed.blockNum);
        const state = freeze({checkpoint: completed, target: authority.target, reportedIrreversible: authority.reportedIrreversible, finality});
        this.states.set(state, {authority, proof});
        await this.assertCurrent(authority);
        return state;
    }
    async assertState(state: PortableProjectionSourceState, definition: ProjectionDefinition): Promise<void> {
        const issued = this.states.get(state);
        if (!issued) unavailable('Projection source state was not issued by this source');
        await this.options.assertDefinition(issued.proof, definition);
        const current = await this.authority(issued.authority.finality);
        if (!current.targetProof || state.checkpoint.blockNum > current.target.blockNum)
            unavailable('Projection completed checkpoint exceeds current eligible finality');
        await this.options.assertDefinition(current.targetProof, definition);
        await this.options.reader.revalidate(issued.proof);
        await this.assertCurrent(current);
    }
}
