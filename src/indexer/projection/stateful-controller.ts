import {createHash} from 'node:crypto';
import type {ProjectionCheckpoint} from '@eosrio/hyperion-sdk/projection';
import {StatefulContractError, type StatefulView} from '@eosrio/hyperion-sdk/projection-stateful';
import {captureStatefulRawTargetV2, executeStatefulOwnerBlockV2, type CapturedRawStatefulTargetV2,
    type StatefulCandidateStoreV2, type StatefulOwnerAdapterV2, type StatefulOwnerDeclarationV2,
    type StatefulOwnerIdentityV2, type StatefulOwnerLeaseV2, type StatefulOwnerRecoveryV2,
    type StatefulReductionV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';
import {ProtocolAbiProofUnavailableError} from '../protocol/abi-proof.js';
import {currentProofConsumerScope} from '../protocol/proof-consumer-scope.js';
import type {PortableProjectionRawTarget, PortableProjectionSource} from './source.js';
import type {StatefulActionMetadataOptionsV2} from '@eosrio/hyperion-sdk/projection-stateful-source-v2';
import {statefulOwnerExpectationDigest, type StatefulOwnerExpectation} from './stateful-expectation.js';
import type {StatefulOwnerFinality} from './stateful-config.js';
import type {StatefulCandidateCustodyV2} from './stateful-custody.js';
export {statefulOwnerExpectationDigest, type StatefulOwnerExpectation} from './stateful-expectation.js';

const json = protocolImmutableJson;
const hash = (input: unknown) => createHash('sha256').update(json(input)).digest('hex');
const zero = Object.freeze({blockNum: 0, blockId: '0'.repeat(64)});
const same = (a: unknown, b: unknown) => json(a) === json(b);
const bounded = (custody: OwnerOptions['custody']): custody is StatefulCandidateCustodyV2 =>
    typeof (custody as Partial<StatefulCandidateCustodyV2>).block === 'function'
    && typeof (custody as Partial<StatefulCandidateCustodyV2>).pruneBelow === 'function'
    && typeof (custody as Partial<StatefulCandidateCustodyV2>).purgeAbove === 'function';
function requireOwner(value: unknown, message: string): asserts value {
    if (!value) throw new StatefulContractError('stateful.unavailable', message);
}
interface OwnerOptions {
    readonly declaration: StatefulOwnerDeclarationV2;
    readonly adapter: StatefulOwnerAdapterV2;
    readonly source: Pick<PortableProjectionSource, 'head' | 'irreversibleTarget' | 'open' | 'revalidate' | 'statefulBlock' | 'assertStatefulView'>;
    readonly identity: StatefulOwnerIdentityV2;
    /** Bounded custody is pruned and purged by this owner; plain custody keeps every candidate. */
    readonly custody: StatefulCandidateStoreV2 | StatefulCandidateCustodyV2;
    /** Blocks the custody floor advances between prune requests. Default 512. */
    readonly candidatePruneIntervalBlocks?: number;
    /** Pruning is maintenance: its failures never fail or fence a frame, and the next frame retries. */
    readonly onRetentionError?: (error: unknown) => void;
    readonly reduce: (reduction: StatefulReductionV2) => Promise<void>;
    /** Actual worker incarnation/attempt checks, never a declaration or metadata readiness label. */
    readonly assertActive: () => void;
    readonly requireAttemptScope: boolean;
    readonly run: (metadata: unknown, operation: () => Promise<boolean>) => Promise<boolean>;
    readonly maximumFramesPerDrain: number;
    readonly finality?: StatefulOwnerFinality;
    readonly sourceMetadata?: StatefulActionMetadataOptionsV2;
    readonly onError?: (error: unknown) => void;
}

/** One actual projection owner; durable recovery, source and fixed candidate custody share one lane. */
export class StatefulProjectionControllerV2 {
    private lease?: StatefulOwnerLeaseV2;
    private revision?: string;
    private current?: Promise<void>;
    private stopped = false;
    private reconciled = false;
    private failed = false;
    private admitting = false;
    private observedTarget?: string;
    private readonly irreversible: boolean;
    private readonly retention?: StatefulCandidateCustodyV2;
    private readonly pruneInterval: number;
    /** Highest floor fully pruned by this process. Zero after a restart, so the first prune also clears earlier leftovers. */
    private prunedFloor = 0;
    /** Set after a rollback, or on a claim of storage that completed one; cleared once undone-branch custody is purged. */
    private purgeStale = false;
    constructor(private readonly options: OwnerOptions) {
        this.irreversible = options.finality === 'irreversible';
        requireOwner(Number.isSafeInteger(options.maximumFramesPerDrain) && options.maximumFramesPerDrain > 0,
            'Stateful drain quantum is invalid');
        this.pruneInterval = options.candidatePruneIntervalBlocks ?? 512;
        requireOwner(Number.isSafeInteger(this.pruneInterval) && this.pruneInterval > 0, 'Stateful candidate prune interval is invalid');
        if (bounded(options.custody)) this.retention = options.custody;
    }
    private guard = () => {
        requireOwner(!this.stopped, 'Stateful owner is stopped'); this.options.assertActive();
        // Resolve the current frame's scope, rather than retaining the initialization attempt's scope.
        currentProofConsumerScope(this.options.requireAttemptScope)?.assertActive();
    };
    private async recovery(): Promise<StatefulOwnerRecoveryV2 | null> {
        this.guard(); const value = await this.options.adapter.recovery(); this.guard();
        this.observedTarget = value?.owner && same(value.owner.identity, this.options.identity) ? statefulOwnerExpectationDigest({
            declarationDigest: this.options.declaration.digest, owner: value.owner, view: value.view}) : undefined;
        return value;
    }
    private async claim(recovery: StatefulOwnerRecoveryV2 | null): Promise<StatefulOwnerRecoveryV2> {
        this.guard();
        const lease = await this.options.adapter.acquireOwner({expected: recovery && {version: recovery.version,
            view: recovery.view, owner: recovery.owner}, nextOwner: this.options.identity}, this.guard);
        this.guard(); const current = await this.recovery();
        requireOwner(current?.owner && same(current.owner.identity, this.options.identity), 'Native owner acquisition is unresolved');
        this.lease = lease; this.revision = current.view.revision; this.reconciled = false;
        // A restart may have lost the purge that follows a rollback. Purging again is cheap and safe.
        if (current.rollback?.status === 'complete') this.purgeStale = true;
        return current;
    }
    private async canonical(point: ProjectionCheckpoint): Promise<boolean> {
        if (point.blockNum === 0) {
            // This is ancestry verification while serving is fenced, never empty-source reduction.
            const genesis = await this.options.source.statefulBlock(1, this.options.declaration, async () => {}, this.options.sourceMetadata);
            return same(genesis.source.source.previous, zero);
        }
        try {await this.options.source.open(point); return true;}
        catch (error) {
            if (error instanceof ProtocolAbiProofUnavailableError && error.code === 'source_not_canonical') return false;
            throw error; // Missing/unknown ancestry never proves a fork or a safe rollback target.
        }
    }
    private async recoverFork(recovery: StatefulOwnerRecoveryV2): Promise<boolean> {
        const retained = recovery.rollback;
        if (this.irreversible) {
            // Applied effects are final. A conflict leaves this view unavailable; it never undoes them.
            requireOwner((!retained || retained.status === 'complete') && await this.canonical(recovery.view.checkpoint)
                && (!recovery.raw || await this.canonical(recovery.raw.target.target.block)),
            'Canonical source conflicts with the applied irreversible finality floor');
            return false;
        }
        if (retained && retained.status !== 'complete') {
            requireOwner(retained.status !== 'unavailable', 'Stateful rollback needs historical recovery');
            this.reconciled = false; this.purgeStale = true;
            await this.options.adapter.rollbackOwned(this.lease!, {declarationDigest: this.options.declaration.digest,
                revision: retained.sourceRevision, operationId: retained.operationId, from: retained.from,
                ancestor: retained.ancestor, maxBlocks: this.options.maximumFramesPerDrain});
            this.lease = undefined; return true;
        }
        const checkpointCanonical = await this.canonical(recovery.view.checkpoint);
        if (checkpointCanonical && (!recovery.raw || await this.canonical(recovery.raw.target.target.block))) return false;
        this.reconciled = false;
        const checkpoints = await this.options.adapter.retainedCheckpoints(this.lease!);
        requireOwner(same(checkpoints.recovery, recovery), 'Native recovery changed during ancestor selection');
        let ancestor: ProjectionCheckpoint | undefined = checkpointCanonical ? recovery.view.checkpoint : undefined;
        if (!ancestor) for (const point of checkpoints.checkpoints) if (await this.canonical(point)) {ancestor = point; break;}
        requireOwner(ancestor, 'Stateful canonical ancestor is outside retained undo');
        this.purgeStale = true;
        await this.options.adapter.rollbackOwned(this.lease!, {declarationDigest: this.options.declaration.digest,
            revision: recovery.view.revision, operationId: hash(['hyperion-stateful-owner-fork-v2', this.options.declaration.digest,
                recovery.view.revision, recovery.view.checkpoint, ancestor]), from: recovery.view.checkpoint,
            ancestor, maxBlocks: this.options.maximumFramesPerDrain});
        this.lease = undefined; return true;
    }
    private async raw(recovery: StatefulOwnerRecoveryV2, target: PortableProjectionRawTarget): Promise<CapturedRawStatefulTargetV2> {
        if (recovery.raw) {
            const held = recovery.raw.target;
            requireOwner(same(held.target.block, target.block) && same(held.target.rawSource, target.reference), 'Retained raw source differs from current canonical input');
            // Preserve original owner/previous/reference custody across a cold owner takeover.
            this.admitting = true;
            await this.options.adapter.admitRaw(this.lease!, held); this.admitting = false; return held;
        }
        const captured = await captureStatefulRawTargetV2(this.options.declaration, {schemaVersion: 2,
            chainId: this.options.declaration.projection.definition.binding.chainId, declarationDigest: this.options.declaration.digest,
            owner: this.options.identity, previous: recovery.view, block: target.block, rawSource: target.reference});
        this.guard(); this.admitting = true;
        await this.options.adapter.admitRaw(this.lease!, captured); this.guard(); this.admitting = false; return captured;
    }
    private async step(): Promise<boolean> {
        const scope = currentProofConsumerScope(this.options.requireAttemptScope);
        let admitted: CapturedRawStatefulTargetV2 | undefined;
        let decodedDigest: string | undefined;
        try {
            let recovery = await this.recovery();
            if (!this.lease || !recovery || this.revision !== recovery.view.revision) recovery = await this.claim(recovery);
            requireOwner(recovery.owner && same(recovery.owner.identity, this.options.identity), 'Another native owner holds this projection');
            if (await this.recoverFork(recovery)) return true;
            if (this.purgeStale && this.retention) {
                // A rollback cleared raw and pending input, so every candidate above the surviving input belongs
                // to an undone branch. Its view names the old revision. If a fork switches back, the same block
                // returns with the same source digest, and must reduce again rather than reuse that candidate.
                await this.retention.purgeAbove(recovery.raw?.target.target.block.blockNum ?? recovery.view.checkpoint.blockNum);
                this.guard(); this.purgeStale = false;
            }
            const target = this.irreversible ? await this.options.source.irreversibleTarget() : await this.options.source.head();
            const height = recovery.raw?.target.target.block.blockNum ?? recovery.view.checkpoint.blockNum + 1;
            if (height > target.blockNum) {
                // A restarted source can report an older LIB. Durable input waits for it and is never failed.
                if (this.irreversible && (recovery.raw || recovery.pending || recovery.gap)) {this.reconciled = false; return false;}
                requireOwner(recovery.raw === null && recovery.pending === null && recovery.gap === null, 'Recovery exceeds current canonical source');
                this.reconciled = recovery.view.checkpoint.blockNum > 0; this.failed = false; return false;
            }
            const selected = await this.options.source.statefulBlock(height, this.options.declaration, async target => {
                admitted = await this.raw(recovery!, target);
            }, this.options.sourceMetadata);
            this.guard(); requireOwner(admitted, 'Original raw target was not durably admitted'); decodedDigest = selected.source.digest;
            if (this.irreversible) {
                // Eligibility was a height. The revalidation below then proves this exact block is still
                // canonical alongside the LIB, so it is an ancestor of that LIB and not a later replacement.
                const eligible = await this.options.source.irreversibleTarget(); this.guard();
                if (height > eligible.blockNum) {this.reconciled = false; return false;}
            }
            await this.options.source.revalidate(selected.proof); this.guard();
            const custody = this.retention?.block(selected.source.source.block.blockNum, recovery.pending?.sourceDigest ?? null)
                ?? this.options.custody;
            await executeStatefulOwnerBlockV2(this.options.declaration, this.options.adapter, this.lease!, admitted.digest,
                selected.source.source, custody, this.options.reduce, this.guard);
            await this.options.source.revalidate(selected.proof); this.guard();
            const receipt = await this.options.adapter.inspectOwned(this.lease!, admitted.digest, selected.source);
            requireOwner(receipt.status === 'committed' && receipt.sourceDigest === selected.source.digest && receipt.candidateDigest,
                'Applied source lacks its exact original candidate receipt');
            await this.options.adapter.retireRaw(this.lease!, admitted.digest, selected.source.digest, receipt.candidateDigest);
            await this.options.source.revalidate(selected.proof); this.guard();
            const settled = await this.recovery();
            this.reconciled = true; this.failed = false;
            await this.prune(settled); return true;
        } catch (error) {
            this.failed = true; this.reconciled = false;
            const assertFailureActive = () => {if (scope?.signal.aborted) throw error; this.guard();};
            assertFailureActive();
            // Unknown admission keeps this live gate closed. Cold takeover must inspect the durable slot.
            try {
                assertFailureActive(); const recovery = await this.recovery(); assertFailureActive();
                if (admitted && recovery?.raw?.target.digest === admitted.digest && recovery.gap === null) {
                    const reason = (error instanceof Error ? error.message : String(error)).toWellFormed();
                    const bounded = reason.length && Buffer.byteLength(reason) <= this.options.declaration.projection.limits.keyBytes ? reason : 'failed';
                    if (decodedDigest && recovery.raw.sourceDigest === decodedDigest)
                        await this.options.adapter.markSourceFailure(this.lease!, admitted.digest, decodedDigest, bounded);
                    else await this.options.adapter.markRawFailure(this.lease!, admitted.digest, bounded);
                    assertFailureActive();
                }
            } catch {assertFailureActive();} // Unknown marking keeps the gate closed; an original fence still propagates.
            assertFailureActive();
            try {this.options.onError?.(error);} catch {}
            return false;
        }
    }
    /**
     * Candidates are read only for input above the checkpoint: a pending apply, an unknown apply, a cold
     * takeover or an exact retry of the one raw target. Committed sources inspect as duplicates from their
     * receipts and never read custody. So a candidate below the floor is unreachable: reversible keeps
     * every block an exact-branch rollback can still undo, and irreversible effects never roll back.
     */
    private async prune(recovery: StatefulOwnerRecoveryV2 | null): Promise<void> {
        const custody = this.retention;
        if (!custody || !recovery || recovery.raw || recovery.pending || recovery.gap
            || (recovery.rollback && recovery.rollback.status !== 'complete')) return;
        const checkpoint = recovery.view.checkpoint.blockNum;
        const floor = this.irreversible ? checkpoint : Math.min(checkpoint, recovery.coverage?.floor?.blockNum ?? 0);
        if (floor < this.prunedFloor + this.pruneInterval) return;
        try {
            const result = await custody.pruneBelow(floor);
            if (result.complete) this.prunedFloor = floor;
        } catch (error) {
            try {this.options.onRetentionError?.(error);} catch {}
        }
    }
    drain(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        if (this.current) return this.current;
        const work = async () => {
            for (let n = 0; n < this.options.maximumFramesPerDrain && !this.stopped; n++) {
                const keepGoing = await this.options.run({projectionId: this.options.declaration.projection.definition.id,
                    declarationDigest: this.options.declaration.digest}, () => this.step());
                if (!keepGoing) break;
            }
        };
        this.current = work().finally(() => {this.current = undefined;}); return this.current;
    }
    /** Called only inside an actual master-routed request probe; this DTO alone grants no API authority. */
    async attest(expected: StatefulOwnerExpectation): Promise<void> {
        this.guard(); requireOwner(this.reconciled && !this.failed && !this.admitting, 'Stateful owner has unreconciled, unknown or failed input');
        const recovery = await this.recovery();
        requireOwner(recovery?.owner && expected.declarationDigest === this.options.declaration.digest
            && same(recovery.owner, expected.owner) && same(recovery.owner.identity, this.options.identity)
            && same(recovery.view, expected.view) && recovery.gap === null
            && (!recovery.rollback || recovery.rollback.status === 'complete'), 'Requested live owner/view is unavailable');
        if (this.irreversible) requireOwner(expected.view.checkpoint.blockNum <= (await this.options.source.irreversibleTarget()).blockNum,
            'Requested view exceeds the eligible finality target');
        const proof = await this.options.source.open(expected.view.checkpoint);
        if (recovery.raw) requireOwner(await this.canonical(recovery.raw.target.target.block), 'In-flight raw source is no longer canonical');
        await this.options.source.assertStatefulView(proof, this.options.declaration);
        const settled = await this.recovery(); this.guard();
        requireOwner(this.reconciled && !this.failed && !this.admitting && settled?.owner && same(settled.owner, expected.owner)
            && same(settled.view, expected.view) && settled.gap === null
            && (!settled.rollback || settled.rollback.status === 'complete'), 'Owner/view changed during request probe');
    }
    async attestDigest(digest: string): Promise<boolean> {
        // Dispatch hint only; a match still performs fresh native/source/lifetime checks below.
        if (!/^[0-9a-f]{64}$/.test(digest) || this.observedTarget !== digest) return false;
        this.guard();
        const recovery = await this.recovery();
        if (!recovery?.owner) return false;
        const expected = {declarationDigest: this.options.declaration.digest, owner: recovery.owner, view: recovery.view};
        if (statefulOwnerExpectationDigest(expected) !== digest) return false;
        await this.attest(expected); return true;
    }
    async stop(): Promise<void> {this.stopped = true; this.reconciled = false; await this.current;}
}
