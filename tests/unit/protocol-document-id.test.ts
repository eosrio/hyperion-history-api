import {describe, expect, it} from 'bun:test';
import {EventEmitter} from 'node:events';
import {protocolDocumentIds, protocolStateKey} from '../../src/indexer/helpers/protocol-document-id.js';
import {ElasticRoutes} from '../../src/indexer/helpers/elastic-routes.js';

function record() {
    return {block_num: 42, block_id: 'b'.repeat(64), code: 'contract', table: 'rows', primary_key: 'a'.repeat(100_000),
        present: 1, protocol: {id: 'test-protocol', profileId: 'profile-v1', logicalIdentity: 'compound:α:' + 'ab'.repeat(50_000),
            record: {keyHex: 'ab'.repeat(50_000)}, rawHex: '00',
            source: {chainId: 'a'.repeat(64), blockId: 'b'.repeat(64), blockNum: 42, ordinal: 7, abiDeployment: 'abi-1'}}};
}

describe('protocol history physical IDs', () => {
    it('bounds physical IDs while preserving the complete source and compound key', async () => {
        const body = record();
        const expected = protocolDocumentIds(body)!;
        expect(expected.documentId).toMatch(/^h45h1:[0-9a-f]{64}$/);
        expect(expected.primaryKey).toMatch(/^h45k1:[0-9a-f]{64}$/);
        let request: any;
        const routes = new ElasticRoutes({chain: 'test', config: {scaling: {}, settings: {
            index_version: 'v1', index_partition_size: 1000}}, ingestClients: [{bulk: async (input: any) => {
            request = input; return {errors: false, items: [{index: {_id: expected.documentId, status: 201}}]};
        }}]} as any);
        const delivery = {content: Buffer.from(JSON.stringify(body)), fields: {deliveryTag: 1}, properties: {}} as any;
        const acknowledged: unknown[] = [];
        const channel = Object.assign(new EventEmitter(), {ack: (item: unknown) => acknowledged.push(item),
            nack: () => {throw new Error('unexpected retry');}});
        const previous = (ElasticRoutes as any).reportMaxBlock;
        try {
            (ElasticRoutes as any).reportMaxBlock = () => {};
            const count = await new Promise(resolve => routes.routes.delta([delivery], channel as any, resolve));
            expect(count).toBe(1);
            expect(request.operations[0].index._id).toBe(expected.documentId);
            expect(request.operations[1].primary_key).toBe(expected.primaryKey);
            expect(request.operations[1].protocol).toEqual(body.protocol);
            expect(acknowledged).toHaveLength(1);
        } finally {(ElasticRoutes as any).reportMaxBlock = previous;}
    });

    it('keeps retries stable across profile, ABI, payer, decoded value and presence changes', () => {
        const body: any = record(); const first = protocolDocumentIds(body);
        body.protocol.profileId = 'profile-v2'; body.protocol.source.abiDeployment = 'corrected-abi';
        body.payer = 'someone'; body.data = {changed: true}; body.present = 0;
        expect(protocolDocumentIds(body)).toEqual(first);
    });

    it('distinguishes event position and forks while keeping the logical state key stable', () => {
        const base = record(); const first = protocolDocumentIds(base)!;
        for (const change of [
            (body: any) => {body.protocol.source.ordinal++;},
            (body: any) => {body.protocol.source.blockId = body.block_id = 'c'.repeat(64);},
            (body: any) => {body.protocol.source.blockNum = body.block_num = 43;}
        ]) {
            const body = structuredClone(base); change(body); const ids = protocolDocumentIds(body)!;
            expect(ids.documentId).not.toBe(first.documentId); expect(ids.primaryKey).toBe(first.primaryKey);
        }
        for (const change of [
            (body: any) => {body.protocol.logicalIdentity += ':secondary';},
            (body: any) => {body.protocol.id = 'other-protocol';},
            (body: any) => {body.protocol.source.chainId = 'd'.repeat(64);}
        ]) {
            const body = structuredClone(base); change(body); const ids = protocolDocumentIds(body)!;
            expect(ids.documentId).not.toBe(first.documentId); expect(ids.primaryKey).not.toBe(first.primaryKey);
        }
    });

    it('uses length framing and rejects malformed provenance instead of a legacy fallback', () => {
        expect(protocolStateKey('ab', 'a'.repeat(64), 'c')).not.toBe(protocolStateKey('a', 'a'.repeat(64), 'bc'));
        for (const change of [
            (body: any) => {body.block_num++;}, (body: any) => {body.block_id = 'c'.repeat(64);},
            (body: any) => {body.protocol.source.ordinal = -1;}, (body: any) => {body.protocol.source.blockNum = 0;},
            (body: any) => {body.protocol.logicalIdentity = '\ud800';}, (body: any) => {body.protocol = null;}
        ]) {const body = record(); change(body); expect(() => protocolDocumentIds(body)).toThrow();}
        expect(protocolDocumentIds({block_num: 1, code: 'legacy', scope: 'alice', table: 'accounts', primary_key: '1'})).toBeUndefined();
    });

    it('preserves legacy IDs and requeues invalid protocol identities before writing or acknowledging', async () => {
        const previous = (ElasticRoutes as any).reportMaxBlock;
        try {
            (ElasticRoutes as any).reportMaxBlock = () => {};
            for (const malformed of [false, true]) {
                const legacy = {block_num: 42, code: 'legacy', scope: 'alice', table: 'accounts', primary_key: '7'};
                const body = malformed ? record() : legacy;
                if (malformed) (body as any).protocol.source.blockId = 'c'.repeat(64);
                const delivery = {content: Buffer.from(JSON.stringify(body)), fields: {deliveryTag: 1}, properties: {}} as any;
                const acknowledged: unknown[] = [], retried: unknown[] = [];
                const channel = Object.assign(new EventEmitter(), {ack: (item: unknown) => acknowledged.push(item),
                    nack: (item: unknown, all: boolean, requeue: boolean) => {
                        expect(all).toBe(false); expect(requeue).toBe(true); retried.push(item);
                    }});
                let requests = 0;
                const routes = new ElasticRoutes({chain: 'test', config: {scaling: {}, settings: {
                    index_version: 'v1', index_partition_size: 1000}}, ingestClients: [{bulk: async (request: any) => {
                    requests++; expect(request.operations[0].index._id).toBe('42-legacy-alice-accounts-7');
                    expect(request.operations[1]).toEqual(legacy);
                    return {errors: false, items: [{index: {_id: '42-legacy-alice-accounts-7', status: 201}}]};
                }}]} as any);
                const count = await new Promise(resolve => routes.routes.delta([delivery], channel as any, resolve));
                expect(count).toBe(malformed ? 0 : 1); expect(requests).toBe(malformed ? 0 : 1);
                expect(acknowledged).toHaveLength(malformed ? 0 : 1); expect(retried).toHaveLength(malformed ? 1 : 0);
            }
        } finally {(ElasticRoutes as any).reportMaxBlock = previous;}
    });
});
