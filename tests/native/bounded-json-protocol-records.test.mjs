import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {prepared} from '../unit/portable-state-source-fixture.mjs';
import {boundedCanonicalJson} from '../../build/indexer/helpers/bounded-json.js';
import {protocolImmutableJson} from '../../build/indexer/protocol/immutable-bundle-store.js';

const sha = value => createHash('sha256').update(value).digest('hex');
test('actual captured Wire records retain canonical bytes, fresh frontier reads and source-context identity', async () => {
    const started = performance.now();
    // Existing helper verifies the exact captured Wire genesis/follow-up hashes and uses
    // the installed protocol codec plus actual coordinator/stores. No constructed epochs.
    const p = await prepared();
    const corpus = [];
    for (const [key, entry] of p.memory.documents) {
        const manifest = entry.document;
        if (manifest.kind !== 'manifest') continue;
        const index = key.split('\0')[0];
        const payload = Buffer.concat(manifest.chunk_ids.map(id => {
            const chunk = p.memory.documents.get(p.memory.key(index, id)).document;
            return Buffer.from(chunk.payload, 'base64');
        }));
        assert.equal(payload.length, manifest.byte_length);
        assert.equal(sha(payload), manifest.digest);
        corpus.push({id: manifest.bundle_id, index, manifest, record: JSON.parse(payload), payload});
    }
    corpus.sort((a,b) => a.id.localeCompare(b.id));
    assert(corpus.some(row => row.id.startsWith('h45abicmt1:')));
    assert(corpus.some(row => row.id === p.contextId));
    const expected = corpus.map(row => ({id: row.id, bytes: row.payload.length, sha256: sha(row.payload)}));
    // These records have already been parsed into plain JSON. Native JSON.stringify's
    // property whitelist supplies an independent canonical ordering/escaping oracle.
    for (const row of corpus) {
        const names = new Set(), pending = [row.record];
        while (pending.length) {
            const value = pending.pop();
            if (value && typeof value === 'object') for (const key of Object.keys(value)) {names.add(key); pending.push(value[key]);}
        }
        assert.equal(JSON.stringify(row.record, [...names].sort()), row.payload.toString('utf8'));
    }
    const preparationMs = performance.now() - started;
    const iterations = 12, canonicalStarted = performance.now();
    let canonicalBytes = 0;
    for (let repeat = 0; repeat < iterations; repeat++) for (const row of corpus) {
        const actual = boundedCanonicalJson(row.record);
        assert.equal(actual, row.payload.toString('utf8'));
        assert.equal(protocolImmutableJson(row.record), actual);
        assert.equal(sha(actual), row.manifest.digest);
        canonicalBytes += Buffer.byteLength(actual);
    }
    const canonicalMs = performance.now() - canonicalStarted;
    const commits = corpus.filter(row => row.id.startsWith('h45abicmt1:'));
    const beforeCalls = p.memory.calls.length, readsStarted = performance.now();
    for (let repeat = 0; repeat < iterations; repeat++) {
        const iterationCalls = p.memory.calls.length;
        const context = await p.bindings.readContext(p.contextId);
        assert.equal(context.schemaJson, corpus.find(row => row.id === p.contextId).record.schemaJson);
        for (const row of commits) assert.deepEqual(await p.store.readCommit(row.id), row.record.value);
        assert.equal(p.memory.calls.slice(iterationCalls).filter(call => call.method === 'getIndex').length, 1 + commits.length,
            'Every logical source-context/frontier read must independently validate fresh index metadata');
    }
    const readsMs = performance.now() - readsStarted, freshCalls = p.memory.calls.slice(beforeCalls);
    assert(freshCalls.length > iterations, 'Each iteration must traverse the real fresh store boundary');
    const victim = commits[0], chunkId = victim.manifest.chunk_ids[0];
    p.memory.faults.read = (result, request) => request.index === victim.index && request.id === chunkId
        ? {...result, _source: {...result._source, payload: 'AA=='}} : result;
    await assert.rejects(p.store.readCommit(victim.id), error => error.code === 'invalid');
    p.memory.faults.read = undefined;
    assert.deepEqual(await p.store.readCommit(victim.id), victim.record.value);
    p.memory.faults.settings = (settings, request) => ({[request.index]: {settings: {...settings, 'index.translog.durability': 'async'}}});
    await assert.rejects(p.bindings.readContext(p.contextId), /durability/i);
    p.memory.faults.settings = undefined;
    assert.equal((await p.bindings.readContext(p.contextId)).schemaJson, corpus.find(row => row.id === p.contextId).record.schemaJson);
    console.log(JSON.stringify({kind: 'bounded-json-authentic-wire-record-loop/v1', runtime: process.version,
        sourceProfile: process.env.HYPERION_NATIVE_SOURCE_PROFILE, capture: 'wire-native-genesis-20261020-blocks1..4',
        corpus: expected, corpusDigest: sha(JSON.stringify(expected)), iterations, canonicalBytes,
        freshCalls: freshCalls.length, preparationMs, canonicalMs, readsMs, elapsedMs: performance.now() - started,
        qualification: 'Focused in-process module control; no physical engine, full1480 replay or speedup claim'}));
});
