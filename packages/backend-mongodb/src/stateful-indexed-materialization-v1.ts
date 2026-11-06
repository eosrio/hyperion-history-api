import type {ClientSession, Collection, Document} from 'mongodb';
import type {StatefulKey, StatefulView} from '@eosrio/hyperion-sdk/projection-stateful';
import {bsonBytes} from './rollback-contract.js';
import {equalPoint, fields, sha, type StatefulImage} from './stateful-contract.js';
import type {StatefulNativeSidecarsV1} from './stateful-effects.js';
import {encodeMongoIndexedRowsV1, indexedRowIdV1, STATEFUL_INDEXED_REPRESENTATION_V1,
    type MongoIndexedModelV1, type MongoIndexedRowV1} from './stateful-indexed-model-v1.js';

export interface MongoIndexedCoverageV1 {
    readonly _id: string; readonly representation: typeof STATEFUL_INDEXED_REPRESENTATION_V1;
    readonly owner: string; readonly model: string; readonly generation: string; readonly revision: string;
    readonly checkpoint: StatefulView['checkpoint']; readonly ready: boolean; readonly reason: string | null;
}
export interface CoverageImageV1 {readonly _id: string; readonly blockId: string; readonly before: MongoIndexedCoverageV1 | null}
export interface MongoIndexedMaterializationV1 {
    readonly model: MongoIndexedModelV1; readonly rows: Collection<MongoIndexedRowV1>;
    readonly coverage: Collection<MongoIndexedCoverageV1>; readonly images: Collection<CoverageImageV1>;
}
type NativeCall = <T>(work: () => Promise<T>) => Promise<T>;
const coverageFields = ['_id','representation','owner','model','generation','revision','checkpoint','ready','reason'];
export function indexedCoverageV1(entry: MongoIndexedMaterializationV1, view: StatefulView, ready: boolean, reason: string | null): MongoIndexedCoverageV1 {
    return {_id: entry.model.declaration.digest, representation: STATEFUL_INDEXED_REPRESENTATION_V1,
        owner: entry.model.owner.digest, model: entry.model.declaration.digest, generation: view.generation,
        revision: view.revision, checkpoint: {...view.checkpoint}, ready, reason};
}
/** Coverage is adapter-owned evidence, never a grant. The real owner snapshot must still match. */
export function matchingIndexedCoverageV1(entry: MongoIndexedMaterializationV1, view: StatefulView, raw: unknown,
    revision = true): raw is MongoIndexedCoverageV1 {
    try {
        fields(raw, coverageFields); fields(raw.checkpoint, ['blockNum','blockId']);
        return raw._id === entry.model.declaration.digest && raw.model === raw._id && raw.owner === entry.model.owner.digest
            && raw.representation === STATEFUL_INDEXED_REPRESENTATION_V1 && raw.generation === view.generation
            && (!revision || raw.revision === view.revision) && raw.checkpoint.blockNum === view.checkpoint.blockNum && raw.checkpoint.blockId === view.checkpoint.blockId
            && typeof raw.ready === 'boolean' && (raw.ready ? raw.reason === null : typeof raw.reason === 'string');
    } catch {return false;}
}
/** Finite writes only. No canonical kind scan or on-read reconstruction exists here. */
export function createMongoIndexedSidecarsV1(entries: readonly MongoIndexedMaterializationV1[], maxBlockBytes: number): StatefulNativeSidecarsV1 {
    const replacements = (entry: MongoIndexedMaterializationV1, changes: readonly {target: StatefulKey; value: unknown | null}[]) => {
        const m = entry.model.declaration.model, aliases = [m.base, ...m.joins];
        const ids = changes.flatMap(change => aliases.filter(alias => alias.kind === change.target.kind)
            .map(alias => indexedRowIdV1(entry.model.declaration.digest, alias.alias, change.target.key)));
        const rows = changes.flatMap(change => change.value === null ? [] : [...encodeMongoIndexedRowsV1(entry.model, change.target, change.value)]);
        if (ids.length * 80 + rows.reduce((sum, row) => sum + bsonBytes(row), 0) > maxBlockBytes) throw new Error('model block materialization bound');
        const unique = new Set<string>();
        for (const row of rows) if (row.alias !== m.base.alias) {
            const key = JSON.stringify([row.alias, row.joins[row.alias]]); if (unique.has(key)) throw new Error('joined cardinality'); unique.add(key);
        }
        return {ids, rows};
    };
    const write = async (entry: MongoIndexedMaterializationV1, planned: ReturnType<typeof replacements>, session: ClientSession, call: NativeCall) => {
        // Check cardinality before any write. A duplicate-key transaction abort must never
        // turn a model's logical unavailability into a failed canonical commit.
        for (const row of planned.rows) if (row.alias !== entry.model.declaration.model.base.alias) {
            const duplicate = await call(() => entry.rows.findOne({alias: row.alias, ['joins.' + row.alias]: row.joins[row.alias],
                _id: {$nin: planned.ids}}, {session, projection: {_id: 1},hint:'h45_ix_j_'+sha(row.alias).slice(0,20)}));
            if (duplicate) return false;
        }
        for (const id of planned.ids) await call(() => entry.rows.deleteOne({_id: id}, {session}));
        for (const row of planned.rows) await call(() => entry.rows.insertOne(row, {session}));
        return true;
    };
    const save = (entry: MongoIndexedMaterializationV1, view: StatefulView, ready: boolean, reason: string | null, session: ClientSession, call: NativeCall) =>
        call(() => entry.coverage.replaceOne({_id: entry.model.declaration.digest}, indexedCoverageV1(entry, view, ready, reason), {session, upsert: true}));
    return Object.freeze({
        async apply(candidate, before, after, session, call) {
            for (const entry of entries) {
                const previous = await call(() => entry.coverage.findOne({_id: entry.model.declaration.digest}, {session}));
                const valid = matchingIndexedCoverageV1(entry, before, previous), ready = valid && previous.ready;
                await call(() => entry.images.insertOne({_id: sha(candidate.source.source.block.blockId), blockId: candidate.source.source.block.blockId,
                    before: valid ? previous : null}, {session}));
                if (!ready) {await save(entry, after, false, 'materialization-not-covered', session, call); continue;}
                // Collapse repeated mutations to their final value without changing canonical mutation order.
                const final = new Map<string, {target: StatefulKey; value: unknown | null}>();
                for (const mutation of candidate.mutations) final.set(JSON.stringify(mutation.target), {target: mutation.target,
                    value: mutation.kind === 'put' ? mutation.value : null});
                let planned: ReturnType<typeof replacements>;
                try {planned = replacements(entry, [...final.values()]);}
                catch {await save(entry, after, false, 'model-values-unavailable', session, call); continue;}
                const written = await write(entry, planned, session, call);
                await save(entry, after, written, written ? null : 'joined-cardinality-unavailable', session, call);
            }
        },
        async rollback(images: readonly StatefulImage[], blockId, _before, after, session, call) {
            for (const entry of entries) {
                const history = await call(() => entry.images.findOne({_id: sha(blockId)}, {session}));
                let ready = false;
                if (history?.blockId === blockId && matchingIndexedCoverageV1(entry, after, history.before, false) && history.before.ready) {
                    let planned: ReturnType<typeof replacements> | undefined;
                    try {planned = replacements(entry, images.map(image => ({target: image.target,
                        value: image.before === null ? null : JSON.parse(image.before)})));} catch { /* per-model refusal */ }
                    if (planned) ready = await write(entry, planned, session, call);
                }
                await save(entry, after, ready, ready ? null : 'rollback-materialization-not-covered', session, call);
                await call(() => entry.images.deleteOne({_id: sha(blockId)}, {session}));
            }
        },
        async prune(blockId, session, call) {for (const entry of entries) await call(() => entry.images.deleteOne({_id: sha(blockId)}, {session}));}
    } satisfies StatefulNativeSidecarsV1);
}
