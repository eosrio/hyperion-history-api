import {expect, test} from 'bun:test';
import {
    actionSequenceSort, ActionSequenceQueryPlanError, compileActionSequenceQuery,
    queryRequiresUnsafeRoot, validateActionSequenceSortCursor
} from '../../src/indexer/history/action-sequence-query-plan.js';
import {encodeActionSequenceStorage} from '../../src/indexer/history/action-sequence-storage.js';

const namespace = 'h45_sequences_v1';
const safe = '9007199254740991', maximum = '18446744073709551615';
const value = (path: string) => `${namespace}.${path}.value`;
const key = (path: string) => `${namespace}.${path}.key`;

test('complete Boolean queries retain every predicate, metadata option and opaque contract operand', () => {
    const input = {bool: {filter: [
        {term: {'act.account': 'alpha'}},
        {term: {global_sequence: {value: '9223372036854775808', boost: 2, _name: 'root'}}},
        {range: {'receipts.recv_sequence': {gte: '9007199254740992', lte: maximum, boost: 1}}}
    ], must_not: [{terms: {'receipts.auth_sequence.sequence': ['0', maximum], _name: 'excluded'}}],
    should: [{term: {'act.data.global_sequence': '01'}}, {exists: {field: 'receipts.global_sequence', _name: 'receipt'}}],
    minimum_should_match: 1, _name: 'logical'}};
    const before = structuredClone(input);
    expect(compileActionSequenceQuery(input, 'exact')).toEqual({bool: {filter: [
        {term: {'act.account': 'alpha'}},
        {term: {[value('global')]: {value: '9223372036854775808', boost: 2, _name: 'root'}}},
        {range: {[value('receipts.receive')]: {gte: '9007199254740992', lte: maximum, boost: 1}}}
    ], must_not: [{terms: {[value('receipts.authorization.sequence')]: ['0', maximum], _name: 'excluded'}}],
    should: [{term: {'act.data.global_sequence': '01'}}, {exists: {field: value('receipts.global'), _name: 'receipt'}}],
    minimum_should_match: 1, _name: 'logical'}});
    expect(input).toEqual(before);
});

test('legacy predicates never send an out-of-safe integer to a signed native mapping, including negation', () => {
    expect(compileActionSequenceQuery({bool: {must_not: [{term: {global_sequence: maximum}}], filter: [
        {terms: {'receipts.recv_sequence': ['1', safe, '9007199254740992', maximum]}},
        {range: {global_sequence: {gt: '0', lte: maximum, _name: 'clip'}}}
    ]}}, 'legacy')).toEqual({bool: {must_not: [{match_none: {}}], filter: [
        {terms: {'receipts.recv_sequence': ['1', safe]}},
        {range: {global_sequence: {gte: '1', lte: safe, _name: 'clip'}}}
    ]}});
    expect(compileActionSequenceQuery({term: {code_sequence: '4294967295'}}, 'exact')).toEqual({term: {[`${namespace}.code_sequence`]: 0xffffffff}});
    expect(compileActionSequenceQuery({range: {'receipts.abi_sequence': {gte: '0', lte: '4294967295'}}}, 'exact')).toEqual({
        range: {[`${namespace}.receipts.abi_sequence`]: {gte: 0, lte: 0xffffffff}}
    });
    expect(compileActionSequenceQuery({term: {code_sequence: 0xffffffff}}, 'legacy')).toEqual({match_none: {}});
    expect(compileActionSequenceQuery({range: {abi_sequence: {gte: 0, lte: 0xffffffff}}}, 'legacy')).toEqual({range: {abi_sequence: {gte: 0, lte: 0x7fffffff}}});
    expect(compileActionSequenceQuery({range: {global_sequence: {gt: safe}}}, 'legacy')).toEqual({match_none: {}});
    expect(compileActionSequenceQuery({range: {global_sequence: {lt: '0'}}}, 'exact')).toEqual({match_none: {}});
    expect(compileActionSequenceQuery({range: {global_sequence: {gt: maximum}}}, 'exact')).toEqual({match_none: {}});
    expect(compileActionSequenceQuery({terms: {global_sequence: [maximum]}}, 'legacy')).toEqual({match_none: {}});
});

test('numeric compatibility is explicit and limited to safe inputs, while uint32 counters remain numeric', () => {
    expect(compileActionSequenceQuery({term: {global_sequence: 7}}, 'exact')).toEqual({term: {[value('global')]: '7'}});
    expect(compileActionSequenceQuery({bool: {filter: [
        {term: {code_sequence: 0xffffffff}}, {range: {'receipts.abi_sequence': {gte: 0, lte: 0xffffffff}}}
    ]}}, 'exact')).toEqual({bool: {filter: [
        {term: {[`${namespace}.code_sequence`]: 0xffffffff}},
        {range: {[`${namespace}.receipts.abi_sequence`]: {gte: 0, lte: 0xffffffff}}}
    ]}});
    for (const input of [9007199254740992, '01', '+1', '1e3', maximum + '0', null]) {
        expect(() => compileActionSequenceQuery({term: {global_sequence: input}} as any, 'exact')).toThrow(ActionSequenceQueryPlanError);
    }
    for (const input of ['01', '1e2', '4294967296', 0x100000000, -1, 1.5]) {
        expect(() => compileActionSequenceQuery({term: {abi_sequence: input}} as any, 'exact')).toThrow(ActionSequenceQueryPlanError);
    }
});

test('unsupported metadata semantics fail explicitly without banning ordinary contract queries', () => {
    for (const query of [
        {term: {'receipts[0].recv_sequence': '1'}},
        {term: {'receipts.0.auth_sequence.0.sequence': '1'}},
        {term: {'receipts[0].receiver': 'alpha'}},
        {match: {global_sequence: '1'}},
        {range: {global_sequence: {gte: '1', format: 'strict_date_optional_time'}}},
        {term: {global_sequence: {value: '1', case_insensitive: true}}},
        {terms: {global_sequence: {index: 'lookup', id: '1', path: 'sequences'}}},
        {query_string: {query: 'global_sequence:1'}},
        {query_string: {query: '*', fields: ['receipts.*']}},
        {script: {script: {source: "doc['global_sequence'].value > 1"}}},
        {query_string: {query: '_exists_:global_sequence', fields: ['act.data.memo']}},
        {query_string: {query: 'global\\_sequence:1', fields: ['act.data.memo']}},
        {term: {[value('global')]: '1'}}
    ]) {
        try {compileActionSequenceQuery(query as any, 'exact'); throw new Error('Expected unavailable');}
        catch (error) {
            expect(error).toBeInstanceOf(ActionSequenceQueryPlanError);
            expect((error as ActionSequenceQueryPlanError).statusCode).toBe(503);
        }
    }
    for (const query of [
        {match: {'act.data.label': 'global_sequence'}},
        {match: {'act.data.label': {query: 'global_sequence:1'}}},
        {constant_score: {filter: {match: {'act.data.label': {query: 'global_sequence:1'}}}}},
        {multi_match: {query: 'global_sequence:1', fields: ['act.data.memo']}},
        {term: {'plugin.global_sequence': '01'}},
        {query_string: {query: 'memo:wire', fields: ['act.data.memo']}},
        {query_string: {query: 'act.data.global_sequence:1', fields: ['act.data.memo']}},
        {range: {'act.data.price': {gte: '1e20'}}},
        {term: {'receipts.auth_sequence.account': 'alpha'}},
        {term: {'receipts.receiver': 'alpha'}}
    ]) expect(compileActionSequenceQuery(query as any, 'exact')).toEqual(query);
});

test('root coverage proof distinguishes must/filter constraints from optional or receipt-only predicates', () => {
    const bounded = {range: {global_sequence: {gte: '1', lte: safe}}};
    expect(queryRequiresUnsafeRoot(bounded)).toBe(false);
    expect(queryRequiresUnsafeRoot({term: {global_sequence: safe}})).toBe(false);
    expect(queryRequiresUnsafeRoot({terms: {global_sequence: ['1', safe]}})).toBe(false);
    expect(queryRequiresUnsafeRoot({bool: {filter: [bounded, {term: {'act.account': 'alpha'}}]}})).toBe(false);
    for (const query of [
        {term: {'act.account': 'alpha'}},
        {range: {'receipts.recv_sequence': {lte: safe}}},
        {range: {global_sequence: {lte: safe}}},
        {term: {global_sequence: '0'}},
        {term: {global_sequence: '9007199254740992'}},
        {bool: {filter: [{term: {'act.account': 'alpha'}}], should: [bounded]}},
        {bool: {should: [bounded, {term: {'act.account': 'alpha'}}], minimum_should_match: 1}},
        {bool: {must_not: [{bool: {filter: [{range: {global_sequence: {gt: safe}}}, {term: {'act.account': 'beta'}}]}}]}}
    ]) expect(queryRequiresUnsafeRoot(query as any)).toBe(true);
});

test('root coverage proof handles nested negation and minimum_should_match without assuming contract membership', () => {
    const safeRange = {range: {global_sequence: {gte: '1', lte: safe}}};
    const beyond = {range: {global_sequence: {gt: safe}}};
    const zero = {term: {global_sequence: '0'}};
    expect(queryRequiresUnsafeRoot({match_none: {}})).toBe(false);
    expect(queryRequiresUnsafeRoot({bool: {must_not: [{bool: {must_not: [safeRange]}}]}})).toBe(false);
    expect(queryRequiresUnsafeRoot({bool: {filter: [{exists: {field: 'global_sequence'}}], must_not: [beyond, zero]}})).toBe(false);
    expect(queryRequiresUnsafeRoot({bool: {should: [safeRange, {term: {'act.account': 'alpha'}}], minimum_should_match: 2}})).toBe(false);
    expect(queryRequiresUnsafeRoot({bool: {should: [safeRange, {term: {'act.account': 'alpha'}}], minimum_should_match: '100%'}})).toBe(false);
    expect(queryRequiresUnsafeRoot({bool: {should: [safeRange, {term: {'act.account': 'alpha'}}], minimum_should_match: '-1'}})).toBe(true);
    expect(queryRequiresUnsafeRoot({bool: {should: [safeRange, {term: {'act.account': 'alpha'}}], minimum_should_match: '1<100%'}})).toBe(false);
    expect(queryRequiresUnsafeRoot({bool: {filter: [{term: {'act.account': 'alpha'}}], should: [safeRange], minimum_should_match: 0}})).toBe(true);
    expect(queryRequiresUnsafeRoot({bool: {must_not: [{bool: {should: [safeRange], minimum_should_match: 0}}]}})).toBe(true);
    expect(queryRequiresUnsafeRoot({bool: {must_not: [{bool: {should: [safeRange], minimum_should_match: 2}}]}})).toBe(true);
});

test('exact sequence sorts use padded keyword fields, preserving unrelated sorts and numeric counters', () => {
    expect(actionSequenceSort([{global_sequence: 'desc'}, {'receipts.recv_sequence': {order: 'asc', mode: 'max'}},
        {block_num: 'desc'}, {code_sequence: 'asc'}], 'exact')).toEqual([
        {[key('global')]: {order: 'desc'}}, {[key('receipts.receive')]: {order: 'asc', mode: 'max'}},
        {block_num: 'desc'}, {[`${namespace}.code_sequence`]: {order: 'asc'}}
    ]);
    expect(actionSequenceSort(undefined)).toBeUndefined();
    expect(actionSequenceSort(['_shard_doc', {'act.data.amount': {order: 'asc', missing: '_last'}}])).toEqual([
        '_shard_doc', {'act.data.amount': {order: 'asc', missing: '_last'}}
    ]);
});

test('mixed sorts expose only safe legacy fallback and reject unsupported metadata sort options', () => {
    const sort = actionSequenceSort({'receipts.auth_sequence.sequence': {order: 'desc', mode: 'min'}}) as any;
    expect(sort._script.type).toBe('string');
    expect(sort._script.order).toBe('desc');
    expect(sort._script.script.params).toMatchObject({
        key: key('receipts.authorization.sequence'), legacy: 'receipts.auth_sequence.sequence', mode: 'min',
        version: `${namespace}.version`, zeros: '00000000000000000000'
    });
    expect(sort._script.script.source).toContain('9007199254740991L');
    expect(sort._script.script.source).toContain('unqualified legacy sequence');
    for (const input of [
        {global_sequence: {order: 'asc', missing: '_last'}},
        {global_sequence: {order: 'asc', numeric_type: 'double'}},
        {global_sequence: {mode: 'avg'}},
        {global_sequence: {nested: {path: 'receipts'}}},
        {'receipts[0].recv_sequence': 'asc'},
        {_script: {type: 'number', script: {source: "doc['global_sequence'].value"}}}
    ]) expect(() => actionSequenceSort(input as any)).toThrow(ActionSequenceQueryPlanError);
});

test('sequence sort cursors require exact padded strings while unrelated token positions remain opaque', () => {
    const sorts = [{global_sequence: 'asc'}, {block_num: 'desc'}, {'receipts.recv_sequence': 'desc'}] as any;
    expect(() => validateActionSequenceSortCursor(sorts, ['00000000000000000001', 3, maximum])).not.toThrow();
    expect(() => validateActionSequenceSortCursor(sorts, undefined)).not.toThrow();
    expect(() => validateActionSequenceSortCursor(sorts, ['00000000000000000001', 3, maximum, 8589934593])).not.toThrow();
    for (const values of [
        ['1', 3, maximum], [1, 3, maximum], ['18446744073709551616', 3, maximum],
        ['00000000000000000001', 3], ['00000000000000000000', 3, maximum],
        ['00000000000000000001', 3, maximum, '8589934593'],
        ['00000000000000000001', 3, maximum, 9007199254740992]
    ]) expect(() => validateActionSequenceSortCursor(sorts, values)).toThrow(ActionSequenceQueryPlanError);
    expect(() => validateActionSequenceSortCursor([{abi_sequence: 'asc'}], [0xffffffff])).not.toThrow();
    expect(() => validateActionSequenceSortCursor([{abi_sequence: 'asc'}], ['1'])).toThrow(ActionSequenceQueryPlanError);
});

// Independent small-world oracle: it executes logical predicates against complete
// source rows, not against intervals or the compiler's private implementation.
function fieldValues(input: any, parts: string[]): any[] {
    if (Array.isArray(input)) return input.flatMap(value => fieldValues(value, parts));
    if (parts.length === 0) return input === undefined || input === null ? [] : [input];
    if (input === null || typeof input !== 'object') return [];
    return fieldValues(input[parts[0]], parts.slice(1));
}

function matches(query: any, source: any): boolean {
    const [operator, body] = Object.entries(query)[0] as [string, any];
    if (operator === 'match_all') return true;
    if (operator === 'match_none') return false;
    if (operator === 'exists') return fieldValues(source, body.field.split('.')).length > 0;
    if (operator === 'bool') {
        const list = (field: string): any[] => body[field] === undefined ? [] : Array.isArray(body[field]) ? body[field] : [body[field]];
        const must = [...list('must'), ...list('filter')], should = list('should');
        let required = body.minimum_should_match ?? (must.length === 0 && should.length > 0 ? 1 : 0);
        if (typeof required === 'string') {
            if (required.endsWith('%')) {
                const percentage = parseInt(required, 10), portion = Math.floor(should.length * Math.abs(percentage) / 100);
                required = percentage < 0 ? should.length - portion : portion;
            } else required = parseInt(required, 10);
        }
        if (required < 0) required = should.length + required;
        required = Math.max(0, Math.min(should.length, required));
        if (must.length === 0 && should.length > 0) required = Math.max(1, required);
        return must.every(child => matches(child, source)) && list('must_not').every(child => !matches(child, source)) &&
            should.filter(child => matches(child, source)).length >= required;
    }
    const [field, operand] = Object.entries(body).find(([field]) => field !== '_name' && field !== 'boost') as [string, any];
    const found = fieldValues(source, field.split('.'));
    const integer = field === 'global_sequence' || /^receipts\..*(?:global_sequence|recv_sequence|auth_sequence\.sequence|code_sequence|abi_sequence)$/.test(field) || field.startsWith(namespace + '.') ||
        field === 'code_sequence' || field === 'abi_sequence' || field === 'block_num';
    const compare = (a: any, b: any) => {
        const left = integer ? BigInt(a) : a, right = integer ? BigInt(b) : b;
        return left === right ? 0 : left < right ? -1 : 1;
    };
    if (operator === 'term') return found.some(value => compare(value, typeof operand === 'object' ? operand.value : operand) === 0);
    if (operator === 'terms') return found.some(value => operand.some((item: any) => compare(value, item) === 0));
    if (operator === 'range') return found.some(value => Object.entries(operand).every(([bound, target]) => {
        if (bound === 'boost' || bound === '_name') return true;
        const order = compare(value, target);
        return bound === 'gte' ? order >= 0 : bound === 'gt' ? order > 0 : bound === 'lte' ? order <= 0 : order < 0;
    }));
    throw new Error(`Unsupported oracle operator ${operator}`);
}

test('compiled predicates select the same complete actions across uint64 boundaries and multivalued receipts', () => {
    const roots = ['1', '9', safe, '9007199254740992', '9007199254740993', '9223372036854775807', '9223372036854775808', maximum];
    const rows = roots.map((global_sequence, index) => ({global_sequence, block_num: index + 1,
        act: {account: index % 2 ? 'beta' : 'alpha', data: {global_sequence: '01'}},
        code_sequence: index === roots.length - 1 ? 0xffffffff : index,
        receipts: [
            {receiver: 'alpha', global_sequence, recv_sequence: global_sequence,
                auth_sequence: [{account: 'alpha', sequence: '1'}, {account: 'beta', sequence: global_sequence}]},
            {receiver: 'notification', global_sequence, recv_sequence: '0', auth_sequence: []}
        ]}));
    const queries = [
        {bool: {filter: [{term: {'act.account': 'alpha'}}, {range: {global_sequence: {gt: safe}}}],
            must_not: [{term: {'receipts.auth_sequence.sequence': '9007199254740993'}}]}},
        {bool: {should: [{term: {global_sequence: maximum}}, {term: {'act.account': 'beta'}}], minimum_should_match: 1,
            must_not: [{terms: {global_sequence: ['9', '9223372036854775807']}}]}},
        {bool: {filter: [{range: {'receipts.recv_sequence': {gt: '0', lt: '9223372036854775808'}}},
            {exists: {field: 'global_sequence'}}], must_not: [{term: {'receipts.recv_sequence': '1'}}]}},
        {bool: {filter: [{term: {'receipts.auth_sequence.sequence': '1'}}],
            must_not: [{term: {'receipts.recv_sequence': '0'}}]}},
        {range: {code_sequence: {gte: 0x7fffffff, lte: 0xffffffff}}},
        {bool: {filter: [{term: {'receipts.auth_sequence.account': 'beta'}}, {term: {'receipts.receiver': 'notification'}}]}},
        {bool: {should: [{term: {'act.data.global_sequence': '01'}}, {terms: {global_sequence: ['1', safe, maximum]}}],
            minimum_should_match: 2}},
        {bool: {must_not: [{bool: {should: [{term: {global_sequence: '1'}}], minimum_should_match: 0}}]}}
    ];
    for (const query of queries) {
        const expected = rows.filter(row => matches(query, row)).map(row => row.global_sequence);
        const exact = compileActionSequenceQuery(query as any, 'exact');
        expect(rows.filter(row => matches(exact, encodeActionSequenceStorage(row))).map(row => row.global_sequence)).toEqual(expected);
        const legacy = rows.filter(row => BigInt(row.global_sequence) <= BigInt(safe));
        expect(legacy.filter(row => matches(compileActionSequenceQuery(query as any, 'legacy'), row)).map(row => row.global_sequence))
            .toEqual(legacy.filter(row => matches(query, row)).map(row => row.global_sequence));
    }
});

test('safe-root proofs withstand independent possible worlds, including missing roots and hidden contract membership', () => {
    const leaves: any[] = [
        {term: {global_sequence: '0'}}, {term: {global_sequence: '1'}}, {term: {global_sequence: safe}},
        {term: {global_sequence: '9007199254740992'}}, {terms: {global_sequence: ['1', safe]}},
        {range: {global_sequence: {gte: '1', lte: safe}}}, {range: {global_sequence: {gt: safe}}},
        {range: {global_sequence: {lt: '1'}}}, {range: {global_sequence: {gte: '0', lte: maximum}}},
        {exists: {field: 'global_sequence'}}, {term: {'act.account': 'alpha'}}, {term: {'act.account': 'beta'}},
        {range: {'receipts.recv_sequence': {lte: safe}}}, {match_none: {}}, {match_all: {}}
    ];
    const queries = [...leaves];
    for (let first = 0; first < leaves.length; first++) for (let second = 0; second < leaves.length; second++) {
        queries.push({bool: {filter: [leaves[first]], must_not: [leaves[second]]}});
        queries.push({bool: {should: [leaves[first], leaves[second]], minimum_should_match: 1}});
        queries.push({bool: {should: [leaves[first], leaves[second]], minimum_should_match: 2}});
        queries.push({bool: {must_not: [{bool: {should: [leaves[first], leaves[second]], minimum_should_match: 0}}]}});
    }
    const roots = [undefined, '0', '1', '2', '9', '9007199254740990', safe, '9007199254740992', '9007199254740993',
        '9223372036854775807', '9223372036854775808', maximum];
    const worlds = roots.flatMap(global_sequence => ['alpha', 'beta'].flatMap(account => ['0', maximum].map(recv_sequence => ({
        ...(global_sequence === undefined ? {} : {global_sequence}), act: {account}, receipts: [{recv_sequence}]
    }))));
    const unsafeWorlds = worlds.filter(world => world.global_sequence === undefined || world.global_sequence === '0' || BigInt(world.global_sequence) > BigInt(safe));
    let proven = 0;
    const counterexamples: unknown[] = [];
    for (const query of queries) if (!queryRequiresUnsafeRoot(query)) {
        proven++;
        const witness = unsafeWorlds.find(world => matches(query, world));
        if (witness) counterexamples.push({query, witness});
    }
    expect(proven).toBeGreaterThan(50);
    expect(counterexamples).toEqual([]);
});
