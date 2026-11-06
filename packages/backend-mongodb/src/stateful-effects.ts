import type {StatefulDeclaration, StatefulKey, StatefulMutation, StatefulObservation, StatefulRollback, StatefulView} from '@eosrio/hyperion-sdk/projection-stateful';
import type {ProjectionBlock, ProjectionCheckpoint, ProjectionRollbackState} from '@eosrio/hyperion-sdk/projection';
import type {ClientSession, Collection} from 'mongodb';
import {bsonBytes, retainedBytes} from './rollback-contract.js';
import {blockOf, checkedImages, decodeRow, equalPoint, keyId, requireState, rowOf, sha,
    type StatefulImage, type StatefulPolicy, type StatefulReceipt, type StatefulRow, type StatefulUndo} from './stateful-contract.js';

/** Private shared native effect/undo algorithm. Family-specific ownership and metadata are real policies. */
export interface StatefulNativeProgress {
    readonly checkpoint: ProjectionCheckpoint; readonly revision: string;
    readonly pending: {readonly sourceDigest: string; readonly candidateDigest: string; readonly block: ProjectionCheckpoint} | null;
    readonly receipts: readonly StatefulReceipt[]; readonly undo: readonly StatefulUndo[];
    readonly floor: ProjectionCheckpoint; readonly floorReceipt: StatefulReceipt | null; readonly rollback: ProjectionRollbackState | null;
}
export interface StatefulNativeCandidate {
    readonly source: {readonly source: {readonly block: ProjectionBlock}; readonly digest: string};
    readonly digest: string; readonly view: StatefulView;
    readonly observations: readonly StatefulObservation[]; readonly mutations: readonly StatefulMutation[];
}
/** Backend-private sidecars share the canonical transaction and its existing guard; never a plugin port. */
export interface StatefulNativeSidecarsV1 {
    apply(candidate: StatefulNativeCandidate, before: StatefulView, after: StatefulView, session: ClientSession,
        call: <T>(work: () => Promise<T>) => Promise<T>): Promise<void>;
    rollback(images: readonly StatefulImage[], blockId: string, before: StatefulView, after: StatefulView, session: ClientSession,
        call: <T>(work: () => Promise<T>) => Promise<T>): Promise<void>;
    prune(blockId: string, session: ClientSession, call: <T>(work: () => Promise<T>) => Promise<T>): Promise<void>;
}
export interface StatefulEffects<M extends StatefulNativeProgress> {
    readonly declaration: StatefulDeclaration; readonly policy: StatefulPolicy;
    readonly rows: Collection<StatefulRow>; readonly images: Collection<StatefulImage>;
    readonly sidecars?: StatefulNativeSidecarsV1;
    /** V2 checks its actual owner/canonical guard around every native await; v1 retains its existing semantics. */
    call<T>(work: () => Promise<T>): Promise<T>;
    load(session: ClientSession): Promise<M>;
    save(before: M, changes: Partial<StatefulNativeProgress>, session: ClientSession): Promise<M>;
    transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T>;
    assertApply(m: M, candidate: StatefulNativeCandidate): void;
    assertView(m: M, candidate: StatefulNativeCandidate): void;
    replay(m: M, candidate: StatefulNativeCandidate): boolean;
    duplicate(m: M): void;
    view(m: M): StatefulView;
}

export async function commitStatefulCandidate<M extends StatefulNativeProgress>(io: StatefulEffects<M>, candidate: StatefulNativeCandidate,
    pending: NonNullable<StatefulNativeProgress['pending']>) {
    const d = io.declaration, source = candidate.source, block = blockOf(source.source.block);
    return io.transaction(async session => {
        const m = await io.load(session); io.assertApply(m, candidate);
        if (io.replay(m, candidate)) {io.duplicate(m); return {status: 'duplicate' as const, progress: io.view(m)};}
        io.assertView(m, candidate);
        requireState(JSON.stringify(m.pending) === JSON.stringify(pending), 'Original durable intent differs', 'stateful.replay-conflict');
        for (const observation of candidate.observations) {
            const raw = await io.call(() => io.rows.findOne({_id: keyId(observation.key)}, {session}));
            if (raw !== null) decodeRow(d, observation.key, raw);
            requireState(observation.result.status === 'covered-absent' ? raw === null : raw !== null &&
                raw.json === rowOf(d, observation.key, observation.result.value).json, 'Observed base record differs', 'stateful.stale-view');
        }
        const images = new Map<string, StatefulImage>(); let imageBytes = 0;
        for (const mutation of candidate.mutations) if (!images.has(keyId(mutation.target))) {
            const raw = await io.call(() => io.rows.findOne({_id: keyId(mutation.target)}, {session}));
            if (raw !== null) decodeRow(d, mutation.target, raw);
            const image: StatefulImage = {_id: sha(block.blockId + keyId(mutation.target)), blockId: block.blockId, target: mutation.target, before: raw?.json ?? null};
            imageBytes += bsonBytes(image); requireState(imageBytes <= io.policy.maxBlockBytes, 'Before-image byte bound', 'stateful.apply-unavailable'); images.set(keyId(mutation.target), image);
        }
        const ordered = [...images.values()].sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
        const undo: StatefulUndo = {block, digest: candidate.digest, sourceDigest: source.digest, count: ordered.length, imageBytes, imagesHash: sha(JSON.stringify(ordered))};
        requireState(retainedBytes([undo]) <= io.policy.maxBlockBytes, 'Undo descriptor byte bound', 'stateful.apply-unavailable'); checkedImages(d, undo, ordered);
        for (const image of ordered) await io.call(() => io.images.insertOne(image, {session}));
        for (const mutation of candidate.mutations) {
            if (mutation.kind === 'put') await io.call(() => io.rows.replaceOne({_id: keyId(mutation.target)}, rowOf(d, mutation.target, mutation.value), {session, upsert: true}));
            else await io.call(() => io.rows.deleteOne({_id: keyId(mutation.target)}, {session}));
        }
        const checkpoint = {blockNum: block.blockNum, blockId: block.blockId};
        if (io.sidecars) await io.call(() => io.sidecars!.apply(candidate, io.view(m), {...io.view(m), checkpoint}, session, work => io.call(work)));
        const retained = [...m.undo, undo]; let floor = m.floor, floorReceipt = m.floorReceipt;
        while (retained.length > io.policy.maxBlocks || retainedBytes(retained) > io.policy.maxBytes) {
            const removed = retained.shift()!; await io.call(() => io.images.deleteMany({blockId: removed.block.blockId}, {session}));
            if (io.sidecars) await io.call(() => io.sidecars!.prune(removed.block.blockId, session, work => io.call(work)));
            floor = {blockNum: removed.block.blockNum, blockId: removed.block.blockId}; floorReceipt = {...floor, sourceDigest: removed.sourceDigest, candidateDigest: removed.digest};
        }
        const receipts = [...m.receipts, {...checkpoint, sourceDigest: source.digest, candidateDigest: candidate.digest}].slice(-io.policy.receiptRetention);
        const next = await io.save(m, {checkpoint, receipts, pending: null, undo: retained, floor, floorReceipt}, session);
        return {status: 'applied' as const, progress: io.view(next)};
    });
}

/** One bounded original undo step, used by both metadata families without translating recovery labels. */
export async function rollbackStatefulStep<M extends StatefulNativeProgress>(io: StatefulEffects<M>, request: StatefulRollback): Promise<M> {
    const d = io.declaration;
    return io.transaction(async session => {
        const current = await io.load(session), operation = current.rollback;
        requireState(operation?.operationId === request.operationId && operation.sourceRevision === request.revision &&
            equalPoint(operation.from, request.from) && equalPoint(operation.ancestor, request.ancestor), 'Another rollback owns progress', 'stateful.stale-view');
        if (operation.status !== 'running') return current;
        let checkpoint = current.checkpoint, undo = [...current.undo], receipts = [...current.receipts];
        if (!equalPoint(checkpoint, operation.ancestor)) {
            const u = undo.pop(); requireState(u && equalPoint(u.block, checkpoint), 'Missing original undo descriptor');
            const raw = await io.call(() => io.images.find({blockId: u.block.blockId}, {session}).sort({_id: 1}).limit(u.count + 1).toArray());
            const checked = checkedImages(d, u, raw);
            for (const image of checked) {
                if (image.before === null) await io.call(() => io.rows.deleteOne({_id: keyId(image.target)}, {session}));
                else await io.call(() => io.rows.replaceOne({_id: keyId(image.target)}, rowOf(d, image.target, JSON.parse(image.before!)), {session, upsert: true}));
            }
            const restored = {blockNum: u.block.blockNum - 1, blockId: u.block.previousBlockId};
            if (io.sidecars) await io.call(() => io.sidecars!.rollback(checked, u.block.blockId, io.view(current),
                {...io.view(current), checkpoint: restored}, session, work => io.call(work)));
            await io.call(() => io.images.deleteMany({blockId: u.block.blockId}, {session}));
            checkpoint = restored; receipts = receipts.filter(r => r.blockNum <= checkpoint.blockNum);
            if (checkpoint.blockNum > 0 && !receipts.some(r => equalPoint(r, checkpoint))) {
                const last = undo.at(-1), receipt = last ? {...checkpoint, sourceDigest: last.sourceDigest, candidateDigest: last.digest} : current.floorReceipt;
                requireState(receipt && equalPoint(receipt, checkpoint), 'Missing predecessor replay receipt'); receipts.push(receipt);
            }
        }
        return io.save(current, {checkpoint, undo, receipts, rollback: {...operation, status: equalPoint(checkpoint, operation.ancestor) ? 'complete' : 'running'}}, session);
    });
}
