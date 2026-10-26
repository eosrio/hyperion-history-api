import {expect, test} from 'bun:test';
import Fastify from 'fastify';
import {createHash} from 'node:crypto';
import {ProtocolActionConsumer, protectProtocolAction, protocolResponseForCache, validateProtocolCachedResponse,
    revalidateProtocolActionScope} from '../../src/api/helpers/protocol-abi.js';
import {regroupActions} from '../../src/api/helpers/regroup-actions.js';
import {blockId, chain, chainId, clone, nativeAuthorizationFixture, profile} from './protocol-native-authorization-host-fixture.js';

async function fixture(options: {primitive?: string} = {}) {
    // Synthetic protocol/source; every source membership and native grant is issued by the actual host coordinator/readers.
    const value = await nativeAuthorizationFixture({nativeActionInterfaceVersion: 1, mutateRecord(record) {
        const decision = record.observation.status === 'observed' && record.observation.facts.decisions.find(entry => entry.origin.actionOrdinal === 3);
        if (!decision) throw new Error('Expected original independent inline decision');
        Object.assign(decision, {kind: 'native', nativeKind: 'opaque.host-native.v1'});
    }});
    value.faults.changeObserved = (facts: any) => Object.assign(facts.decisions.find((entry: any) => entry.origin.actionOrdinal === 3),
        {kind: 'native', nativeKind: 'opaque.host-native.v1'});
    if (options.primitive !== undefined) {
        value.native.decodeValue = () => options.primitive;
        value.native.encodeValue = (_kind: string, input: unknown) => Buffer.from(input === options.primitive ? '0102' : 'ff', 'hex');
    }
    const app = Fastify({logger: false});
    app.decorate('manager', {chain, conn: {chains: {[chain]: {chain_id: chainId}}}, config: {settings: {es_replicas: 0,
        protocol: {provider: 'extension', package: 'synthetic-host-contract', profileId: profile.profileId}}}});
    app.decorate('elastic', value.client);
    app.decorate('protocolActionConsumer', new ProtocolActionConsumer(app, {id: profile.id,
        provider: value.provider, components: profile.components} as any));
    const reader = value.reader(), view = await reader.open(value.selected.source, value.selected.selectionId);
    async function action(index: number, raw = false) {
        const input = value.selected.inputs[index], decision = await reader.authorize(view, input);
        const protocol = decision.kind === 'native' ? await reader.metadata(decision.grant)
            : await reader.incompleteMetadata(view, input);
        const receipt = {receiver: input.receiver, global_sequence: input.globalSequence, recv_sequence: '18446744073709551615',
            auth_sequence: [], code_sequence: 0, abi_sequence: 4294967295};
        return {block_num: 2, block_id: blockId(2), trx_id: input.transactionId, action_ordinal: input.actionOrdinal,
            creator_action_ordinal: [2, 3].includes(input.actionOrdinal) ? 1 : input.actionOrdinal === 6 ? 5 : 0,
            global_sequence: input.globalSequence, act_digest: 'f'.repeat(64), code_sequence: 0, abi_sequence: 4294967295,
            act: {account: input.account, name: input.name, authorization: [],
                data: raw ? input.rawHex : decision.kind === 'native' ? await reader.decodeValue(decision.grant) : {rawHex: input.rawHex}},
            receipts: [receipt], protocol};
    }
    return {...value, app, action};
}

test('synthetic host API keeps notification membership and independent identical native origins through grouping and derived cache', async () => {
    const source = await fixture();
    try {
        source.faults.decodedValue = {rawHex: '0102', creator: 'unknown'};
        const scope = {}, actions = await Promise.all([source.action(0), source.action(1), source.action(2)]);
        for (const action of actions) await protectProtocolAction(source.app, scope, action);
        const grouped = regroupActions(actions);
        expect(grouped.map(action => action.action_ordinal)).toEqual([1, 3]);
        expect(grouped[0].receipts.map((receipt: any) => receipt.global_sequence)).toEqual(['9007199254740993', '9007199254740994']);
        expect(grouped[1].receipts.map((receipt: any) => receipt.global_sequence)).toEqual(['9007199254740995']);
        expect(grouped[0].act.data).toEqual(grouped[1].act.data);
        await revalidateProtocolActionScope(source.app, scope);
        // The derived body intentionally has no action metadata. Its private capsule retains the producer's complete checked set.
        const cached = await protocolResponseForCache(source.app, scope as any, 'get_creator', {creator: 'unknown', block_num: 2});
        expect(cached._hyperion_protocol_abi_v3.actions).toHaveLength(3);
        const returned = clone(cached);
        expect(await validateProtocolCachedResponse(source.app, {} as any, 'get_creator', returned)).toBe(true);
        expect(returned).toEqual({creator: 'unknown', block_num: 2});
        await source.replaceOwner();
        await expect(validateProtocolCachedResponse(source.app, {} as any, 'get_creator', cached)).rejects.toMatchObject({statusCode: 503});
        expect(source.calls.contract).toBe(0);
    } finally {await source.app.close();}
}, 10000);

test('synthetic host API isolates incomplete origins, keeps raw history, and rejects invented grouped native receipts', async () => {
    const source = await fixture();
    try {
        const incompleteRaw = [];
        for (const index of [4, 5]) {
            const raw = await source.action(index, true);
            await protectProtocolAction(source.app, {}, raw);
            incompleteRaw.push(clone(raw));
            expect(raw.act.data).toBe('04');
            await expect(protectProtocolAction(source.app, {}, raw, {decode: true})).rejects.toMatchObject({statusCode: 503});
            await expect(protectProtocolAction(source.app, {}, await source.action(index))).rejects.toMatchObject({statusCode: 503});
        }
        expect(regroupActions(incompleteRaw)).toHaveLength(2);
        const root = await source.action(0), notify = await source.action(1), inline = await source.action(2);
        root.receipts.push(...clone(notify.receipts));
        await protectProtocolAction(source.app, {}, root);
        expect(root.receipts).toHaveLength(2);
        const changed = clone(root); changed.receipts.push(...inline.receipts);
        await expect(protectProtocolAction(source.app, {}, changed)).rejects.toMatchObject({statusCode: 503});
        await protectProtocolAction(source.app, {}, inline);
        expect(inline.global_sequence).toBe('9007199254740995');
        expect(source.calls.contract).toBe(0);
    } finally {await source.app.close();}
});

test('native response fence rejects awaited sibling mutation before generating any response/cache digest', async () => {
    const source = await fixture();
    try {
        const scope = {}, [action, sibling] = await Promise.all([source.action(0), source.action(2)]);
        await protectProtocolAction(source.app, scope, action); delete (action as any).protocol;
        let mutations = 0;
        source.faults.onEncode = () => {action.act.data = {rawHex: 'ff'}; mutations++;};
        await protectProtocolAction(source.app, scope, sibling); delete source.faults.onEncode;
        delete (sibling as any).protocol;
        expect(mutations).toBeGreaterThan(0); expect(sibling.act.data).toEqual({rawHex: '0102'});
        await expect(protocolResponseForCache(source.app, scope as any, 'get_actions', {actions: [action, sibling]}))
            .rejects.toMatchObject({statusCode: 503, code: 'native_output_mismatch'});
    } finally {await source.app.close();}
});

test('native response fence checks detached public values, derived fields and cache bodies independently of private checked values', async () => {
    const source = await fixture();
    try {
        source.faults.decodedValue = {rawHex: '0102', creator: 'unknown'};
        const scope = {}, action = await source.action(0);
        await protectProtocolAction(source.app, scope, action); delete (action as any).protocol;
        const changed = clone(action); changed.act.data = {rawHex: 'ff'};
        await expect(protocolResponseForCache(source.app, scope as any, 'get_actions', {actions: [changed]}))
            .rejects.toMatchObject({statusCode: 503, code: 'native_output_mismatch'});
        await expect(protocolResponseForCache(source.app, scope as any, 'get_creator', {creator: 'mallory', block_num: 2}))
            .rejects.toMatchObject({statusCode: 503, code: 'native_output_mismatch'});
        const cached = await protocolResponseForCache(source.app, scope as any, 'get_actions', {actions: [action]});
        // Separate semantic control: refresh ordinary hashes after a body edit. The awaited-sibling regression above edits no hashes/Redis.
        cached.actions[0].act.data = {rawHex: 'ff'};
        const capsule = cached._hyperion_protocol_abi_v3;
        const {_hyperion_protocol_abi_v3, ...body} = cached;
        capsule.bodySha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        capsule.proofSha256 = createHash('sha256').update(JSON.stringify([capsule.schemaVersion, capsule.bodySha256,
            capsule.actions, capsule.nodeResponse === true])).digest('hex');
        await expect(validateProtocolCachedResponse(source.app, {} as any, 'get_actions', cached))
            .rejects.toMatchObject({statusCode: 503, code: 'native_output_mismatch'});
        expect(action.act.data).toEqual({rawHex: '0102', creator: 'unknown'});
    } finally {await source.app.close();}
});

test('native output allows only the explicit existing noBinary renderer and exact raw hex presentation', async () => {
    const source = await fixture();
    try {
        source.faults.decodedValue = {rawHex: '0102', payload: 'p'.repeat(600)};
        const scope = {}, action = await source.action(0);
        await protectProtocolAction(source.app, scope, action, {noBinary: true}); delete (action as any).protocol;
        (action.act.data as any).payload = 'p'.repeat(32) + '...';
        const cached = await protocolResponseForCache(source.app, scope as any, 'get_actions', {actions: [action]});
        expect(await validateProtocolCachedResponse(source.app, {query: {noBinary: true}} as any, 'get_actions', clone(cached))).toBe(true);
        await expect(validateProtocolCachedResponse(source.app, {query: {noBinary: false}} as any, 'get_actions', clone(cached)))
            .rejects.toMatchObject({statusCode: 503});
        const simple = {block: 2, transaction_id: action.trx_id, contract: 'unknown', action: 'dispatch', actors: '',
            notified: 'unknown', data: action.act.data};
        const simpleCache = await protocolResponseForCache(source.app, scope as any, 'get_actions', {simple_actions: [simple]});
        expect(await validateProtocolCachedResponse(source.app, {query: {noBinary: true}} as any, 'get_actions', simpleCache)).toBe(true);
        (action.act.data as any).payload = 'unapproved renderer';
        await expect(protocolResponseForCache(source.app, scope as any, 'get_actions', {actions: [action]})).rejects.toMatchObject({statusCode: 503});
        const rawScope = {}, raw = await source.action(0, true);
        await protectProtocolAction(source.app, rawScope, raw, {encoding: true}); delete (raw as any).protocol;
        const rawCache = await protocolResponseForCache(source.app, rawScope as any, 'get_actions', {actions: [raw]});
        expect(await validateProtocolCachedResponse(source.app, {} as any, 'get_actions', rawCache)).toBe(true);
        expect(rawCache.actions[0].act.data).toBe('0102');
    } finally {await source.app.close();}
});

test('native output keeps hex-looking decoded strings opaque and catches their changed public values', async () => {
    const source = await fixture({primitive: 'ab'});
    try {
        const scope = {}, action = await source.action(0);
        await protectProtocolAction(source.app, scope, action); delete (action as any).protocol;
        const cached = await protocolResponseForCache(source.app, scope as any, 'get_actions', {actions: [action]});
        expect(await validateProtocolCachedResponse(source.app, {} as any, 'get_actions', cached)).toBe(true);
        expect(cached.actions[0].act.data).toBe('ab');
        action.act.data = 'ff';
        await expect(protocolResponseForCache(source.app, scope as any, 'get_actions', {actions: [action]}))
            .rejects.toMatchObject({statusCode: 503, code: 'native_output_mismatch'});
    } finally {await source.app.close();}
});

test('native simple and block-trace outputs preserve independent identical origins with different grouped notifications', async () => {
    const source = await fixture();
    try {
        const scope = {}, rows = await Promise.all([source.action(0), source.action(1), source.action(2)]);
        for (const row of rows) await protectProtocolAction(source.app, scope, row);
        const grouped = regroupActions(rows);
        expect(grouped.map(row => row.action_ordinal)).toEqual([1, 3]);
        for (const row of grouped) delete (row as any).protocol;
        const simple = grouped.map(row => ({block: 2, transaction_id: row.trx_id, contract: row.act.account, action: row.act.name,
            actors: '', notified: row.receipts.map((receipt: any) => receipt.receiver).join(','), data: row.act.data}));
        expect(simple.map(row => row.notified)).toEqual(['unknown,notified', 'unknown']);
        const cached = await protocolResponseForCache(source.app, scope as any, 'get_actions', {simple_actions: simple});
        expect(await validateProtocolCachedResponse(source.app, {} as any, 'get_actions', cached)).toBe(true);
        expect(cached.simple_actions).toHaveLength(2);
        const trace = {number: 2, transactions: [{id: grouped[0].trx_id, actions: grouped.flatMap(row =>
            row.receipts.map((receipt: any) => ({receiver: receipt.receiver, account: row.act.account, action: row.act.name,
                authorization: [], data: row.act.data})))}]};
        const traceCache = await protocolResponseForCache(source.app, scope as any, 'get_block', trace);
        expect(await validateProtocolCachedResponse(source.app, {} as any, 'get_block', traceCache)).toBe(true);
        expect(traceCache.transactions[0].actions.map((action: any) => action.receiver)).toEqual(['unknown', 'notified', 'unknown']);
    } finally {await source.app.close();}
});
