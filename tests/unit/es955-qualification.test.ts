import {describe, expect, it} from 'bun:test';
import {assertBulkAcknowledged, assertIdentity, assertOwner, percentile, syntheticDocument, validateOptions,
    type Options} from '../../scripts/qualification/es955.ts';

const valid: Options = {url: 'http://127.0.0.1:56199', clusterName: 'hyperion-es198-test',
    clusterUuid: '_JnQI3_-Rx6hioLpSKM_rw', prefix: 'hyp-es955-abcdef123456', output: 'result.json', transport: 'http', documents: 2000};

describe('Elasticsearch qualification mutation guards', () => {
    it('accepts explicit IPv4 and IPv6 loopback namespaces', () => {
        expect(validateOptions({...valid}).url).toBe(valid.url);
        expect(validateOptions({...valid, url: 'http://[::1]:56199'}).url).toBe('http://[::1]:56199');
    });
    it('rejects remote, DNS, implicit/default ports, credentials and alternate paths', () => {
        for (const url of ['http://192.168.1.1:56199', 'http://localhost:56199', 'http://127.0.0.1',
            'http://127.0.0.1:9200', 'http://user:pass@127.0.0.1:56199',
            'http://127.0.0.1:56199/prod', 'http://127.0.0.1:56199/?x=y', 'https://127.0.0.1:56199']) {
            expect(() => validateOptions({...valid, url})).toThrow();
        }
    });
    it('rejects wildcards, ordinary namespaces, and unbounded work', () => {
        for (const prefix of ['*', 'wax-action', 'hyp-es955-abc*', 'hyp-es955-a', 'hyp-es955-ABCDEFGH']) {
            expect(() => validateOptions({...valid, prefix})).toThrow();
        }
        expect(() => validateOptions({...valid, clusterName: 'production'})).toThrow();
        for (const documents of [0, 999, 9001, 10000, NaN, 1000.5]) {
            expect(() => validateOptions({...valid, documents})).toThrow();
        }
        expect(validateOptions({...valid, documents: 9000}).documents + 500 + 128).toBeLessThan(10000);
    });
    it('requires exact server version and cluster identity', () => {
        const info = {cluster_name: valid.clusterName, cluster_uuid: valid.clusterUuid,
            version: {number: '9.5.5'}, tagline: 'You Know, for Search'};
        expect(() => assertIdentity(info, valid)).not.toThrow();
        for (const changed of [{cluster_name: 'hyperion-es198-another'}, {cluster_uuid: 'different'},
            {version: {number: '9.5.6'}}, {tagline: 'proxy'}]) {
            expect(() => assertIdentity({...info, ...changed}, valid)).toThrow();
        }
    });
    it('will not delete an index based on its name alone', () => {
        const index = `${valid.prefix}-a`;
        expect(() => assertOwner({[index]: {mappings: {_meta: {hyperion_es955_owner: 'owner'}}}}, index, 'owner')).not.toThrow();
        for (const mapping of [{}, {[index]: {mappings: {}}}, {[index]: {mappings: {_meta: {hyperion_es955_owner: 'other'}}}}]) {
            expect(() => assertOwner(mapping, index, 'owner')).toThrow();
        }
    });
});

describe('Elasticsearch qualification exact-work oracle', () => {
    const expected = [{index: `${valid.prefix}-a`, id: '1'}];
    const success = () => ({errors: false, items: [{index: {status: 201, _index: expected[0].index, _id: '1', result: 'created'}}]});
    it('accepts only the complete ordered acknowledgement of newly created documents', () => {
        expect(() => assertBulkAcknowledged(success(), expected)).not.toThrow();
        for (const response of [{...success(), errors: true}, {...success(), items: []},
            {...success(), items: [{index: {...success().items[0].index, _id: '2'}}]},
            {...success(), items: [{index: {...success().items[0].index, _index: 'other'}}]},
            {...success(), items: [{index: {...success().items[0].index, result: 'updated'}}]},
            {...success(), items: [{index: {...success().items[0].index, status: 429}}]}]) {
            expect(() => assertBulkAcknowledged(response, expected)).toThrow();
        }
    });
    it('produces independent deterministic account, action and time predicates', () => {
        const odd = syntheticDocument(3), even = syntheticDocument(2);
        expect(odd.global_sequence).toBe(3);
        expect(odd.act.account).toBe('eosio.token');
        expect(odd.notified).toEqual(['alice']);
        expect(even.act.name).toBe('logmint');
        expect(even.notified).toEqual(['bob']);
        expect(Date.parse(odd['@timestamp']) - Date.parse(even['@timestamp'])).toBe(1000);
        expect(odd.act.name).toBe('logmint');
        expect(syntheticDocument(1).act.name).toBe('transfer');
        expect(syntheticDocument(4).act.account).toBe('atomicassets');
        expect(syntheticDocument(4).act.name).toBe('transfer');
    });
    it('uses nearest-rank percentiles and does not invent missing samples', () => {
        expect(percentile([], .95)).toBeNull();
        expect(percentile([5, 1, 3, 2, 4], .5)).toBe(3);
        expect(percentile([5, 1, 3, 2, 4], .95)).toBe(5);
    });
});
