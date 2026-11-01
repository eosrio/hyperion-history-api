import {Long, type Document} from 'mongodb';
import {canonicalStatefulRecord, type StatefulKey, type StatefulRecord} from '@eosrio/hyperion-sdk/projection-stateful';
import {captureIndexedDeclarationV1, captureIndexedRequestV1, negotiateIndexedQueryV1, STATEFUL_INDEXED_QUERY_FAMILY_V1,
    type IndexedDeclarationV1, type IndexedLimitsV1, type IndexedOfferV1, type IndexedRequestV1, type IndexedSelectionV1}
    from '@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1';
import type {StatefulOwnerDeclarationV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {bsonBytes} from './rollback-contract.js';
import {fields, logicalKey, MAX_BSON_BYTES, requireState, sha} from './stateful-contract.js';

export const STATEFUL_INDEXED_REPRESENTATION_V1 = 'h45-owner-indexed-materialization-v1' as const;
/** Native semantics only. This name does not assert PostgreSQL/Atomic collation equivalence. */
export const MONGO_SIMPLE_INDEXED_COMPARISON_V1 = 'mongodb-simple-utf8-v1' as const;
type FieldValue = string | Long | readonly string[] | null;
export interface MongoIndexedRowV1 {
    readonly _id: string; readonly model: string; readonly representation: typeof STATEFUL_INDEXED_REPRESENTATION_V1;
    readonly alias: string; readonly kind: string; readonly key: string; readonly json: string;
    readonly v: Readonly<Record<string, FieldValue>>; readonly n: Readonly<Record<string, number>>;
    readonly joins: Readonly<Record<string, string>>;
}
export interface MongoIndexedModelV1 {
    readonly owner: StatefulOwnerDeclarationV2; readonly declaration: IndexedDeclarationV1;
    readonly selection: IndexedSelectionV1; readonly limits: IndexedLimitsV1;
}
export interface MongoIndexedIndexV1 {readonly name: string; readonly key: Document; readonly unique: boolean; readonly partial?: Document}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function issue(message: string): never {throw new Error('Indexed materialization: ' + message);}
function stored(record: StatefulRecord, path: readonly string[]): unknown {
    let value: unknown = record;
    for (const part of path) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, part)) issue('required stored field is missing');
        value = (value as Record<string, unknown>)[part];
    }
    return value;
}
function typed(input: unknown, field: IndexedDeclarationV1['model']['fields'][number]): FieldValue {
    if (input === null) {if (!field.nullable) issue('nonnullable stored field is null'); return null;}
    if (field.type === 'text-vector') {
        if (!Array.isArray(input) || input.some(value => typeof value !== 'string')) issue('stored text-vector type differs');
        return Object.freeze([...input]);
    }
    if (typeof input !== 'string') issue('stored scalar type differs');
    if (field.type === 'text') return input;
    if (input.length > 20 || !/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(input)) issue('noncanonical signed integer');
    const value = Long.fromString(input); if (value.toString() !== input) issue('signed integer range'); return value;
}
export const indexedRowIdV1 = (digest: string, alias: string, key: string) => sha(JSON.stringify([digest, alias, key]));
/** Local recapture validates both declaration bytes and owner digest; a received DTO never transfers a WeakSet grant. */
export async function receiveMongoIndexedModelV1(owner: StatefulOwnerDeclarationV2, input: IndexedDeclarationV1,
    limits: IndexedLimitsV1): Promise<MongoIndexedModelV1> {
    fields(input, ['family','interfaceVersion','ownerDeclarationDigest','modelRevision','model','digest']);
    const declaration = await captureIndexedDeclarationV1(owner, input.modelRevision, input.model);
    requireState(declaration.digest === input.digest && declaration.ownerDeclarationDigest === input.ownerDeclarationDigest,
        'Indexed declaration or owner digest differs', 'stateful.capability-unavailable');
    const offer: IndexedOfferV1 = {family: STATEFUL_INDEXED_QUERY_FAMILY_V1, interfaceVersion: 1,
        queryDeclarationDigests: [declaration.digest], comparisonProfiles: [declaration.model.textComparison], limits};
    // Private syntax capture only. Actual offers/readiness/profile qualification are separately native-validated.
    const selection = negotiateIndexedQueryV1(declaration, limits, offer, offer);
    return Object.freeze({owner, declaration, selection, limits: selection.limits});
}
/** A deliberately finite first planner. Unsupported joins in predicates/order refuse before native data I/O. */
export function assertMongoIndexedTracerModelV1(model: MongoIndexedModelV1): void {
    const m = model.declaration.model;
    const supported = (field: typeof m.fields[number], op: string) => field.alias === m.base.alias && !field.nullable
        && (field.type === 'text' ? ['eq','in','not-in'].includes(op) : field.type === 'int64' && ['eq','gte','gt','lt'].includes(op));
    requireState(m.fields.every(field => field.operators.every(op => supported(field, op))),
        'This indexed tracer does not implement a declared predicate', 'stateful.capability-unavailable');
    requireState(m.orders.every(order => order.every(term => m.fields.find(field => field.id === term.field)?.alias === m.base.alias)),
        'This indexed tracer requires a base-field indexed order', 'stateful.capability-unavailable');
    requireState(m.fields.some(field => field.alias === m.base.alias && field.type === 'text' && !field.nullable && field.operators.includes('eq')),
        'Indexed tracer requires a text equality access path', 'stateful.capability-unavailable');
    requireState(m.joins.length + 1 <= Math.floor((MAX_BSON_BYTES - 4096) / (model.owner.projection.limits.value.recordBytes + 1024)),
        'Joined native BSON envelope is not covered', 'stateful.capability-unavailable');
}
/** Canonical JSON stays unchanged; typed values and equality keys are a deterministic private sidecar. */
export function encodeMongoIndexedRowsV1(model: MongoIndexedModelV1, targetInput: StatefulKey, input: unknown): readonly MongoIndexedRowV1[] {
    const target = logicalKey(model.owner.projection, targetInput), m = model.declaration.model;
    const canonical = canonicalStatefulRecord(model.owner.projection, target.kind, input);
    const aliases = [m.base, ...m.joins].filter(alias => alias.kind === target.kind);
    return Object.freeze(aliases.map(source => {
        const selected = m.fields.filter(field => field.alias === source.alias), v: Record<string, FieldValue> = Object.create(null),
            n: Record<string, number> = Object.create(null), joins: Record<string, string> = Object.create(null);
        for (const field of selected) {const value = typed(stored(canonical.value, field.path), field); v[field.id] = value; n[field.id] = value === null ? 1 : 0;}
        for (const join of m.joins) {
            const path = source.alias === m.base.alias ? 'basePath' : source.alias === join.alias ? 'joinedPath' : undefined;
            if (path) joins[join.alias] = JSON.stringify(join.on.map(pair => {const atom = stored(canonical.value,pair[path]);
                if (typeof atom !== 'string') issue('joined equality path must be stored text'); return atom;}));
        }
        const row: MongoIndexedRowV1 = {_id: indexedRowIdV1(model.declaration.digest, source.alias, target.key),
            model: model.declaration.digest, representation: STATEFUL_INDEXED_REPRESENTATION_V1,
            alias: source.alias, kind: target.kind, key: target.key, json: canonical.canonical,
            v: Object.freeze(v), n: Object.freeze(n), joins: Object.freeze(joins)};
        requireState(bsonBytes(row) <= MAX_BSON_BYTES, 'Indexed sidecar BSON bound', 'stateful.unavailable'); return Object.freeze(row);
    }));
}
function orderedNative(input: unknown): unknown {
    if (Long.isLong(input)) return {nativeInt64: input.toString()};
    if (Array.isArray(input)) return input.map(orderedNative);
    return input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key =>
        [key, orderedNative((input as Record<string, unknown>)[key])])) : input;
}
export function decodeMongoIndexedRowV1(model: MongoIndexedModelV1, alias: string, input: unknown): {readonly row: MongoIndexedRowV1; readonly value: StatefulRecord} {
    fields(input, ['_id','model','representation','alias','kind','key','json','v','n','joins']);
    requireState(input.alias === alias && typeof input.json === 'string', 'Indexed native alias/JSON differs', 'stateful.unavailable');
    const target = logicalKey(model.owner.projection, {kind: input.kind, key: input.key});
    const canonical = canonicalStatefulRecord(model.owner.projection, target.kind, JSON.parse(input.json));
    const expected = encodeMongoIndexedRowsV1(model, target, canonical.value).find(row => row.alias === alias);
    requireState(expected && canonical.canonical === input.json && same(orderedNative(expected), orderedNative(input)),
        'Indexed typed representation differs from canonical JSON', 'stateful.unavailable');
    return Object.freeze({row: expected, value: canonical.value});
}
function orderKey(anchor: string, order: IndexedDeclarationV1['model']['orders'][number]): Document {
    const key: Document = {alias: 1, ['v.' + anchor]: 1};
    for (const term of order) if (term.field !== anchor) {key['n.' + term.field] = 1; key['v.' + term.field] = term.direction === 'asc' ? 1 : -1;}
    return key;
}
export function mongoIndexedIndexesV1(model: MongoIndexedModelV1): readonly MongoIndexedIndexV1[] {
    assertMongoIndexedTracerModelV1(model); const m = model.declaration.model, indexes: MongoIndexedIndexV1[] = [];
    for (const field of m.fields.filter(field => field.alias === m.base.alias && field.type === 'text' && !field.nullable && field.operators.includes('eq')))
        for (const order of m.orders) indexes.push({name: 'h45_ix_b_' + sha(JSON.stringify([field.id, order])).slice(0, 20), key: orderKey(field.id, order), unique: false});
    for (const join of m.joins) {
        indexes.push({name: 'h45_ix_j_' + sha(join.alias).slice(0, 20), key: {alias: 1, ['joins.' + join.alias]: 1}, unique: true, partial: {alias: join.alias}});
        // $lookup's correlated $expr cannot rely on a partial index. Its complete,
        // nonunique access path is separate from the joined-alias uniqueness constraint.
        indexes.push({name: 'h45_ix_l_' + sha(join.alias).slice(0, 20), key: {['joins.' + join.alias]: 1, alias: 1}, unique: false});
    }
    requireState(indexes.length <= 63, 'Indexed model exceeds native index admission budget', 'stateful.capability-unavailable');
    return Object.freeze(indexes.map(index => Object.freeze(index)));
}
export function assertMongoIndexedIndexesV1(model: MongoIndexedModelV1, raw: readonly Document[]): void {
    for (const expected of mongoIndexedIndexesV1(model)) {
        const actual = raw.find(index => index.name === expected.name);
        requireState(actual && same(actual.key, expected.key) && !!actual.unique === expected.unique && !actual.sparse && !actual.hidden
            && actual.expireAfterSeconds === undefined && same(actual.partialFilterExpression, expected.partial)
            && (!actual.collation || actual.collation.locale === 'simple'), 'Native indexed access path is not admitted', 'stateful.capability-unavailable');
    }
}
export interface MongoIndexedPlanV1 {readonly request: IndexedRequestV1; readonly pipeline: readonly Document[]; readonly hint: string; readonly allowDiskUse: false}
export function planMongoIndexedQueryV1(model: MongoIndexedModelV1, requestInput: IndexedRequestV1, collection: string): MongoIndexedPlanV1 {
    assertMongoIndexedTracerModelV1(model);
    const request = captureIndexedRequestV1(model.selection, requestInput), m = model.declaration.model;
    const anchor = request.where.find(predicate => predicate.op === 'eq' && m.fields.some(field => field.id === predicate.field
        && field.alias === m.base.alias && field.type === 'text' && !field.nullable));
    requireState(anchor, 'Indexed tracer requires an equality-bound native access path', 'stateful.capability-unavailable');
    const order = request.kind === 'page' ? request.order : m.orders[0]!;
    const index = mongoIndexedIndexesV1(model).find(index => !index.unique && same(index.key, orderKey(anchor.field, order)));
    requireState(index, 'Requested indexed order is unavailable', 'stateful.capability-unavailable');
    const filters: Document[] = [{alias: m.base.alias}];
    for (const predicate of request.where) {
        const field = m.fields.find(field => field.id === predicate.field)!;
        if ('values' in predicate) filters.push({['v.' + field.id]: {[predicate.op === 'in' ? '$in' : '$nin']: [...predicate.values]}});
        else {const value = typed(predicate.value, field), operator = ({eq:'$eq',gte:'$gte',gt:'$gt',lt:'$lt'} as Record<string,string>)[predicate.op];
            requireState(operator, 'Predicate has no indexed native implementation', 'stateful.capability-unavailable'); filters.push({['v.' + field.id]: {[operator]: value}});}
    }
    const pipeline: Document[] = [{$match: {$and: filters}}];
    if (request.kind === 'page') {
        const sort: Document = {};
        for (const term of request.order) if (term.field !== anchor.field) {sort['n.' + term.field] = 1; sort['v.' + term.field] = term.direction === 'asc' ? 1 : -1;}
        if (Object.keys(sort).length) pipeline.push({$sort: sort});
    }
    for (const join of m.joins) {
        pipeline.push({$lookup: {from: collection, let: {joinKey: '$joins.' + join.alias}, pipeline: [
            {$match: {alias: join.alias, $expr: {$eq: ['$joins.' + join.alias, '$$joinKey']}}}, {$limit: 2}], as: 'lookups.' + join.alias}});
        if (join.mode === 'inner-one') pipeline.push({$match: {['lookups.' + join.alias + '.0']: {$exists: true}}});
    }
    if (request.kind === 'count') pipeline.push({$group: {_id: null, value: {$sum: Long.ONE}, invalid: {$sum: {$cond: [
        m.joins.length ? {$or: m.joins.map(join => ({$gt: [{$size: '$lookups.' + join.alias}, 1]}))} : false, Long.ONE, Long.ZERO]}}}});
    else {
        pipeline.push({$skip: Long.fromString(request.offset)}, {$limit: Long.fromString(String(request.limit))});
        pipeline.push({$project: {_id: 0, base: Object.fromEntries(['_id','model','representation','alias','kind','key','json','v','n','joins'].map(key => [key, '$' + key])),
            joined: m.joins.length ? '$lookups' : {$literal: {}}}});
    }
    return Object.freeze({request, pipeline: Object.freeze(pipeline), hint: index.name, allowDiskUse: false});
}
export function indexedFieldResultV1(value: FieldValue): string | readonly string[] | null {return Long.isLong(value) ? value.toString() : value;}
