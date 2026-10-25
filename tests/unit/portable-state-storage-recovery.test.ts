import {expect, test} from 'bun:test';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {snapshotWireStorage, qualifyWireStorageRestart} from '../../scripts/qualification/portable-state-storage-recovery.mjs';
import {parsePortableWorkerArguments, validatePortableWorkerOptions} from '../../scripts/qualification/portable-state-worker.ts';
import {createWireBrokerRecoveryControl, wireBrokerRecoveryDigest} from '../../scripts/qualification/portable-state-broker-recovery.mjs';

function fixture(): any {
    const run = 'abcdef012345', chain = 'hyp-p191-' + run, index = chain + '-history-source-admission-v1';
    const target = chain + '-action-v1-000001', recordId = 'h45actionhandoff1:' + 'c'.repeat(64);
    const document = {kind: 'manifest', bundle_id: recordId, members: ['original']};
    const core = {run, clusterName: 'hyperion-es198-' + run, clusterUuid: 'original-cluster', nodes: ['a', 'b', 'witness'].map((suffix, index) =>
        ({name: 'hyp-es955-replicas-' + run + '-' + suffix, role: index < 2 ? 'data' : 'master'}))};
    const held = {recordId, request: {index, document}, attempt: {binding: {targetName: target, targetUuid: 'original-target'}}};
    const settings = Object.fromEntries([index, target].map(name => [name, {settings: {'index.uuid': name === target ? 'original-target' : 'original-manifest',
        'index.number_of_replicas': '1', 'index.translog.durability': 'request'}}]));
    const nodes = {_nodes: {total: 3, successful: 3, failed: 0},
        nodes: Object.fromEntries(core.nodes.map((node: any, index: number) => ['node' + index, {name: node.name}]))};
    const shard = {total: 2, successful: 2, failed: 0}, calls: any[] = [];
    const search = () => ({timed_out: false, _shards: {total: 1, successful: 1, failed: 0},
        hits: {total: {value: 1, relation: 'eq'}, hits: [{_index: index, _id: recordId, _source: structuredClone(document)}]}});
    const replies = {identity: {cluster_name: core.clusterName, cluster_uuid: 'original-cluster', version: {number: '9.5.5'}},
        settings, nodes, refresh: {_shards: shard}, searches: [search(), search()]};
    const es = {info: async () => {calls.push(['info']); return replies.identity;},
        indices: {getSettings: async (options: any) => {calls.push(['settings', options]); return replies.settings;},
            refresh: async (options: any) => {calls.push(['refresh', options]); return replies.refresh;}},
        nodes: {info: async () => {calls.push(['nodes']); return replies.nodes;}},
        search: async (options: any) => {calls.push(['search', options]); return replies.searches[calls.filter(row => row[0] === 'search').length - 1];}};
    return {core, held, es, calls, replies, index, target};
}

test('combined replica and broker restart requires explicit native authority and excludes other faults', () => {
    const args = ['state', 'plan', 'output'], authorityRpc = 'http://127.0.0.1:58271';
    expect(parsePortableWorkerArguments([...args, '--native', '--authority-rpc', authorityRpc, '--broker-storage-recovery']).options)
        .toEqual({native: true, authorityRpc, brokerRecovery: true, storageRecovery: true});
    for (const options of [{storageRecovery: true}, {native: true, authorityRpc, storageRecovery: true},
        {native: true, authorityRpc, brokerRecovery: true, storageRecovery: 'true'},
        ...['profile', 'workerRecovery', 'masterRecovery', 'readerRecovery'].map(key =>
            ({native: true, authorityRpc, brokerRecovery: true, storageRecovery: true, [key]: true}))])
        expect(() => validatePortableWorkerOptions(options)).toThrow();
    expect(() => parsePortableWorkerArguments([...args, '--broker-storage-recovery'])).toThrow();
});

test('storage census rejects an unrelated index before any client call', async () => {
    for (const mutate of [(v: any) => {v.held.request.index = 'incumbent-history-source-admission-v1';},
        (v: any) => {v.held.attempt.binding.targetName = v.index.replace('-history-source-admission-v1', '-action-unrelated');},
        (v: any) => {v.core.run = '../foreign';}]) {
        const value = fixture(); mutate(value);
        await expect(snapshotWireStorage(value.es, value.core, value.held)).rejects.toThrow();
        expect(value.calls).toEqual([]);
    }
});

test('storage census requires original identities and the original manifest on both configured copies', async () => {
    const value = fixture(), result = await snapshotWireStorage(value.es, value.core, value.held);
    expect(result.clusterUuid).toBe('original-cluster'); expect(result.indices[value.target].uuid).toBe('original-target');
    expect(result.copies.map((copy: any) => copy.preference)).toEqual(['_only_nodes:node0', '_only_nodes:node1']);
    for (const mutate of [
        (v: any) => {v.replies.identity.cluster_name = 'foreign';},
        (v: any) => {v.replies.identity.cluster_uuid = 'replacement-cluster';},
        (v: any) => {v.replies.settings[v.target].settings['index.uuid'] = 'replacement-target';},
        (v: any) => {v.replies.settings[v.index].settings['index.number_of_replicas'] = '0';},
        (v: any) => {v.replies.settings[v.target].settings['index.translog.durability'] = 'async';},
        (v: any) => {v.replies.nodes.nodes.node2.name = 'foreign-witness';},
        (v: any) => {v.replies.refresh._shards.failed = 1; v.replies.refresh._shards.successful = 1;},
        (v: any) => {v.replies.searches[1].timed_out = true;},
        (v: any) => {v.replies.searches[1]._shards.failed = 1; v.replies.searches[1]._shards.successful = 0;},
        (v: any) => {v.replies.searches[1].hits.hits[0]._source.members = ['different'];},
        (v: any) => {v.replies.searches[1].hits.hits[0]._index = v.target;}
    ]) {const changed = fixture(); mutate(changed); await expect(snapshotWireStorage(changed.es, changed.core, changed.held)).rejects.toThrow();}
});

test('Elasticsearch default REQUEST and explicit request keep the same durable-write requirement', async () => {
    const value = fixture();
    delete value.replies.settings[value.index].settings['index.translog.durability'];
    value.replies.settings[value.index].defaults = {'index.translog.durability': 'REQUEST'};
    const result = await snapshotWireStorage(value.es, value.core, value.held);
    expect(result.indices[value.index].durability).toBe('request');
    expect(result.indices[value.index].rawDurability).toBe('REQUEST');
    expect(result.indices[value.target].rawDurability).toBe('request');
    for (const durability of ['ASYNC', 'async', '', ' request ']) {
        const changed = fixture();
        changed.replies.settings[changed.index].settings['index.translog.durability'] = durability;
        await expect(snapshotWireStorage(changed.es, changed.core, changed.held)).rejects.toThrow();
    }
});

test('a changed held response or an early ACK rejects before issuing a replica restart', async () => {
    for (const mutation of ['response', 'ack']) {
        const value = fixture(), output = realpathSync(mkdtempSync(join(tmpdir(), 'h45-storage-hold-')));
        const chain = 'hyp-p191-' + value.core.run, configFile = join(output, 'chain.json');
        const chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d';
        const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
        writeFileSync(configFile, JSON.stringify({settings: {chain, protocol: {profileId}}}));
        const {control} = createWireBrokerRecoveryControl({output, configFile, chain,
            source: {chainId, profileId, endBlock: 1480, records: Array.from({length: 33}, () => ({blockId: 'b'.repeat(64)}))},
            frameSha256: 'f'.repeat(64)});
        const admissionId = 'h45actionadmission1:' + 'd'.repeat(64), scope = {id: 'original-root', state: 'open', pendingOperations: 0};
        const held = {...value.held, schemaVersion: 1, runId: control.runId, controlSha256: wireBrokerRecoveryDigest(control),
            role: 'ds_pool_worker', source: {chainId, blockNum: 33, blockId: control.blockId}, originalFrameSha256: control.frameSha256,
            admissionId, traceOrdinal: 0, payloadSha256: 'e'.repeat(64), redelivered: false, pid: process.pid, parentPid: process.ppid,
            attempt: {attemptId: 'original-attempt', mode: 'managed', masterEnd: null, scope,
                binding: {...value.held.attempt.binding, admissionId, traceOrdinal: 0, blockNum: 33, blockId: control.blockId},
                descriptor: {payloadSha256: 'e'.repeat(64)}}, scope, method: 'create',
            request: {...value.held.request, id: value.held.recordId, wait_for_active_shards: 'all', pipeline: '_none', refresh: false},
            response: {_id: value.held.recordId, _index: value.index, result: 'created', _seq_no: 1, _shards: {total: 2, successful: 2, failed: 0}}};
        const heldFile = join(output, 'broker-recovery/held-receipt.json'), eventsFile = join(output, `broker-recovery/process-${process.pid}.jsonl`);
        const rows = [{event: 'handoff-receipt-held', runId: control.runId, pid: process.pid, attemptId: 'original-attempt', sequence: 1}];
        const saveEvents = () => writeFileSync(eventsFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
        writeFileSync(heldFile, JSON.stringify(held)); saveEvents();
        const originalInfo = value.es.info;
        value.es.info = async () => {
            if (mutation === 'response') writeFileSync(heldFile, JSON.stringify({...held, response: {...held.response, _seq_no: 2}}));
            else {rows.push({...rows[0], event: 'ack-sent', sequence: 2}); saveEvents();}
            return originalInfo();
        };
        let mutations = 0;
        try {
            await expect(qualifyWireStorageRestart({core: value.core, es: value.es, control,
                docker: () => {mutations++; throw Error('unexpected Docker call');}, replay: {assertThrough: (block: number) => expect(block).toBe(33)},
                wait: () => {throw Error('unexpected storage restart wait');}})).rejects.toThrow(mutation === 'response' ? 'original held receipt changed' : 'original return settled');
            expect(mutations).toBe(0);
        } finally {
            expect(dirname(output)).toBe(realpathSync(tmpdir())); expect(basename(output).startsWith('h45-storage-hold-')).toBe(true);
            rmSync(output, {recursive: true, force: true});
        }
    }
});
