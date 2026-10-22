import {expect, test} from 'bun:test';
import Fastify from 'fastify';
import {ProtocolActionConsumer, protectProtocolAction, protocolResponseForCache, validateProtocolCachedResponse,
    revalidateProtocolActionScope} from '../../src/api/helpers/protocol-abi.js';
import {regroupActions} from '../../src/api/helpers/regroup-actions.js';
import {blockId, chain, chainId, clone, nativeAuthorizationFixture, profile} from './protocol-native-authorization-host-fixture.js';

async function fixture() {
    // Synthetic protocol/source; every source membership and native grant is issued by the actual host coordinator/readers.
    const value = await nativeAuthorizationFixture({nativeActionInterfaceVersion: 1, mutateRecord(record) {
        const decision = record.observation.status === 'observed' && record.observation.facts.decisions.find(entry => entry.origin.actionOrdinal === 3);
        if (!decision) throw new Error('Expected original independent inline decision');
        Object.assign(decision, {kind: 'native', nativeKind: 'opaque.host-native.v1'});
    }});
    value.faults.changeObserved = (facts: any) => Object.assign(facts.decisions.find((entry: any) => entry.origin.actionOrdinal === 3),
        {kind: 'native', nativeKind: 'opaque.host-native.v1'});
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
