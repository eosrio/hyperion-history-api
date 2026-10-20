import type {estypes} from '@elastic/elasticsearch';
import {compatibleUint64} from '../helpers/uint64.js';
import {ACTION_SEQUENCE_NAMESPACE} from './action-sequence-storage.js';

type Metadata = Record<string, any>;
type Cohort = 'exact' | 'legacy';
type Interval = [bigint, bigint];
type Domain = {ranges: Interval[]; missing: boolean};
type Bounds = {possible: Domain; certain: Domain};
type Plan = {query: estypes.QueryDslQueryContainer; bounds: Bounds};
type Leaf = {field: string; physical: string; key?: string; kind: 'sequence' | 'counter'; positive: boolean; legacyMaximum: bigint};

const maximum = 0xffffffffffffffffn;
const safeMaximum = 9007199254740991n;
const counterMaximum = 0xffffffffn;
const zeros = '00000000000000000000';
const prefix = ACTION_SEQUENCE_NAMESPACE;
const sequencePaths = new Map([
    ['global_sequence', 'global'], ['receipts.global_sequence', 'receipts.global'],
    ['receipts.recv_sequence', 'receipts.receive'],
    ['receipts.auth_sequence.sequence', 'receipts.authorization.sequence']
]);
const counterPaths = ['code_sequence', 'abi_sequence', 'receipts.code_sequence', 'receipts.abi_sequence'];
const metadataPaths = [...sequencePaths.keys(), ...counterPaths];
const physicalMetadataPaths = [`${prefix}.version`, ...counterPaths.map(field => `${prefix}.${field}`),
    `${prefix}.receipts.index`, `${prefix}.receipts.receiver`, `${prefix}.receipts.authorization.index`, `${prefix}.receipts.authorization.account`,
    ...[...sequencePaths.values()].flatMap(path => [`${prefix}.${path}.value`, `${prefix}.${path}.key`])];
const opaqueFieldQueries = new Set(['term', 'terms', 'range', 'match', 'match_phrase', 'match_phrase_prefix',
    'match_bool_prefix', 'prefix', 'wildcard', 'regexp', 'fuzzy', 'span_term']);
const fieldListQueries = new Set(['query_string', 'simple_query_string', 'combined_fields', 'multi_match']);
const empty = (): Domain => ({ranges: [], missing: false});
const universe = (): Domain => ({ranges: [[0n, maximum]], missing: true});
const unknownBounds = (): Bounds => ({possible: universe(), certain: empty()});
const knownBounds = (domain: Domain): Bounds => ({possible: domain, certain: domain});

/** Unsupported metadata operations are retryably unavailable rather than approximately executed. */
export class ActionSequenceQueryPlanError extends Error {
    readonly code = 'HYPERION_ACTION_SEQUENCE_QUERY_UNAVAILABLE';
    readonly statusCode = 503;
    constructor(message: string) {
        super(message);
        this.name = 'ActionSequenceQueryPlanError';
    }
}

function unavailable(message: string): never {throw new ActionSequenceQueryPlanError(message);}
function object(input: unknown, label: string): Metadata {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) unavailable(`Invalid ${label}`);
    return input as Metadata;
}

function metadataReference(field: string): boolean {
    if (field === prefix || field.startsWith(prefix + '.')) return true;
    if (metadataPaths.includes(field)) return true;
    if (/^(?:global_sequence|code_sequence|abi_sequence)[.[]/.test(field)) return true;
    if (/^receipts?(?:\[|\.[0-9]+(?:\.|$))/.test(field) || /^receipts?\.auth_sequence(?:\[|\.[0-9]+(?:\.|$))/.test(field)) return true;
    if (/^receipt\.(?:global_sequence|recv_sequence|auth_sequence\.sequence|code_sequence|abi_sequence)(?:$|[.[])/.test(field)) return true;
    if (/^receipts\.(?:global_sequence|recv_sequence|code_sequence|abi_sequence)[.[]/.test(field) ||
        /^receipts\.auth_sequence\.sequence[.[]/.test(field) || field === 'receipts.auth_sequence') return true;
    if (/[*?]/.test(field)) {
        const pattern = new RegExp('^' + field.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        return [...metadataPaths, prefix, ...physicalMetadataPaths].some(path => pattern.test(path));
    }
    return false;
}

function leaf(field: string): Leaf | undefined {
    const path = sequencePaths.get(field);
    if (path) return {field, physical: `${prefix}.${path}.value`, key: `${prefix}.${path}.key`, kind: 'sequence',
        positive: field === 'global_sequence' || field === 'receipts.global_sequence', legacyMaximum: safeMaximum};
    if (counterPaths.includes(field)) return {field, physical: `${prefix}.${field}`, kind: 'counter', positive: false,
        legacyMaximum: field.startsWith('receipts.') ? counterMaximum : 0x7fffffffn};
    if (metadataReference(field)) unavailable(`Unsupported action sequence field or tuple path: ${field}`);
    return undefined;
}

function scalar(input: unknown, field: Leaf): string | number {
    if (field.kind === 'counter') {
        if (typeof input === 'string') {
            try {
                const text = compatibleUint64(input);
                if (BigInt(text) <= counterMaximum) return Number(text);
            } catch {}
            return unavailable(`Expected a canonical uint32 action counter query: ${field.field}`);
        }
        if (typeof input !== 'number' || !Number.isInteger(input) || input < 0 || input > Number(counterMaximum)) {
            unavailable(`Expected a numeric uint32 action counter: ${field.field}`);
        }
        return input;
    }
    try {return compatibleUint64(input);} catch {return unavailable(`Invalid canonical uint64 query value: ${field.field}`);}
}

function options(input: Metadata, allowed: readonly string[], label: string): void {
    if (Object.keys(input).some(key => !allowed.includes(key))) unavailable(`Unsupported ${label} option`);
    if (input.boost !== undefined && (typeof input.boost !== 'number' || !Number.isFinite(input.boost) || input.boost < 0)) {
        unavailable(`Invalid ${label} boost`);
    }
    if (input._name !== undefined && typeof input._name !== 'string') unavailable(`Invalid ${label} query name`);
}

function normalized(ranges: Interval[]): Interval[] {
    const sorted = ranges.filter(([low, high]) => low <= high).sort((a, b) => a[0] < b[0] ? -1 : a[0] === b[0] ? 0 : 1);
    const result: Interval[] = [];
    for (const [low, high] of sorted) {
        const last = result.at(-1);
        if (last && low <= last[1] + 1n) {if (high > last[1]) last[1] = high;}
        else result.push([low, high]);
    }
    return result;
}

function intersection(a: Domain, b: Domain): Domain {
    const ranges: Interval[] = [];
    let left = 0, right = 0;
    while (left < a.ranges.length && right < b.ranges.length) {
        const x = a.ranges[left], y = b.ranges[right];
        const low = x[0] > y[0] ? x[0] : y[0], high = x[1] < y[1] ? x[1] : y[1];
        if (low <= high) ranges.push([low, high]);
        if (x[1] < y[1]) left++; else right++;
    }
    return {ranges, missing: a.missing && b.missing};
}

function complement(domain: Domain): Domain {
    const ranges: Interval[] = [];
    let next = 0n;
    for (const [low, high] of domain.ranges) {
        if (next < low) ranges.push([next, low - 1n]);
        next = high + 1n;
    }
    if (next <= maximum) ranges.push([next, maximum]);
    return {ranges, missing: !domain.missing};
}

/** At least k possible clauses, without exponential combinations of Boolean branches. */
function threshold(domains: Domain[], required: number): Domain {
    if (required <= 0) return universe();
    if (required > domains.length) return empty();
    const events = new Map<bigint, number>();
    for (const domain of domains) for (const [low, high] of domain.ranges) {
        events.set(low, (events.get(low) ?? 0) + 1);
        events.set(high + 1n, (events.get(high + 1n) ?? 0) - 1);
    }
    const positions = [...events.keys()].sort((a, b) => a < b ? -1 : a === b ? 0 : 1);
    const ranges: Interval[] = [];
    let count = 0, start: bigint | undefined;
    for (const position of positions) {
        const previous = count;
        count += events.get(position)!;
        if (previous < required && count >= required) start = position;
        if (previous >= required && count < required && start !== undefined) ranges.push([start, position - 1n]);
    }
    return {ranges, missing: domains.filter(domain => domain.missing).length >= required};
}

function minimumShouldMatch(input: unknown, count: number, fallback: number): number {
    if (input === undefined) return fallback;
    const calculate = (specification: string): number => {
        if (!/^-?(?:0|[1-9][0-9]*)%?$/.test(specification)) unavailable('Invalid minimum_should_match');
        const percentage = specification.endsWith('%');
        const value = Number(percentage ? specification.slice(0, -1) : specification);
        if (!Number.isSafeInteger(value)) unavailable('Invalid minimum_should_match');
        if (percentage) {
            const portion = Number((BigInt(count) * BigInt(Math.abs(value))) / 100n);
            return value < 0 ? count - portion : portion;
        }
        return value < 0 ? count + value : value;
    };
    let required: number;
    if (typeof input === 'number') {
        if (!Number.isSafeInteger(input)) unavailable('Invalid minimum_should_match');
        required = input < 0 ? count + input : input;
    } else if (typeof input === 'string' && input.includes('<')) {
        required = count;
        let previous = -1;
        for (const condition of input.split(' ')) {
            const match = /^(0|[1-9][0-9]*)<(-?(?:0|[1-9][0-9]*)%?)$/.exec(condition);
            if (!match) unavailable('Invalid conditional minimum_should_match');
            const cutoff = Number(match[1]);
            if (!Number.isSafeInteger(cutoff) || cutoff <= previous) unavailable('Invalid conditional minimum_should_match');
            previous = cutoff;
            const calculated = calculate(match[2]);
            if (count > cutoff) required = calculated;
        }
    } else if (typeof input === 'string') required = calculate(input);
    else return unavailable('Invalid minimum_should_match');
    return Math.max(0, required);
}

function fieldEntries(body: Metadata): [string, any][] {
    return Object.entries(body).filter(([field]) => field !== 'boost' && field !== '_name');
}

function rangeBounds(body: Metadata, field: Leaf, ceiling: bigint): {domain: Domain; native: Metadata} {
    options(body, ['gt', 'gte', 'lt', 'lte', 'boost', '_name'], 'action sequence range');
    let low = 0n, high = ceiling;
    const native: Metadata = {};
    for (const name of ['boost', '_name']) if (body[name] !== undefined) native[name] = body[name];
    for (const operator of ['gt', 'gte', 'lt', 'lte']) if (Object.hasOwn(body, operator)) {
        const boundary = BigInt(scalar(body[operator], field));
        if (operator === 'gte' && boundary > low) low = boundary;
        if (operator === 'gt' && boundary + 1n > low) low = boundary + 1n;
        if (operator === 'lte' && boundary < high) high = boundary;
        if (operator === 'lt' && boundary - 1n < high) high = boundary - 1n;
    }
    if (low > high) return {domain: empty(), native};
    const output = (value: bigint) => field.kind === 'sequence' ? value.toString() : Number(value);
    native.gte = output(low); native.lte = output(high);
    return {domain: {ranges: [[low, high]], missing: false}, native};
}

function mentionsMetadata(input: unknown, key?: string): boolean {
    if (typeof input === 'string') {
        if (['field', 'default_field', 'fields', 'path', 'minimum_should_match_field'].includes(key ?? '')) return metadataReference(input.split('^')[0]);
        if (key === 'query') {
            const fields = [...input.matchAll(/([A-Za-z0-9_.*?\[\].\\]+)\s*:/g)];
            if (fields.some(match => metadataReference(match[1].replaceAll('\\', '')))) return true;
            return [...input.matchAll(/\b_exists_\s*:\s*([A-Za-z0-9_.*?\[\].\\]+)/g)]
                .some(match => metadataReference(match[1].replaceAll('\\', '')));
        }
        if (key === 'source') {
            if (/(?:global_sequence|recv_sequence|auth_sequence|code_sequence|abi_sequence|h45_sequences_v1)/.test(input)) return true;
            // Only explicit nonmetadata doc lookups can be inspected. Stored or dynamic
            // scripts could otherwise hide a metadata query from the compiler.
            const withoutStaticLookups = input.replace(/doc\s*\[\s*(['"])([^'"]+)\1\s*\]/g, (_all, _quote, field) => metadataReference(field) ? 'METADATA_REFERENCE' : '');
            return /METADATA_REFERENCE|\bdoc\b|\b_source\b/.test(withoutStaticLookups);
        }
        return false;
    }
    if (Array.isArray(input)) return input.some(item => mentionsMetadata(item, key));
    if (input === null || typeof input !== 'object') return false;
    return Object.entries(input).some(([field, child]) => {
        if (metadataReference(field) || field === 'script' || field === 'inner_hits' || (field === 'id' && key === 'script')) return true;
        if (opaqueFieldQueries.has(field)) return Object.keys(object(child, field)).some(metadataReference);
        if (fieldListQueries.has(field)) {
            const body = object(child, field), fields = body.fields ?? body.default_field;
            return fields === undefined || mentionsMetadata(fields, 'fields') ||
                (['query_string', 'simple_query_string'].includes(field) && mentionsMetadata(body.query, 'query'));
        }
        return mentionsMetadata(child, field);
    });
}

function unknownQuery(kind: string, body: unknown): Plan {
    if (kind === 'script') unavailable('Opaque action history scripts require a qualified logical adapter');
    if (['match', 'match_phrase', 'match_phrase_prefix', 'match_bool_prefix', 'prefix', 'wildcard', 'regexp', 'fuzzy', 'span_term'].includes(kind)) {
        if (Object.keys(object(body, kind)).some(metadataReference)) unavailable(`Unsupported ${kind} action sequence query`);
        return {query: {[kind]: structuredClone(body)} as estypes.QueryDslQueryContainer, bounds: unknownBounds()};
    }
    if (fieldListQueries.has(kind)) {
        const record = object(body, kind);
        const fields = record.fields ?? record.default_field;
        if (fields === undefined || (Array.isArray(fields) && fields.length === 0)) {
            unavailable(`Unbounded ${kind} can reference action sequence metadata`);
        }
        const fieldList = Array.isArray(fields) ? fields : [fields];
        if (fieldList.some(field => typeof field !== 'string' || field.length === 0) || mentionsMetadata(fields, 'fields') ||
            (['query_string', 'simple_query_string'].includes(kind) && mentionsMetadata(record.query, 'query'))) {
            unavailable(`Unsupported ${kind} action sequence query`);
        }
        return {query: {[kind]: structuredClone(body)} as estypes.QueryDslQueryContainer, bounds: unknownBounds()};
    }
    if (kind === 'wrapper' || kind === 'percolate' || mentionsMetadata(body)) unavailable(`Unsupported ${kind} action sequence query`);
    return {query: {[kind]: structuredClone(body)} as estypes.QueryDslQueryContainer, bounds: unknownBounds()};
}

function walk(input: unknown, cohort: Cohort, depth = 0): Plan {
    if (depth > 128) unavailable('Action sequence query nesting exceeds the supported limit');
    const query = object(input, 'action query');
    const entries = Object.entries(query);
    if (entries.length === 0) return {query: {}, bounds: knownBounds(universe())};
    if (entries.length !== 1) unavailable('Expected one action query operator');
    const [kind, operand] = entries[0];
    if (kind === 'bool') {
        const body = object(operand, 'Boolean action query');
        options(body, ['must', 'filter', 'must_not', 'should', 'minimum_should_match', 'boost', '_name'], 'Boolean action query');
        const compiled: Metadata = {...body};
        let possible = universe(), certain = universe();
        const plans = new Map<string, Plan[]>();
        for (const clause of ['must', 'filter', 'must_not', 'should']) if (body[clause] !== undefined) {
            const array = Array.isArray(body[clause]) ? body[clause] : [body[clause]];
            const children = array.map((child: unknown) => walk(child, cohort, depth + 1));
            plans.set(clause, children);
            compiled[clause] = Array.isArray(body[clause]) ? children.map(child => child.query) : children[0].query;
            if (clause === 'must' || clause === 'filter') for (const child of children) {
                possible = intersection(possible, child.bounds.possible);
                certain = intersection(certain, child.bounds.certain);
            }
            if (clause === 'must_not') for (const child of children) {
                possible = intersection(possible, complement(child.bounds.certain));
                certain = intersection(certain, complement(child.bounds.possible));
            }
        }
        const should = plans.get('should') ?? [];
        const hasRequired = (plans.get('must')?.length ?? 0) + (plans.get('filter')?.length ?? 0) > 0;
        const nativeFloor = should.length > 0 && !hasRequired ? 1 : 0;
        const minimum = Math.max(nativeFloor, minimumShouldMatch(body.minimum_should_match, should.length, nativeFloor));
        // Native minimum_should_match clamps calculations. Keeping the upper certain
        // bound empty when an explicit requirement exceeds the clause count is also
        // conservative across parser/native versions, including under must_not.
        possible = intersection(possible, threshold(should.map(child => child.bounds.possible), Math.min(should.length, minimum)));
        certain = intersection(certain, threshold(should.map(child => child.bounds.certain), minimum));
        return {query: {bool: compiled}, bounds: {possible, certain}};
    }
    if (kind === 'match_all' || kind === 'match_none') {
        options(object(operand, kind), ['boost', '_name'], kind);
        return {query: structuredClone(query), bounds: knownBounds(kind === 'match_all' ? universe() : empty())};
    }
    if (kind === 'exists') {
        const body = object(operand, 'exists query');
        if (typeof body.field !== 'string') unavailable('Invalid exists field');
        const field = leaf(body.field);
        if (!field) return {query: structuredClone(query), bounds: unknownBounds()};
        options(body, ['field', 'boost', '_name'], 'action sequence exists');
        return {query: {exists: {...body, field: cohort === 'exact' ? field.physical : field.field}},
            bounds: field.field === 'global_sequence' ? knownBounds({ranges: [[0n, maximum]], missing: false}) : unknownBounds()};
    }
    if (kind !== 'term' && kind !== 'terms' && kind !== 'range') return unknownQuery(kind, operand);
    const body = object(operand, kind);
    const fields = fieldEntries(body);
    const affected = fields.map(([field, value]) => ({field: leaf(field), value})).filter(entry => entry.field !== undefined);
    if (affected.length === 0) return {query: structuredClone(query), bounds: unknownBounds()};
    if (fields.length !== 1) unavailable(`Expected one ${kind} action sequence field`);
    if (kind !== 'terms' && Object.keys(body).length !== 1) unavailable(`Unsupported outer ${kind} action sequence option`);
    const {field: candidate, value: inputValue} = affected[0];
    const field = candidate!;
    const target = cohort === 'exact' ? field.physical : field.field;
    const ceiling = cohort === 'legacy' ? field.legacyMaximum : field.kind === 'sequence' ? maximum : counterMaximum;
    const root = field.field === 'global_sequence';
    const noMatch = (extra: Metadata = {}): Plan => ({query: {match_none: extra}, bounds: knownBounds(empty())});
    if (kind === 'term') {
        const details = inputValue !== null && typeof inputValue === 'object' && !Array.isArray(inputValue) ? object(inputValue, 'term value') : undefined;
        if (details) {
            options(details, ['value', 'boost', '_name', 'case_insensitive'], 'action sequence term');
            if (details.case_insensitive !== undefined && details.case_insensitive !== false) unavailable('Case-insensitive action sequence terms are unsupported');
        }
        const value = scalar(details ? details.value : inputValue, field);
        if (BigInt(value) > ceiling) return noMatch();
        return {query: {term: {[target]: details ? {...details, value} : value}},
            bounds: root ? knownBounds({ranges: [[BigInt(value), BigInt(value)]], missing: false}) : unknownBounds()};
    }
    if (kind === 'terms') {
        options(Object.fromEntries(Object.entries(body).filter(([key]) => key !== field.field)), ['boost', '_name'], 'action sequence terms');
        if (!Array.isArray(inputValue)) unavailable('Action sequence terms lookup is unsupported');
        const values = inputValue.map(input => scalar(input, field)).filter(value => BigInt(value) <= ceiling);
        if (values.length === 0) return noMatch();
        const native = {...body};
        delete native[field.field];
        native[target] = values;
        return {query: {terms: native} as estypes.QueryDslQueryContainer,
            bounds: root ? knownBounds({ranges: normalized(values.map(value => [BigInt(value), BigInt(value)])), missing: false}) : unknownBounds()};
    }
    const range = rangeBounds(object(inputValue, 'action sequence range'), field, ceiling);
    if (range.domain.ranges.length === 0) return noMatch();
    return {query: {range: {[target]: range.native}}, bounds: root ? knownBounds(range.domain) : unknownBounds()};
}

/**
 * Translate a complete logical predicate tree. The transport supplies disjoint cohort
 * guards and source coverage at its PIT. A legacy cohort is licensed only when every
 * participating legacy metadata leaf is qualified for its declared cohort domain;
 * clipping is not coverage proof.
 */
export function compileActionSequenceQuery(query: estypes.QueryDslQueryContainer, cohort: Cohort): estypes.QueryDslQueryContainer {
    if (cohort !== 'exact' && cohort !== 'legacy') unavailable('Invalid action sequence cohort');
    return walk(query, cohort).query;
}

/** Unknown contract predicates never prove that absent/overwritten action rows are covered. */
export function queryRequiresUnsafeRoot(query: estypes.QueryDslQueryContainer): boolean {
    const domain = walk(query, 'exact').bounds.possible;
    return domain.missing || domain.ranges.some(([low, high]) => low < 1n || high > safeMaximum);
}

function sortOptions(input: unknown): Metadata {
    if (typeof input === 'string') {
        if (input !== 'asc' && input !== 'desc') unavailable('Invalid action sequence sort order');
        return {order: input};
    }
    const body = object(input, 'action sequence sort');
    options(body, ['order', 'mode'], 'action sequence sort');
    if (body.order !== undefined && body.order !== 'asc' && body.order !== 'desc') unavailable('Invalid action sequence sort order');
    if (body.mode !== undefined && body.mode !== 'min' && body.mode !== 'max') unavailable('Unsupported action sequence sort mode');
    return {order: body.order ?? 'asc', ...(body.mode === undefined ? {} : {mode: body.mode})};
}

const mixedSequenceScript = `
boolean exact = doc.containsKey(params.version) && doc[params.version].size() != 0;
if (exact) {
  if (doc[params.version].size() != 1 || doc[params.version].value != 1 || !doc.containsKey(params.key) || doc[params.key].size() == 0) {
    throw new IllegalArgumentException('incomplete exact sequence namespace');
  }
  def values = doc[params.key];
  if (params.root && values.size() != 1) throw new IllegalArgumentException('invalid root sequence cardinality');
  for (def item : values) {
    String text = item.toString();
    if (text.length() != 20 || text.compareTo('18446744073709551615') > 0 || (params.positive && text == params.zeros)) {
      throw new IllegalArgumentException('invalid exact sequence sort key');
    }
    for (int i = 0; i < text.length(); i++) if (text.charAt(i) < 48 || text.charAt(i) > 57) {
      throw new IllegalArgumentException('invalid exact sequence sort key');
    }
  }
  return params.mode == 'min' ? values.get(0) : values.get(values.size() - 1);
}
if (doc.containsKey(params.key) && doc[params.key].size() != 0) throw new IllegalArgumentException('missing exact sequence version');
if (!doc.containsKey(params.legacy) || doc[params.legacy].size() == 0) throw new IllegalArgumentException('missing legacy sequence');
def values = doc[params.legacy];
if (params.root && values.size() != 1) throw new IllegalArgumentException('invalid root sequence cardinality');
for (def item : values) {
  long value = item;
  if (value < 0 || (params.positive && value == 0) || value > 9007199254740991L) throw new IllegalArgumentException('unqualified legacy sequence');
}
long selected = params.mode == 'min' ? values.get(0) : values.get(values.size() - 1);
String text = Long.toString(selected);
return params.zeros.substring(text.length()) + text;`;

const mixedCounterScript = `
boolean exact = doc.containsKey(params.version) && doc[params.version].size() != 0;
String field = exact ? params.key : params.legacy;
if (exact && (doc[params.version].size() != 1 || doc[params.version].value != 1)) throw new IllegalArgumentException('invalid exact sequence version');
if (!exact && doc.containsKey(params.key) && doc[params.key].size() != 0) throw new IllegalArgumentException('missing exact sequence version');
if (!doc.containsKey(field) || doc[field].size() == 0) throw new IllegalArgumentException('missing action counter');
def values = doc[field];
for (def item : values) if (item < 0 || item > 4294967295L) throw new IllegalArgumentException('invalid uint32 action counter');
return params.mode == 'min' ? values.get(0) : values.get(values.size() - 1);`;

function sortEntries(input: estypes.SortCombinations): Array<{field: string; input: unknown; leaf?: Leaf; original: estypes.SortCombinations}> {
    if (typeof input === 'string') {
        const [field, direction, ...extra] = input.split(':');
        const found = leaf(field);
        if (found && extra.length) unavailable('Invalid action sequence sort syntax');
        return [{field, input: direction ?? 'asc', leaf: found, original: input}];
    }
    return Object.entries(object(input, 'sort')).map(([field, value]) => {
        if (field === '_script') unavailable('Opaque action history script sorts require a qualified logical adapter');
        if (field.startsWith('_') && mentionsMetadata(value)) unavailable('Unsupported action sequence sort expression');
        return {field, input: value, leaf: leaf(field), original: {[field]: structuredClone(value)} as estypes.SortCombinations};
    });
}

/** Native sorts execute before pagination. Sequence cursors are 20-digit strings in both cohorts. */
export function actionSequenceSort(sort: estypes.Sort | undefined, cohort: 'mixed' | 'exact' = 'mixed'): estypes.Sort | undefined {
    if (sort === undefined) return undefined;
    if (cohort !== 'mixed' && cohort !== 'exact') unavailable('Invalid action sequence sort cohort');
    const input = Array.isArray(sort) ? sort : [sort];
    const output = input.flatMap(entry => sortEntries(entry)).map(entry => {
        if (!entry.leaf) return entry.original;
        const field = entry.leaf, settings = sortOptions(entry.input);
        if (cohort === 'exact') return {[field.key ?? field.physical]: settings};
        return {_script: {type: field.kind === 'sequence' ? 'string' : 'number', order: settings.order,
            script: {lang: 'painless', source: field.kind === 'sequence' ? mixedSequenceScript : mixedCounterScript,
                params: {version: `${prefix}.version`, key: field.key ?? field.physical, legacy: field.field, zeros,
                    root: field.field === 'global_sequence', positive: field.positive,
                    mode: settings.mode ?? (settings.order === 'desc' ? 'max' : 'min')}}}};
    });
    return (Array.isArray(sort) || output.length !== 1 ? output : output[0]) as estypes.Sort;
}

/** Validate logical sort positions before passing search_after back to Elasticsearch. */
export function validateActionSequenceSortCursor(sort: estypes.Sort | undefined, values: readonly unknown[] | undefined): void {
    if (values === undefined) return;
    const entries = sort === undefined ? [] : (Array.isArray(sort) ? sort : [sort]).flatMap(entry => sortEntries(entry));
    const implicitShardDoc = values.length === entries.length + 1;
    if (entries.length !== values.length && !implicitShardDoc) unavailable('Action sequence sort cursor length does not match the sort');
    const shardDoc = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (implicitShardDoc && (!shardDoc(values.at(-1)) || entries.some(entry => entry.field === '_shard_doc'))) {
        unavailable('Expected a safe implicit PIT shard cursor');
    }
    for (let index = 0; index < entries.length; index++) {
        if (entries[index].field === '_shard_doc' && !shardDoc(values[index])) unavailable('Expected a safe PIT shard cursor');
        const field = entries[index].leaf;
        if (!field) continue;
        sortOptions(entries[index].input);
        const value = values[index];
        if (field.kind === 'counter') {
            if (typeof value !== 'number') unavailable('Expected a numeric uint32 action counter sort cursor');
            scalar(value, field);
            continue;
        }
        if (typeof value !== 'string' || !/^[0-9]{20}$/.test(value) || value > maximum.toString() || (field.positive && value === zeros)) {
            unavailable('Expected an exact padded decimal action sequence sort cursor');
        }
    }
}
