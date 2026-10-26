/** Resource-free guards for the physical audit; this transport fixture proves no actual Mongo run. */
import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {auditPortablePhysicalMongo, portableMongoAuditLimits, type PortableMongoAuditInput} from '../../scripts/qualification/portable-state-worker-mongo.ts';
import {portableWorkerFaultDefinition} from '../../scripts/qualification/portable-state-worker.ts';

const canonical = (value: any): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const plan = JSON.parse(readFileSync(new URL('../fixtures/portable-state-worker/plan.template.json', import.meta.url), 'utf8'));
// Match the actual source audit shape, including retained evidence outside checkpoint identity.
const source = Array.from({length: 1480}, (_, index) => ({blockNum: index + 1, blockId: (index + 1).toString(16).padStart(64, '0'),
    previousBlockId: index ? index.toString(16).padStart(64, '0') : null, headerPreviousBlockId: index.toString(16).padStart(64, '0'),
    frameSha256: 'a'.repeat(64), frameBytes: 100, timestamp: '2026-10-20T00:00:00.000', producer: 'sysio', applicationRows: []}));

function fixture(through = 1480) {
    const calls: any[] = [], database = 'h45_p191_012345abcdef', backendId = 'p191-012345abcdef', chainId = 'c'.repeat(64);
    const failed = portableWorkerFaultDefinition(plan), definitions = [...plan.definitions, failed];
    const checkpoint = (height: number) => ({blockNum: source[height - 1].blockNum, blockId: source[height - 1].blockId});
    const expectations = definitions.map((definition, index) => ({definition,
        binding: {chainId, backendId, projectionId: definition.id, mappingRevision: definition.mappingRevision,
            abiDeployment: definition.source.abiDeployment, abiSha256: definition.source.abiSha256, generation: String(index + 1).repeat(64)},
        rows: index < 2 ? plan.barriers.find((barrier: any) => barrier.through === through).rows[definition.id] : [],
        checkpoint: checkpoint(index < 2 ? through : 1243), ...(index < 2 ? {} : {failedBlock: {...checkpoint(1244), previousBlockId: checkpoint(1243).blockId}})}));
    const collections = expectations.map(expected => 'h45_projection_r_' + hash(expected.binding));
    const documents = new Map(collections.map((name, index) => [name,
        expectations[index].rows.map((row: any) => ({_id: row.key, value: structuredClone(row.value)}))]));
    const metadata = expectations.map(expected => ({_id: hash({chainId, projectionId: expected.binding.projectionId}),
        storageVersion: 'h45-portable-mongodb-v1', definition: structuredClone(expected.definition), definitionHash: hash(expected.definition),
        binding: {...expected.binding}, checkpoint: expected.checkpoint, initialized: true, gap: null,
        pending: expected.failedBlock ? {block: expected.failedBlock, digest: null, reason: 'Required source field is missing'} : null,
        receipts: [{...expected.checkpoint, digest: 'a'.repeat(64)}]})).sort((a, b) => a._id < b._id ? -1 : 1);
    const namespaces: any[] = ['h45_projection_metadata', ...collections].map(name => ({name, type: 'collection',
        options: {collation: {locale: 'simple'}}, info: {uuid: name}}));
    const state: any = {metadata, namespaces, documents, afterMutation: undefined, helloAfter: undefined, largeBuild: false};
    let metadataReads = 0, hellos = 0;
    const cursor = (items: any[]) => {
        let maximum = Infinity;
        const value = {sort(options: any) {calls.push(['sort', options]); return value;},
            limit(count: number) {maximum = count; calls.push(['limit', count]); return value;},
            async close() {calls.push(['close']);}, async *[Symbol.asyncIterator]() {for (const item of items.slice(0, maximum)) yield structuredClone(item);}};
        return value;
    };
    const session = {startTransaction(options: any) {calls.push(['startTransaction', options]);}, async abortTransaction() {calls.push(['abortTransaction']);}, async endSession() {calls.push(['endSession']);}};
    const client: any = {options: {directConnection: true, replicaSet: 'h45rs_' + '1'.repeat(32), hosts: [{host: '127.0.0.1', port: 35000}]},
        startSession(options: any) {calls.push(['startSession', options]); return session;},
        db(name: string, options: any) {calls.push(['db', name, options]); return {
            admin() {return {async command(command: any, options: any) {calls.push(['command', command, options]);
                if (command.hello) {hellos++; return {setName: client.options.replicaSet, isWritablePrimary: true,
                    me: '127.0.0.1:27017', primary: '127.0.0.1:27017', topologyVersion: {processId: hellos === 2 && state.helloAfter ? state.helloAfter : 'original-process'}, maxWireVersion: 25};}
                return {version: '8.0.34', gitVersion: 'fixture', ...(state.largeBuild ? {noise: 'x'.repeat(portableMongoAuditLimits.documentBytes)} : {})};}};},
            listCollections(filter: any, options: any) {calls.push(['listCollections', filter, options]); return cursor(state.namespaces);},
            collection(name: string) {return {find(filter: any, options: any) {calls.push(['find', name, filter, options]);
                if (name === 'h45_projection_metadata') {metadataReads++; if (metadataReads === 3) state.afterMutation?.(state); return cursor(state.metadata);}
                return cursor(state.documents.get(name) ?? []);},
                async countDocuments(filter: any, options: any) {calls.push(['countDocuments', name, filter, options]); return (state.documents.get(name) ?? []).length;}};},
        };}};
    const input: PortableMongoAuditInput = {client, database, backendId, chainId, replicaSet: client.options.replicaSet,
        version: '8.0.34', through, source, expectations};
    return {input, state, calls, collections};
}

test('physical audit reads exact stored documents against original plan rows and retains independent insert/update/delete expectations', async () => {
    for (const through of [1244, 1480]) {
        const value = fixture(through), originalSource = structuredClone(value.input.source), report = await auditPortablePhysicalMongo(value.input);
        expect(value.input.source).toEqual(originalSource); expect(value.input.source[0]).toHaveProperty('frameSha256');
        expect(report.readOnly).toBe(true); expect(report.projections.map(projection => projection.count)).toEqual([1, 2, 0]);
        expect(report.projections[0].documents[0].value.next).toBe(through === 1244 ? '5' : '9');
        expect(report.projections[1].documents.map((row: any) => row.value.id)).toEqual(through === 1244 ? ['1', '2'] : ['3', '4']);
        expect(report.metadataBefore).toEqual(report.metadataSnapshot); expect(report.metadataBefore).toEqual(report.metadataAfter);
        expect(report.projections[2].checkpoint.blockNum).toBe(1243); expect(report.projections[2].documents).toEqual([]);
        expect(report.bytes).toBeLessThanOrEqual(portableMongoAuditLimits.totalBytes);
        expect(value.calls.filter(call => call[0] === 'command').map(call => Object.keys(call[1])[0])).toEqual(['hello', 'buildInfo', 'hello', 'buildInfo']);
        expect(value.calls.some(call => call[0] === 'abortTransaction')).toBe(true); expect(value.calls.some(call => call[0] === 'endSession')).toBe(true);
        for (const call of value.calls.filter(call => ['find', 'countDocuments'].includes(call[0]))) expect(call[3].collation).toEqual({locale: 'simple'});
    }
});

test('physical audit rejects foreign namespace, backend, chain, loopback target and excessive row scope before IO', async () => {
    for (const mutate of [
        (v: any) => {v.input.database = 'production';}, (v: any) => {v.input.backendId = 'other-backend';},
        (v: any) => {v.input.expectations[0].binding.chainId = 'f'.repeat(64);},
        (v: any) => {v.input.client.options.hosts[0].host = 'external.example';},
        (v: any) => {v.input.expectations[0].rows = Array.from({length: 257}, (_, key) => ({key: String(key), value: {}}));},
    ]) {const value = fixture(); mutate(value); await expect(auditPortablePhysicalMongo(value.input)).rejects.toThrow(); expect(value.calls).toEqual([]);}
});

test('physical audit detects stale generation, unplanned collections, extra/deleted rows and wrong original values', async () => {
    for (const mutate of [
        (v: any) => {v.state.metadata[0].binding.generation = 'f'.repeat(64);},
        (v: any) => {v.state.namespaces.push({name: 'h45_projection_r_foreign', type: 'collection', options: {}});},
        (v: any) => {v.state.namespaces[1].options.collation.locale = 'en';},
        (v: any) => {v.state.documents.get(v.collections[0])[0].value.next = '5';},
        (v: any) => {v.state.documents.get(v.collections[1])[0].value.id = '1';},
        (v: any) => {v.state.documents.get(v.collections[1]).push({_id: 'deleted-key', value: {id: '2'}});},
        (v: any) => {v.state.documents.get(v.collections[2]).push({_id: 'invalid-effects', value: {value: 'untrusted'}});},
        (v: any) => {v.state.metadata[0].extra = 'unexpected metadata';},
        (v: any) => {v.state.documents.get(v.collections[0])[0].extra = 'unexpected physical field';},
        (v: any) => {v.state.largeBuild = true;},
    ]) {const value = fixture(); mutate(value); await expect(auditPortablePhysicalMongo(value.input)).rejects.toThrow();}
});

test('physical audit rejects binding/checkpoint or server changes while the original source is held', async () => {
    const moved = fixture(); moved.state.afterMutation = (state: any) => {state.metadata[0].checkpoint = source[1478];};
    await expect(auditPortablePhysicalMongo(moved.input)).rejects.toThrow('changed during held audit');
    const restarted = fixture(); restarted.state.helloAfter = 'different-process';
    await expect(auditPortablePhysicalMongo(restarted.input)).rejects.toThrow('server identity changed');
});
