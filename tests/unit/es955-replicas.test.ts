import {describe, expect, it} from 'bun:test';
import {assertNodeOwnership, assertReplicaReceipt, assertTranslogReplay, validateFixture} from '../../scripts/qualification/es955-replicas.ts';

describe('Elasticsearch replica durability evidence', () => {
    it('checks container identity, immutable image, labels and the exact data volume before mutation', () => {
        const node = {containerId: 'owned', name: 'fixture-a', volume: 'fixture-a-data'};
        const inspected = {Id: 'owned', Name: '/fixture-a', Config: {
            Image: 'docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c',
            Labels: {'io.eosrio.qualifier': 'es198-replicas', 'io.eosrio.run': 'test-run'}},
            Mounts: [{Type: 'volume', Name: 'fixture-a-data', Destination: '/usr/share/elasticsearch/data'}]};
        expect(() => assertNodeOwnership(inspected, node, 'test-run')).not.toThrow();
        for (const changed of [{Id: 'other'}, {Name: '/production'}, {Mounts: []},
            {Config: {...inspected.Config, Image: 'elasticsearch:latest'}},
            {Config: {...inspected.Config, Labels: {'io.eosrio.run': 'other'}}}]) {
            expect(() => assertNodeOwnership({...inspected, ...changed}, node, 'test-run')).toThrow();
        }
    });
    it('distinguishes a successful one-copy receipt from two-copy acceptance', () => {
        const receipt = {status: 201, _shards: {total: 2, successful: 1, failed: 0}};
        expect(() => assertReplicaReceipt(receipt, 1)).not.toThrow();
        expect(() => assertReplicaReceipt(receipt, 2)).toThrow();
        expect(() => assertReplicaReceipt({...receipt, _shards: {total: 2, successful: 2, failed: 1}}, 2)).toThrow();
        expect(() => assertReplicaReceipt({...receipt, status: 503}, 1)).toThrow();
    });
    it('requires actual same-store translog replay and no flush before process death', () => {
        const before = {node: 'node-a', uncommitted_operations: 120, flush_before: 0, flush_after: 0};
        const after = {node: 'node-a'};
        const recovery = {stage: 'DONE', type: 'EXISTING_STORE', translog: {recovered: 120}};
        expect(() => assertTranslogReplay(before, after, recovery)).not.toThrow();
        for (const changed of [{uncommitted_operations: 0}, {uncommitted_operations: undefined},
            {uncommitted_operations: NaN}, {flush_after: 1}, {flush_before: undefined}, {flush_after: undefined}]) {
            expect(() => assertTranslogReplay({...before, ...changed}, after, recovery)).toThrow();
        }
        expect(() => assertTranslogReplay(before, {node: 'node-b'}, recovery)).toThrow();
        for (const changed of [{stage: 'INDEX'}, {type: 'PEER'}, {translog: {recovered: 0}}, {translog: {recovered: 1}}, {translog: {}}]) {
            expect(() => assertTranslogReplay(before, after, {...recovery, ...changed})).toThrow();
        }
    });
    it('refuses an incomplete or unrelated fixture before Docker mutation', () => {
        expect(() => validateFixture({run: '*'})).toThrow();
        expect(() => validateFixture({run: '123456789abc', network: 'shared-production'})).toThrow();
    });
});
