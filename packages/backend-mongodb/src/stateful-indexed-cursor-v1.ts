import {Long, type Document} from 'mongodb';
import type {StatefulView} from '@eosrio/hyperion-sdk/projection-stateful';
import {captureIndexedResultV1, type IndexedLimitsV1, type IndexedResultV1} from '@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1';
import {fields, requireState} from './stateful-contract.js';
import {decodeMongoIndexedRowV1, indexedFieldResultV1, type MongoIndexedModelV1, type MongoIndexedPlanV1} from './stateful-indexed-model-v1.js';

/** Backend-private cursor interpreter; the command callback retains the actual read/session and total attempts. */
export async function readMongoIndexedCursorV1(model: MongoIndexedModelV1, plan: MongoIndexedPlanV1,
    options: {database: string; collection: string; view: StatefulView; available: IndexedLimitsV1;
        operationTimeoutMS: number; attempts(): number; command(value: Document): Promise<Document>;
        cleanup(cursor: Long): Promise<void>}) {
    const request = plan.request, m = model.declaration.model;
    const rows: Extract<IndexedResultV1, {kind:'page'}>['rows'][number][] = [], seen = new Set<string>();
    let count: string | undefined, cursorId = Long.ZERO, failed = false;
    const result = (): IndexedResultV1 => request.kind === 'count' ? {kind:'count', exact:true, value: count ?? '0'} : {kind:'page', complete:true, rows};
    const envelope = () => ({view: options.view, queryDeclarationDigest: model.declaration.digest, result: result(), attempts: options.attempts()});
    try {
        let answer = await options.command({aggregate: options.collection, pipeline: plan.pipeline, hint: plan.hint,
            collation: {locale:'simple'}, allowDiskUse: false, cursor: {batchSize:1}, maxTimeMS: options.operationTimeoutMS});
        let batch = 'firstBatch';
        for (;;) {
            const cursor = answer.cursor;
            // Capture the cleanup identity before decoding any result or checking a post-await guard.
            if (Long.isLong(cursor?.id)) cursorId = cursor.id;
            requireState(cursor && Long.isLong(cursor.id) && cursor.ns === options.database + '.' + options.collection
                && Array.isArray(cursor[batch]) && cursor[batch].length <= 1, 'Malformed native indexed cursor', 'stateful.unavailable');
            for (const raw of cursor[batch]) {
                if (request.kind === 'count') {
                    fields(raw, ['_id','value','invalid']);
                    requireState(count === undefined && raw._id === null && Long.isLong(raw.value) && !raw.value.isNegative()
                        && Long.isLong(raw.invalid) && raw.invalid.isZero(), 'Native exact count/cardinality differs', 'stateful.unavailable');
                    requireState(options.available.responseRecords >= 1, 'Indexed count row allowance exceeded', 'stateful.unavailable');
                    count = raw.value.toString();
                } else {
                    requireState(rows.length < request.limit && rows.length < options.available.responseRecords,
                        'Indexed native page row overflow', 'stateful.unavailable');
                    fields(raw, ['base','joined']); fields(raw.joined, m.joins.map(join => join.alias));
                    const base = decodeMongoIndexedRowV1(model, m.base.alias, raw.base);
                    requireState(!seen.has(base.row.key), 'Duplicate indexed base row', 'stateful.unavailable'); seen.add(base.row.key);
                    const captured = new Map([[m.base.alias, base]]);
                    for (const join of m.joins) {
                        const values = raw.joined[join.alias];
                        requireState(Array.isArray(values) && values.length <= 1 && (join.mode !== 'inner-one' || values.length === 1),
                            'Indexed join is not qualified one-to-one', 'stateful.unavailable');
                        if (values.length) {
                            const value = decodeMongoIndexedRowV1(model, join.alias, values[0]);
                            requireState(base.row.joins[join.alias] === value.row.joins[join.alias], 'Indexed join equality differs', 'stateful.unavailable');
                            captured.set(join.alias, value);
                        }
                    }
                    const selected = Object.fromEntries(request.select.map(id => {const field = m.fields.find(field => field.id === id)!;
                        return [id, captured.has(field.alias) ? indexedFieldResultV1(captured.get(field.alias)!.row.v[id]!) : null];}));
                    const records = Object.fromEntries(request.records.map(alias => [alias, captured.get(alias)?.value ?? null]));
                    rows.push({key: base.row.key, fields: selected, records});
                }
                requireState(Buffer.byteLength(JSON.stringify(envelope())) <= options.available.responseBytes,
                    'Indexed successful response envelope byte allowance exceeded', 'stateful.unavailable');
            }
            if (cursor.id.isZero()) break;
            const previous = cursor.id; answer = await options.command({getMore: previous, collection: options.collection, batchSize:1}); batch = 'nextBatch';
            if (Long.isLong(answer.cursor?.id)) cursorId = answer.cursor.id;
            requireState(Long.isLong(answer.cursor?.id) && (answer.cursor.id.isZero() || answer.cursor.id.equals(previous)),
                'Native indexed cursor identity changed', 'stateful.unavailable');
        }
        const captured = captureIndexedResultV1(model.selection, request, result());
        const value = {...envelope(), result: captured};
        requireState(Buffer.byteLength(JSON.stringify(value)) <= options.available.responseBytes,
            'Indexed successful response envelope byte allowance exceeded', 'stateful.unavailable'); return value;
    } catch (error) {failed = true; throw error;}
    finally {if (!cursorId.isZero()) {try {await options.cleanup(cursorId);} catch (error) {if (!failed) throw error;}}}
}
