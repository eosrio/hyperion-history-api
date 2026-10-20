import {describe, expect, test} from 'bun:test';
import type {Client, estypes} from '@elastic/elasticsearch';
import {ActionHistoryAdapter} from '../../src/indexer/history/action-history-adapter.js';
import {ActionHistoryCoverageAuthority, ActionHistoryCoverageLease} from '../../src/indexer/history/action-history-coverage.js';
import {encodeActionSequenceStorage} from '../../src/indexer/history/action-sequence-storage.js';
import {projectActionSource} from '../../src/indexer/history/action-source-projection.js';

const index = 'test-action-v1-000001';
const shards = {total: 4, successful: 4, skipped: 0, failed: 0};
const logical = () => ({global_sequence: '18446744073709551615', code_sequence: 4294967295, block_num: 17,
    receipts: [{receiver: 'alice', global_sequence: '18446744073709551614', recv_sequence: '9223372036854775808',
        auth_sequence: [{account: 'bob', sequence: '9007199254740993'}]}],
    act: {account: 'alpha', name: 'run', data: {global_sequence: 1.25, retained: false, nested: [null, 0, {description: 'x'}]}}});
const response = (hits: unknown[] = [], count = hits.length, pit = 'pit-2') => ({pit_id: pit, timed_out: false, _shards: shards,
    hits: {total: {value: count, relation: 'eq'}, hits}});

function fixture() {
    const searches: estypes.SearchRequest[] = [], closed: string[] = [], checked: unknown[] = [];
    let released = 0, currentCalls = 0, settingsCalls = 0, sequence = 0;
    let next: (params: estypes.SearchRequest) => Promise<any> = async params => params.size === 0 ? response([], 0, `pit-${++sequence}`) :
        response([{_index: index, _id: logical().global_sequence, _source: encodeActionSequenceStorage(logical()),
            fields: {'h45_sequences_v1.version': [1]}, sort: [logical().global_sequence.padStart(20, '0'), 5]}], 1, 'pit-latest');
    const lease: ActionHistoryCoverageLease = {generation: 'fixture-sealed-range-1', source: 'owned-fixture:expected-input-manifest',
        indices: [{name: index, uuid: 'uuid-original'}],
        async assertComplete(query) {checked.push(query);}, async assertCurrent() {currentCalls++;}, async release() {released++;}};
    const authority: ActionHistoryCoverageAuthority = {async acquire() {return lease;}};
    const native = {
        indices: {
            async resolveIndex() {return {indices: [{name: index}], aliases: [], data_streams: []};},
            async getAlias() {return {[index]: {aliases: {read: {}}}};},
            async getSettings() {settingsCalls++; return {[index]: {settings: {'index.uuid': 'uuid-original'}}};}
        },
        async openPointInTime() {return {id: 'pit-open', _shards: shards};},
        async search(params: estypes.SearchRequest) {searches.push(params); return next(params);},
        async closePointInTime(params: {id: string}) {closed.push(params.id); return {succeeded: true, num_freed: 4};}
    };
    return {native, lease, authority, searches, closed, checked, setNext(fn: typeof next) {next = fn;},
        stats: () => ({released, currentCalls, settingsCalls}),
        adapter: new ActionHistoryAdapter(native as unknown as Client, 'test', authority)};
}

describe('gated exact action history adapter', () => {
    test('has no automatic authority or production activation', async () => {
        const f = fixture();
        const adapter = new ActionHistoryAdapter(f.native as unknown as Client, 'test');
        await expect(adapter.search(index, {})).rejects.toMatchObject({statusCode: 503});
        expect(f.searches).toHaveLength(0);
        expect(f.closed).toEqual(['pit-open']);
    });

    test('restores full uint64 and numeric uint32 metadata, hides the physical namespace and prunes source only afterwards', async () => {
        const f = fixture();
        const result = await f.adapter.search(index, {query: {term: {'act.account': 'alpha'}},
            sort: {global_sequence: 'asc'}, _source: {includes: ['global_sequence', 'code_sequence', 'act.data']}});
        expect(result.hits.hits[0]._source).toEqual({global_sequence: '18446744073709551615', code_sequence: 4294967295,
            act: {data: logical().act.data}});
        expect(f.searches.at(-1)?._source).toBe(true);
        expect(f.searches.every(search => search.allow_partial_search_results === false)).toBe(true);
        expect(f.closed).toEqual(['pit-latest']);
        expect(f.stats().released).toBe(1);
    });

    test('a lost contract action is not certified by a filtered empty survivor scan', async () => {
        const f = fixture();
        f.setNext(async () => response([], 1, 'pit-unsafe-survivor'));
        await expect(f.adapter.search(index, {query: {term: {'act.account': 'lost-contract'}}})).rejects.toMatchObject({statusCode: 503});
        expect(f.searches).toHaveLength(1);
        expect(JSON.stringify(f.searches[0].query)).not.toContain('lost-contract');
        expect(f.closed).toEqual(['pit-unsafe-survivor']);
    });

    test('zero surviving unsafe rows cannot override a missing source manifest', async () => {
        const f = fixture();
        f.lease.assertComplete = async () => {throw Object.assign(new Error('pending source manifest'), {statusCode: 503});};
        await expect(f.adapter.search(index, {query: {match_all: {}}})).rejects.toThrow('pending source manifest');
        expect(f.searches).toHaveLength(0);
        expect(f.stats().released).toBe(1);
    });

    test('a proven safe-root scope skips unsafe-root ambiguity but independently checks receipt metadata', async () => {
        const f = fixture();
        const context = await f.adapter.open(index);
        try {
            await context.search({query: {range: {global_sequence: {gte: '1', lte: '9007199254740991'}}}, size: 0});
            expect(f.searches).toHaveLength(3);
            expect(JSON.stringify(f.searches[1].query)).toContain('receipts.auth_sequence.sequence');
        } finally {await context.close();}
    });

    test('safe root alone never certifies an unsafe receipt or authorization leaf', async () => {
        const f = fixture(); let call = 0; f.setNext(async () => response([], ++call === 2 ? 1 : 0));
        await expect(f.adapter.search(index, {query: {term: {global_sequence: '1'}}})).rejects.toThrow('receipt or authorization');
    });

    test('count uses the same PIT and complete native membership, preserving a numeric unrelated count', async () => {
        const f = fixture(); let call = 0;
        f.setNext(async () => response([], ++call === 4 ? 7 : 0, `pit-${call}`));
        const context = await f.adapter.open(index);
        try {expect(await context.count({term: {'act.account': 'alpha'}})).toBe(7);} finally {await context.close();}
        expect(f.searches).toHaveLength(4);
        expect(f.searches.map(search => search.pit?.id)).toEqual(['pit-open', 'pit-1', 'pit-2', 'pit-3']);
        expect(f.searches.at(-1)).toMatchObject({size: 0, _source: false, track_total_hits: true});
        expect(f.closed).toEqual(['pit-4']);
    });

    test.each([
        {timed_out: true}, {terminated_early: true}, {_shards: {...shards, failed: 1}},
        {_shards: {...shards, successful: 3}}, {_shards: {...shards, skipped: undefined}}
    ])('failed or incomplete shards fail closed and close the latest PIT: %j', async invalid => {
        const f = fixture(); f.setNext(async () => ({...response([], 0, 'pit-failed'), ...invalid}));
        await expect(f.adapter.search(index, {})).rejects.toMatchObject({statusCode: 503});
        expect(f.closed).toEqual(['pit-failed']); expect(f.stats().released).toBe(1);
    });

    test('an index recreated under the same name cannot inherit its UUID lease', async () => {
        const f = fixture(); let calls = 0;
        f.native.indices.getSettings = async () => ({[index]: {settings: {'index.uuid': ++calls === 1 ? 'uuid-original' : 'uuid-recreated'}}});
        await expect(f.adapter.open(index)).rejects.toThrow('identities changed');
        expect(f.closed).toEqual(['pit-open']); expect(f.stats().released).toBe(0);
    });

    test('a lease for a different concrete index UUID is rejected', async () => {
        const f = fixture(); (f.lease as {indices: unknown}).indices = [{name: index, uuid: 'uuid-other'}];
        await expect(f.adapter.open(index)).rejects.toThrow('concrete index generation');
        expect(f.stats().released).toBe(1);
    });

    test('a fork or replay invalidating coverage before response publication returns unavailable', async () => {
        const f = fixture(); let validations = 0;
        f.lease.assertCurrent = async () => {if (++validations === 3) throw Object.assign(new Error('fork generation changed'), {statusCode: 503});};
        await expect(f.adapter.search(index, {})).rejects.toThrow('fork generation changed');
        expect(f.closed).toEqual(['pit-latest']);
    });

    test('malformed source metadata never becomes a successful page', async () => {
        const f = fixture(); let calls = 0;
        f.setNext(async () => ++calls < 4 ? response() : response([{_source: {...encodeActionSequenceStorage(logical()),
            global_sequence: '1'}, fields: {'h45_sequences_v1.version': [1]}, sort: [logical().global_sequence.padStart(20, '0'), 1]}]));
        await expect(f.adapter.search(index, {})).rejects.toThrow('could not be restored');
    });

    test('unsupported sequence aggregations fail before native search', async () => {
        const f = fixture();
        await expect(f.adapter.search(index, {aggs: {maximum: {max: {field: 'global_sequence'}}}})).rejects.toMatchObject({statusCode: 503});
        expect(f.searches).toHaveLength(0);
    });

    test('a borrowed index from another chain is rejected', async () => {
        const f = fixture();
        const adapter = new ActionHistoryAdapter(f.native as unknown as Client, 'another', f.authority);
        await expect(adapter.open(index)).rejects.toThrow('owned index');
        expect(f.closed).toHaveLength(0);
    });

    test('a filtered alias is refused rather than hiding a collision survivor', async () => {
        const f = fixture();
        f.native.indices.resolveIndex = async () => ({indices: [], aliases: [{name: 'read'}] as any, data_streams: []});
        f.native.indices.getAlias = async () => ({[index]: {aliases: {read: {filter: {term: {'act.account': 'alpha'}}}}}});
        await expect(f.adapter.open('read')).rejects.toThrow('Filtered or routed');
    });

    test('cancellation during a pending search still closes its PIT and releases its lease', async () => {
        const f = fixture(), controller = new AbortController();
        const context = await f.adapter.open(index, {signal: controller.signal});
        let began!: () => void;
        const started = new Promise<void>(resolve => {began = resolve;});
        f.setNext(async () => {began(); await new Promise(resolve => setTimeout(resolve, 5)); return response([], 0, 'pit-after-abort');});
        const pending = context.search({}); await started; controller.abort();
        await expect(pending).rejects.toMatchObject({statusCode: 503}); await context.close();
        expect(f.closed).toEqual(['pit-after-abort']); expect(f.stats().released).toBe(1);
    });

    test('closing while a search is in flight aborts it and cleans up its latest rotated ID', async () => {
        const f = fixture(), context = await f.adapter.open(index);
        let began!: () => void; const started = new Promise<void>(resolve => {began = resolve;});
        f.setNext(async () => {began(); await new Promise(resolve => setTimeout(resolve, 5)); return response([], 0, 'pit-during-close');});
        const pending = context.search({}); await started; const closing = context.close();
        await expect(pending).rejects.toMatchObject({statusCode: 503}); await closing; await context.close();
        expect(f.closed).toEqual(['pit-during-close']); expect(f.stats().released).toBe(1);
    });

    test('a second concurrent page cannot race ownership of a rotating PIT', async () => {
        const f = fixture(), context = await f.adapter.open(index);
        let began!: () => void; const started = new Promise<void>(resolve => {began = resolve;});
        let finish!: () => void; const wait = new Promise<void>(resolve => {finish = resolve;});
        f.setNext(async params => {began(); await wait; return params.size === 0 ? response() : response([]);});
        const pending = context.search({}); await started;
        await expect(context.search({})).rejects.toThrow('already processing'); finish(); await pending; await context.close();
    });

    test('an incomplete numeric count cannot be mistaken for exact membership', async () => {
        const f = fixture(); let calls = 0;
        f.setNext(async () => ++calls < 4 ? response() : ({...response([], 7), hits: {total: {value: 7, relation: 'gte'}, hits: []}}));
        const context = await f.adapter.open(index);
        try {await expect(context.count()).rejects.toThrow('count was not returned');} finally {await context.close();}
    });

    test('source pruning cannot hide indexed exact metadata and turn it into legacy fallback', async () => {
        const f = fixture(); let calls = 0;
        f.setNext(async () => ++calls < 4 ? response() : response([{_source: {global_sequence: '1'},
            fields: {'h45_sequences_v1.version': [1]}, sort: ['00000000000000000001', 1]}]));
        await expect(f.adapter.search(index, {})).rejects.toThrow('indexed sequence namespace disagree');
    });
});

describe('logical source projection after complete restoration', () => {
    test.each([
        ['global_sequence', {global_sequence: logical().global_sequence}],
        [{includes: ['receipts.recv_sequence']}, {receipts: [{recv_sequence: '9223372036854775808'}]}],
        [{includes: ['act.*'], excludes: ['*.description']}, {act: {account: 'alpha', name: 'run',
            data: {global_sequence: 1.25, retained: false, nested: [null, 0, {}]}}}],
        [false, undefined],
        [{includes: ['not-present']}, {}]
    ])('preserves values and source selection %j', (filter, expected) => {
        expect(projectActionSource(logical(), filter as estypes.SearchRequest['_source'])).toEqual(expected);
    });

    test('special opaque keys cannot modify the result prototype', () => {
        const source = JSON.parse('{"act":{"data":{"__proto__":{"x":1},"constructor":"opaque"}}}');
        const result = projectActionSource(source, 'act.data');
        expect(JSON.stringify(result)).toBe(JSON.stringify(source));
        expect(Object.getPrototypeOf(result?.act)).toBe(Object.prototype);
        expect(({} as {x?: number}).x).toBeUndefined();
    });
});
