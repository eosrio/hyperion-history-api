import {afterEach, expect, test} from 'bun:test';
import {createServer, type Server} from 'node:http';
import {hydrateActions} from '../../src/api/helpers/archive-hydration.js';
import {ArchiveRegistry} from '../../src/api/helpers/archive-registry.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
}))); });

async function archive(reply: (items: any[]) => any[]) {
    const requests: any[][] = [];
    const server = createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const items = JSON.parse(raw);
        requests.push(items);
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(JSON.stringify({actions: reply(items)}));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port');
    return {requests, registry: new ArchiveRegistry({enabled: true, timeout_ms: 1000,
        entries: [{url: `http://127.0.0.1:${address.port}`, first_block: 1, last_block: 10}]})};
}

function hit(sequence: number | string) {
    return {_source: {block_num: 2, global_sequence: sequence,
        act: {account: 'eosio.token', name: 'transfer', data: undefined as unknown}}};
}
const found = (item: any) => ({...item, account: 'eosio.token', name: 'transfer', found: true,
    data: {sequence: item.global_sequence, quantity: '1.0000 EOS'}});

test('archive requests and matching payloads retain neighboring exact uint64 identities', async () => {
    const f = await archive(items => items.map(found));
    const values = ['1', '9007199254740992', '9007199254740993', '9223372036854775808', '18446744073709551615'];
    const hits = values.map(hit);
    await hydrateActions({} as any, hits, f.registry);
    expect(f.requests).toEqual([values.map(global_sequence => ({block_num: 2, global_sequence}))]);
    expect(hits.map(value => value._source.act.data)).toEqual(values.map(sequence => ({sequence, quantity: '1.0000 EOS'})));
});

test('safe legacy sources are sent as text and safe legacy echoes remain compatible', async () => {
    const f = await archive(items => items.map(item => ({...found(item), global_sequence: 7})));
    const hits = [hit(7)];
    await hydrateActions({} as any, hits, f.registry);
    expect(f.requests[0][0].global_sequence).toBe('7');
    expect(hits[0]._source.act.data).toEqual({sequence: '7', quantity: '1.0000 EOS'});
});

for (const [name, alter] of [
    ['different sequence', (entries: any[]) => [{...entries[0], global_sequence: '9007199254740992'}]],
    ['unsafe numeric echo', (entries: any[]) => [{...entries[0], global_sequence: 9007199254740992}]],
    ['different block', (entries: any[]) => [{...entries[0], block_num: 3}]],
    ['different contract', (entries: any[]) => [{...entries[0], account: 'wrong'}]],
    ['different action', (entries: any[]) => [{...entries[0], name: 'wrong'}]],
    ['noncanonical echo', (entries: any[]) => [{...entries[0], global_sequence: '09007199254740993'}]],
    ['missing identity', (entries: any[]) => [{data: entries[0].data, found: true}]]
] as const) {
    test(`archive hydration leaves the hit unchanged for ${name}`, async () => {
        const f = await archive(items => alter(items.map(found)));
        const hits = [hit('9007199254740993')];
        await hydrateActions({} as any, hits, f.registry);
        expect(hits[0]._source.act.data).toBeUndefined();
    });
}

test('a reordered equal-length archive batch cannot attach another occurrence payload', async () => {
    const f = await archive(items => items.map(found).reverse());
    const hits = [hit('9007199254740992'), hit('9007199254740993')];
    await hydrateActions({} as any, hits, f.registry);
    expect(hits.every(value => value._source.act.data === undefined)).toBe(true);
});

test('unsafe or malformed source identifiers are never sent to an archive', async () => {
    const f = await archive(items => items.map(found));
    const hits = [hit(9007199254740992), hit('01'), hit('18446744073709551616')];
    await hydrateActions({} as any, hits, f.registry);
    expect(f.requests).toHaveLength(0);
    expect(hits.every(value => value._source.act.data === undefined)).toBe(true);
});
