/** Independent expectations over original physical rows and official clio receipts.
 * This file never consumes the recovery source mutation program or runtime output. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ReadConcern, type MongoClient} from 'mongodb';
import type {ProjectionBinding, ProjectionCheckpoint, ProjectionDefinition, ProjectionQueryResult} from '@eosrio/hyperion-sdk/projection';
import type {PortableWorkerPlan} from './portable-state-worker.ts';
import type {RecoveryBranch, RecoveryEngineeringSource} from './portable-state-recovery-source.ts';
type Row = ProjectionQueryResult['rows'][number];

export function recoveryUnaffectedDefinition(plan: PortableWorkerPlan): ProjectionDefinition {
    const original = plan.definitions.find(value => value.source.table === 'attseq'); assert.ok(original);
    const definition = {...structuredClone(original), id: 'qualification-unaffected-attestations',
        source: {...original.source, table: 'attestations'}, fields: [{name: 'id', path: ['id'], type: 'string' as const}]};
    return {...definition, mappingRevision: createHash('sha256').update(JSON.stringify({...definition,
        mappingRevision: 'p246-unaffected-attestations-v1'})).digest('hex')};
}

export function recoveryExpectedRows(plan: PortableWorkerPlan, branch: RecoveryBranch, height: number): Readonly<Record<string, readonly Row[]>> {
    assert.ok(Number.isSafeInteger(height) && height >= 1 && height <= (branch === 'A' ? 1247 : 1249));
    const attseq = plan.definitions.find(value => value.source.table === 'attseq');
    const envelopes = plan.definitions.find(value => value.source.table === 'outenvelopes');
    assert.ok(attseq && envelopes && plan.definitions.length === 2);
    const originalFirst = plan.barriers.find(value => value.through === 1244)!;
    const originalLast = plan.barriers.find(value => value.through === 1480)!;
    assert.ok(originalFirst && originalLast);
    if (height <= 1243) return {[attseq.id]: [], [envelopes.id]: []};
    // Fixed assertions specified independently of the generated deltas:
    // A: original insertion, counter replacement, envelope replacement.
    // B: opposite initial state, counter replacement, restoration of original IDs1/2.
    const firstCounter = branch === 'A' ? height === 1244 : height >= 1245;
    const firstEnvelopes = branch === 'A' ? height < 1246 : height >= 1246;
    return structuredClone({[attseq.id]: (firstCounter ? originalFirst : originalLast).rows[attseq.id],
        [envelopes.id]: (firstEnvelopes ? originalFirst : originalLast).rows[envelopes.id]});
}

export function assertRecoveryHttp(result: any, headers: Headers, binding: ProjectionBinding,
    checkpoint: ProjectionCheckpoint, rows: readonly Row[], finality: 'reversible' | 'irreversible') {
    assert.deepEqual(result.view.binding, {...binding}); assert.deepEqual(result.view.checkpoint, checkpoint);
    assert.match(result.view.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.rows, rows); assert.deepEqual(result.count, {value: rows.length, exact: true});
    assert.equal(result.nextAfterKey, undefined);
    assert.equal(headers.get('hyperion-state-block-num'), String(checkpoint.blockNum));
    assert.equal(headers.get('hyperion-state-block-id'), checkpoint.blockId);
    assert.equal(headers.get('hyperion-state-last-valid'), 'false'); assert.equal(headers.get('hyperion-state-finality'), finality);
    assert.equal(headers.get('cache-control'), 'no-store');
}

export function assertRecoveryUnavailable(response: {status: number; headers: Headers; body: any}) {
    assert.equal(response.status, 503); assert.equal(response.body.retryable, true);
    assert.equal(response.headers.get('retry-after'), '1'); assert.equal(response.headers.get('cache-control'), 'no-store');
    for (const name of ['hyperion-state-block-num', 'hyperion-state-block-id', 'hyperion-state-last-valid', 'hyperion-state-finality'])
        assert.equal(response.headers.get(name), null);
    assert.equal(response.body.view, undefined); assert.equal(response.body.rows, undefined);
}

/** A canonical block label is insufficient: every probe must also prove its actual row image. */
export function assertRecoveryProbe(result: any, headers: Headers, binding: ProjectionBinding, finality: 'reversible' | 'irreversible',
    source: Pick<RecoveryEngineeringSource, 'records'>, plan: PortableWorkerPlan, afterFork: boolean) {
    const checkpoint = result?.view?.checkpoint;
    assert.ok(checkpoint && Number.isSafeInteger(checkpoint.blockNum) && checkpoint.blockNum >= 1);
    const matching = source.records.filter(record => record.blockNum === checkpoint.blockNum && record.blockId === checkpoint.blockId);
    assert.ok(matching.length > 0, 'Probe returned an unknown served checkpoint');
    let branch: RecoveryBranch;
    if (afterFork) {
        assert.ok(matching.some(record => record.branch === 'common' || record.branch === 'B'), 'Probe served an orphan A checkpoint after fork authority changed');
        branch = 'B';
    } else branch = matching.some(record => record.branch === 'common' || record.branch === 'A') ? 'A' : 'B';
    const expected = binding.projectionId === recoveryUnaffectedDefinition(plan).id ? [] : recoveryExpectedRows(plan, branch, checkpoint.blockNum)[binding.projectionId];
    assert.ok(expected, 'Probe belongs to an undeclared projection');
    assertRecoveryHttp(result, headers, binding, checkpoint, expected, finality);
}

/** Physical layout is inspected independently of adapter methods. Bindings are flat SDK records. */
const flatHash = (value: Record<string, unknown>) => createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))).digest('hex');
export const recoveryMetadataId = (binding: ProjectionBinding) => flatHash({chainId: binding.chainId, projectionId: binding.projectionId});
export async function inspectRecoveryPhysical(client: MongoClient, database: string, binding: ProjectionBinding) {
    assert.match(database, /^h45_p191_[0-9a-f]{12}$/);
    const db = client.db(database, {readPreference: 'primary', readConcern: new ReadConcern('majority')});
    const metadata = await db.collection('h45_projection_metadata').findOne({_id: recoveryMetadataId(binding)} as any);
    assert.ok(metadata); assert.deepEqual(metadata.binding, {...binding});
    const collection = 'h45_projection_r_' + flatHash({...binding});
    const physical = await db.collection(collection).find({}).sort({_id: 1}).limit(257).toArray();
    assert.ok(physical.length <= 256);
    return {metadata, collection, rows: physical.map(value => ({key: value._id, value: value.value}))};
}
export function assertRecoveryPhysical(value: Awaited<ReturnType<typeof inspectRecoveryPhysical>>,
    checkpoint: ProjectionCheckpoint, rows: readonly Row[]) {
    assert.deepEqual(value.rows, rows);
    assert.equal(value.metadata.initialized, true); assert.equal(value.metadata.pending, null); assert.equal(value.metadata.gap, null);
    assert.equal(value.metadata.checkpoint.blockNum, checkpoint.blockNum); assert.equal(value.metadata.checkpoint.blockId, checkpoint.blockId);
    assert.equal(value.metadata.checkpoint.revision, value.metadata.revision); assert.match(value.metadata.revision, /^[0-9a-f]{64}$/);
    assert.ok(value.metadata.rollback === null || value.metadata.rollback.status === 'complete');
}
