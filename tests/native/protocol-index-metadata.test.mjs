import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client} from '@elastic/elasticsearch';
import {BaseConnection} from '@elastic/transport';
import {ProtocolAbiFrontierStore} from '../../build/indexer/protocol/abi-frontier-store.js';
import {ImmutableProtocolBundleStore} from '../../build/indexer/protocol/immutable-bundle-store.js';
import {ProtocolAbiProofReader, protocolAbiCertificateForControl} from '../../build/indexer/protocol/abi-proof.js';
import {ProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';
import {frontierMemoryClient} from '../unit/protocol-frontier-memory.mjs';
import {observationMemoryClient} from '../unit/protocol-observation-memory.mjs';

assert.ok([24, 26].includes(Number(process.versions.node.split('.')[0])), 'run with native Node 24/26');
const chain = 'combined-metadata-fixture';

/** Actual pinned client serialization/Transport, controlled connection only: no sockets or engine. */
function transport(memory) {
    const calls = [], control = {};
    class Connection extends BaseConnection {
        async close() {} // This controlled connection owns no sockets or other external resources.
        async request(params, options) {
            const row = {params: structuredClone(params), signal: options?.signal}; calls.push(row);
            await control.beforeRequest?.(row);
            const reply = await control.reply?.(row);
            if (reply) return {...reply, headers: {'content-type': 'application/json', 'x-elastic-product': 'Elasticsearch'}};
            const parts = params.path.slice(1).split('/').map(decodeURIComponent), [index, route, id] = parts;
            let body;
            if (params.method === 'GET' && !route) {
                body = {[index]: {mappings: structuredClone(memory.mappings.get(index)), settings: structuredClone(memory.settings.get(index))}};
                if (!memory.mappings.has(index)) return {statusCode: 404, headers: {'content-type': 'application/json', 'x-elastic-product': 'Elasticsearch'},
                    body: JSON.stringify({error: {type: 'index_not_found_exception', index}, status: 404})};
                body = await control.metadata?.(body, row) ?? body;
            } else if (params.method === 'GET' && route === '_mapping') body = await memory.client.indices.getMapping({index});
            else if (params.method === 'GET' && route === '_settings') body = await memory.client.indices.getSettings({index});
            else {
                assert.equal(params.method, 'GET'); assert.equal(route, '_doc');
                try {body = await memory.client.get({index, id});}
                catch (error) {
                    if (error.meta) return {statusCode: error.meta.statusCode, headers: {'content-type': 'application/json', 'x-elastic-product': 'Elasticsearch'}, body: JSON.stringify(error.meta.body)};
                    throw error;
                }
            }
            await control.afterResponse?.(body, row);
            return {statusCode: 200, headers: {'content-type': 'application/json', 'x-elastic-product': 'Elasticsearch'}, body: JSON.stringify(body)};
        }
    }
    const client = new Client({node: 'http://controlled.invalid:9200', Connection, maxRetries: 0});
    return {client, calls, control};
}

test('frontier read uses one fresh response for the complete records-index validation union', async () => {
    const memory = frontierMemoryClient(), writer = new ProtocolAbiFrontierStore(memory.client, chain);
    const prepared = await writer.prepareCommit({height: 42}), fixture = transport(memory);
    const writesBefore = memory.calls.filter(call => ['create', 'index', 'createIndex'].includes(call.method)).length;
    try {
        const reader = new ProtocolAbiFrontierStore(fixture.client, chain, 0, {readOnly: true});
        assert.deepEqual(await reader.readCommit(prepared.id), {height: 42});
        assert.equal(fixture.calls.length, 3, 'one fresh metadata response plus original manifest and chunk');
        const metadata = fixture.calls.filter(call => call.params.path === '/' + reader.recordsIndex);
        assert.equal(metadata.length, 1, 'frontier and bundle predicates validate the same fresh response');
        for (const call of metadata) {
            const query = new URLSearchParams(call.params.querystring);
            assert.equal(query.get('features'), 'mappings,settings');
            assert.equal(query.get('flat_settings'), 'true'); assert.equal(query.get('include_defaults'), 'true');
        }
        assert.equal(memory.calls.filter(call => ['create', 'index', 'createIndex'].includes(call.method)).length, writesBefore);
    } finally {await fixture.client.close();}
});

async function retained(kind = 'frontier') {
    const memory = frontierMemoryClient(), writer = new ProtocolAbiFrontierStore(memory.client, chain);
    const prepared = await writer.prepareCommit({height: 42}), fixture = transport(memory);
    const reader = kind === 'frontier' ? new ProtocolAbiFrontierStore(fixture.client, chain, 0, {readOnly: true})
        : new ImmutableProtocolBundleStore(fixture.client, chain, 0, 'protocol-abi-frontier-records',
            'protocol-abi-frontier-records-v1', undefined, {readOnly: true});
    return {...fixture, memory, writer, prepared, reader, index: writer.recordsIndex,
        read: signal => kind === 'frontier' ? reader.readCommit(prepared.id, signal) : reader.read(prepared.id, signal)};
}
const gate = () => {let release; const promise = new Promise(resolve => {release = resolve;}); return {promise, release};};

for (const kind of ['frontier', 'bundle']) {
    test(`${kind} reads flat, nested-index and defaults without retaining metadata between calls`, async () => {
        const f = await retained(kind);
        try {
            for (const shape of ['flat', 'nested', 'defaults']) {
                f.control.metadata = body => {
                    const entry = body[f.index], flat = entry.settings;
                    const nested = {index: Object.fromEntries(Object.entries(flat).map(([key, value]) => [key.slice(6), value]))};
                    if (shape === 'nested') entry.settings = nested;
                    if (shape === 'defaults') {entry.settings = {}; entry.defaults = nested;}
                    return body;
                };
                const result = await f.read(); assert.equal(kind === 'frontier' ? result.height : result.value.height, 42);
            }
            f.control.metadata = undefined;
            f.memory.mappings.get(f.index).properties.payload.type = 'keyword';
            await assert.rejects(f.read(), /ABI observation index/);
        } finally {await f.client.close();}
    });

    test(`${kind} refuses foreign, multiple, alias, absent and data-stream metadata before document reads`, async t => {
        for (const variant of ['foreign', 'multiple', 'alias', 'absent', 'data-stream', 'missing-mapping', 'missing-settings']) {
            await t.test(variant, async () => {
                const f = await retained(kind);
                try {
                    f.control.metadata = body => {
                        if (variant === 'foreign' || variant === 'alias') return {'different-concrete-index': body[f.index]};
                        if (variant === 'multiple') return {...body, foreign: body[f.index]};
                        if (variant === 'absent') return {};
                        if (variant === 'data-stream') body[f.index].data_stream = 'foreign-stream';
                        if (variant === 'missing-mapping') delete body[f.index].mappings;
                        if (variant === 'missing-settings') delete body[f.index].settings;
                        return body;
                    };
                    await assert.rejects(f.read(), /index|mapping|retention/);
                    assert.equal(f.calls.length, 1); assert.ok(f.calls.every(x => !x.params.path.includes('/_doc/')));
                } finally {await f.client.close();}
            });
        }
    });

    test(`${kind} preserves storage, schema, pipeline and durability refusal predicates`, async t => {
        const variants = {
            kind: entry => {entry.mappings._meta.hyperion_kind = 'foreign';},
            schema: entry => {entry.mappings._meta.schema_version = 2;},
            dynamic: entry => {entry.mappings.dynamic = true;},
            field: entry => {entry.mappings.properties.payload.type = 'keyword';},
            disabled: entry => {entry.mappings._source = {enabled: false};},
            includes: entry => {entry.mappings._source = {includes: ['digest']};},
            excludes: entry => {entry.mappings._source = {excludes: ['payload']};},
            syntheticMapping: entry => {entry.mappings._source = {mode: 'synthetic'};},
            syntheticSettings: entry => {entry.settings['index.mapping.source.mode'] = 'synthetic';},
            durability: entry => {entry.settings['index.translog.durability'] = 'async';},
            shards: entry => {entry.settings['index.number_of_shards'] = '2';},
            replicas: entry => {entry.settings['index.number_of_replicas'] = '1';},
            autoExpand: entry => {entry.settings['index.auto_expand_replicas'] = '0-all';},
            defaultPipeline: entry => {entry.settings['index.default_pipeline'] = 'prune';},
            finalPipeline: entry => {entry.settings['index.final_pipeline'] = 'prune';},
        };
        if (kind === 'frontier') {
            variants.lifecycleName = entry => {entry.settings['index.lifecycle.name'] = 'delete-soon';};
            variants.rollover = entry => {entry.settings['index.lifecycle.rollover_alias'] = 'another-index';};
        }
        for (const [name, alter] of Object.entries(variants)) await t.test(name, async () => {
            const f = await retained(kind);
            try {
                f.control.metadata = body => {alter(body[f.index]); return body;};
                await assert.rejects(f.read(), /index|mapping|retention/);
                assert.equal(f.calls.length, 1);
            } finally {await f.client.close();}
        });
    });

    test(`${kind} keeps mapping refusal ahead of settings predicates within the response`, async () => {
        const f = await retained(kind);
        try {
            f.control.metadata = body => {body[f.index].mappings.dynamic = true; body[f.index].settings = {}; return body;};
            await assert.rejects(f.read(), /^Error: Unowned or incompatible ABI observation index$/);
        } finally {await f.client.close();}
    });

    test(`${kind} propagates actual client permission, missing-index and server errors unchanged`, async t => {
        for (const [status, type] of [[403, 'security_exception'], [404, 'index_not_found_exception'], [503, 'unavailable_shards_exception']]) {
            await t.test(type, async () => {
                const f = await retained(kind); let actualClientError;
                try {
                    f.control.reply = () => ({statusCode: status, body: JSON.stringify({error: {type, reason: 'controlled failure'}, status})});
                    const get = f.client.indices.get.bind(f.client.indices);
                    f.client.indices.get = async (...args) => {try {return await get(...args);} catch (error) {actualClientError = error; throw error;}};
                    await assert.rejects(f.read(), error => error === actualClientError && error.meta.statusCode === status && error.meta.body.error.type === type);
                    assert.equal(f.calls.length, 1);
                } finally {await f.client.close();}
            });
        }
    });

    test(`${kind} rejects pre-aborted metadata reads without any transport call`, async () => {
        const f = await retained(kind), controller = new AbortController(), reason = Symbol('original caller reason');
        try {
            controller.abort(reason); await assert.rejects(f.read(controller.signal), error => error === reason);
            assert.equal(f.calls.length, 0);
        } finally {await f.client.close();}
    });

    test(`${kind} honors the caller abort reason when a held metadata request returns a late server failure`, async () => {
        const f = await retained(kind), entered = gate(), release = gate(), controller = new AbortController(), reason = new Error('caller already cancelled');
        try {
            f.control.beforeRequest = async row => {if (row.signal === controller.signal) {entered.release(); await release.promise;}};
            f.control.reply = row => row.signal === controller.signal
                ? {statusCode: 503, body: JSON.stringify({error: {type: 'unavailable_shards_exception', reason: 'late failure'}, status: 503})} : undefined;
            const pending = f.read(controller.signal), result = pending.then(() => null, error => error);
            await entered.promise; controller.abort(reason); release.release();
            const error = await result; assert.equal(error, reason);
            assert.equal(f.calls.length, 1);
        } finally {release.release(); await f.client.close();}
    });

    test(`${kind} never substitutes earlier retained bytes for a newly missing manifest or chunk`, async t => {
        for (const target of ['manifest', 'chunk']) await t.test(target, async () => {
            const f = await retained(kind);
            try {
                await f.read();
                const manifest = f.memory.documents.get(f.memory.key(f.index, f.prepared.id)).document;
                f.memory.documents.delete(f.memory.key(f.index, target === 'manifest' ? f.prepared.id : manifest.chunk_ids[0]));
                await assert.rejects(f.read(), error => error.code === (target === 'manifest' ? 'missing' : 'incomplete'));
            } finally {await f.client.close();}
        });
    });

    test(`${kind} cancels after each remaining metadata/document await and does not affect another consumer`, async t => {
        const maximum = 3;
        for (let target = 1; target <= maximum; target++) await t.test(`await ${target}`, async () => {
            const f = await retained(kind), entered = gate(), release = gate(), controller = new AbortController(), reason = new Error('one caller stopped');
            try {
                let held = false;
                f.control.beforeRequest = async row => {
                    if (!held && f.calls.length === target) {held = true; entered.release(); await release.promise;}
                };
                const pending = f.read(controller.signal), result = pending.then(value => ({value}), error => ({error}));
                await entered.promise;
                // A separate call shares only its client/store, not cancellation or a cached validation promise.
                const healthy = await f.read(); assert.equal(kind === 'frontier' ? healthy.height : healthy.value.height, 42);
                const before = f.calls.length; controller.abort(reason); release.release();
                const outcome = await result;
                // The shared bundle checkedIo boundary preserves the caller's exact late-abort reason.
                assert.equal(outcome.error, reason);
                assert.equal(f.calls.length, before);
                assert.ok(f.calls.slice(0, target).every(row => row.signal === controller.signal));
            } finally {release.release(); await f.client.close();}
        });
    });
}

test('each logical frontier read fetches fresh metadata after an earlier successful read', async () => {
    const f = await retained(); let metadata = 0;
    try {
        f.control.metadata = body => {if (++metadata === 2) body[f.index].settings['index.translog.durability'] = 'async'; return body;};
        assert.deepEqual(await f.read(), {height: 42});
        assert.equal(metadata, 1); assert.equal(f.calls.length, 3);
        await assert.rejects(f.read(), /^Error: ABI observation index durability or retention is incompatible:/);
        assert.equal(metadata, 2); assert.equal(f.calls.length, 4, 'changed next response refuses before a document read');
    } finally {await f.client.close();}
});

test('frontier retention predicates stay scoped to frontier reads and do not change generic bundle policy', async () => {
    const f = await retained('bundle');
    try {
        f.memory.settings.get(f.index)['index.lifecycle.name'] = 'generic-existing-policy';
        assert.equal((await f.read()).value.height, 42);
        assert.equal(f.calls.length, 3);
    } finally {await f.client.close();}
});

async function proofFixture(requireAttemptScope = false, distance = 0) {
    const memory = frontierMemoryClient(), writer = new ProtocolAbiFrontierStore(memory.client, chain);
    const hex = number => number.toString(16).padStart(64, '0');
    const profile = {id: 'fixture', profileId: 'combined-metadata-proof', components: [
        {id: 'fixture-node', runtime: 'node', version: '0.0.0', sourceRevision: 'b'.repeat(40), sha256: 'c'.repeat(64)}]};
    const source = {chainId: hex(100), blockNum: 1, blockId: hex(1), previousBlockId: null};
    const selectionId = 'h45srcsel1:' + hex(1);
    let commit, previousCommitId = null;
    for (let height = 1; height <= distance + 1; height++) {
        commit = await writer.prepareCommit({schemaVersion: 1, kind: 'canonical-abi-block', chainId: source.chainId, profile,
            generation: 'fixture-generation', source: {...source, blockNum: height, blockId: hex(height), previousBlockId: height === 1 ? null : hex(height - 1)},
            selectionId: 'h45srcsel1:' + hex(height), previousCommitId, status: 'complete', stateRootId: null,
            bindings: [], coverageStart: 1, lastGlobalSequence: null, observationId: 'h45abi1:' + hex(height), observationDigest: hex(height)});
        previousCommitId = commit.id;
    }
    const control = {schemaVersion: 1, chainId: source.chainId, profile, ownerId: 'fixture-owner', generation: 'fixture-generation',
        revision: 1, phase: 'following', replayFromBlock: null, source: {contextId: 'h45srcctx1:' + hex(1), readerSessionId: 'fixture-session'},
        head: {blockNum: distance + 1, blockId: hex(distance + 1), commitId: commit.id, stateRootId: null, coverageStart: 1, lastGlobalSequence: null}};
    await writer.prepareCertificate(protocolAbiCertificateForControl(control)); await writer.compareAndSet(null, control);
    const f = transport(memory);
    const reader = new ProtocolAbiProofReader({chainId: source.chainId, profile,
        store: new ProtocolAbiFrontierStore(f.client, chain, 0, {readOnly: true}), requireAttemptScope});
    return {...f, reader, writer, source, selectionId, control, transportControl: f.control};
}

test('combined metadata leaves certificate issuance, exact membership and fresh authority revocation active', async () => {
    const f = await proofFixture();
    try {
        const view = await f.reader.open(f.source, f.selectionId);
        assert.equal(f.calls.length, 10, 'fresh authority twice plus one metadata response per certificate and commit bundle');
        let before = f.calls.length;
        await assert.rejects(f.reader.revalidate({...view}), {code: 'invalid_proof'}); assert.equal(f.calls.length, before);
        const stored = await f.writer.readControl();
        await f.writer.compareAndSet(stored, {...f.control, generation: 'replacement-generation'});
        before = f.calls.length;
        await assert.rejects(f.reader.revalidate(view), {code: 'authority_changed'});
        assert.equal(f.calls.length - before, 2, 'fresh complete metadata and realtime control are never cached');
    } finally {await f.client.close();}
});

test('fresh union reads measure 3D+10 requests while each repeated open retains fresh authority and metadata', async t => {
    for (const distance of [0, 1, 8, 19, 32, 66]) await t.test(`distance ${distance}`, async () => {
        const f = await proofFixture(false, distance);
        try {
            for (const repetitions of [1, 8]) {
                const before = f.calls.length;
                for (let repeat = 0; repeat < repetitions; repeat++) {
                    const view = await f.reader.open(f.source, f.selectionId);
                    assert.deepEqual(view.source, f.source);
                }
                const calls = f.calls.slice(before);
                assert.equal(calls.length, repetitions * (3 * distance + 10));
                assert.equal(calls.filter(row => row.params.path === '/' + chain + '-protocol-abi-frontier-records-v1').length,
                    repetitions * (distance + 2), 'one fresh response per certificate/commit logical read');
                assert.equal(calls.filter(row => row.params.path === '/' + chain + '-protocol-abi-frontier-v1').length,
                    repetitions * 2, 'opening and final authority reads remain fresh');
                assert.ok(calls.every(row => row.params.method === 'GET'));
            }
        } finally {await f.client.close();}
    });
});

for (const change of ['owner', 'fork']) test(`coalesced metadata preserves final ${change} rejection after the response arrives`, async () => {
    const f = await proofFixture(); let changed = false;
    try {
        f.transportControl.afterResponse = async (_body, row) => {
            if (changed || row.params.path !== '/' + chain + '-protocol-abi-frontier-records-v1') return;
            changed = true;
            let next = {...f.control};
            if (change === 'owner') next.ownerId = 'replacement-owner';
            else {
                const blockId = 'd'.repeat(64), selectionId = 'h45srcsel1:' + 'e'.repeat(64);
                const commit = await f.writer.prepareCommit({schemaVersion: 1, kind: 'canonical-abi-block', chainId: f.source.chainId,
                    profile: next.profile, generation: next.generation, source: {...f.source, blockId}, selectionId, previousCommitId: null,
                    status: 'complete', stateRootId: null, bindings: [], coverageStart: 1, lastGlobalSequence: null,
                    observationId: 'h45abi1:' + 'f'.repeat(64), observationDigest: 'f'.repeat(64)});
                next.head = {...next.head, blockId, commitId: commit.id};
            }
            await f.writer.prepareCertificate(protocolAbiCertificateForControl(next));
            await f.writer.compareAndSet(await f.writer.readControl(), next);
        };
        await assert.rejects(f.reader.open(f.source, f.selectionId), error => error.code === 'authority_changed');
        assert.equal(changed, true);
    } finally {await f.client.close();}
});

test('cancelling the real proof wait retains an outstanding helper until its actual late callback settles', async () => {
    const f = await proofFixture(true), entered = gate(), release = gate(), abort = new AbortController(), scope = new ProofConsumerScope('metadata-drain');
    try {
        const get = f.client.indices.get.bind(f.client.indices);
        f.client.indices.get = async (...args) => {const value = await get(...args); entered.release(); await release.promise; return value;};
        const running = scope.run(() => f.reader.waitForOpen(f.source, f.selectionId, {signal: abort.signal}));
        const outcome = running.then(() => null, error => error);
        await entered.promise; const before = f.calls.length; abort.abort();
        assert.equal((await outcome).code, 'proof_cancelled');
        let drained = false; const drain = scope.closeAndDrain().then(() => {drained = true;});
        await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
        release.release(); await drain; assert.equal(drained, true); assert.equal(f.calls.length, before);
        assert.equal(scope.snapshot().pendingOperations, 0);
    } finally {release.release(); await scope.closeAndDrain(); await f.client.close();}
});

async function asyncMetadataFixture(kind) {
    const memory = kind === 'frontier' ? frontierMemoryClient() : observationMemoryClient();
    const store = kind === 'frontier' ? new ProtocolAbiFrontierStore(memory.client, chain)
        : new ImmutableProtocolBundleStore(memory.client, chain, 0, 'metadata-async-fixture', 'metadata-async-fixture-v1');
    const prepared = kind === 'frontier' ? await store.prepareCommit({height: 42}) : await store.prepare('fixture-record', {height: 42});
    return {memory, read: signal => kind === 'frontier' ? store.readCommit(prepared.id, signal) : store.read(prepared.id, signal)};
}
const metadataReply = (phase, value, request) => ({[request.index]: {[phase === 'mapping' ? 'mappings' : 'settings']: value}});

for (const kind of ['frontier', 'observation']) for (const phase of ['mapping', 'settings']) {
    test(`${kind} adapter awaits a held async ${phase} callback before the real store read can settle`, async () => {
        const f = await asyncMetadataFixture(kind), entered = gate(), release = gate(); let settled = false;
        f.memory.faults[phase] = async (value, request) => {entered.release(); await release.promise; return metadataReply(phase, value, request);};
        const result = f.read().then(value => {settled = true; return {value};}, error => {settled = true; return {error};});
        try {
            await entered.promise; await new Promise(resolve => setImmediate(resolve));
            assert.equal(settled, false, 'the original callback is still physically pending');
            release.release(); assert.deepEqual(await result, {value: {height: 42}});
        } finally {release.release(); await result;}
    });

    test(`${kind} adapter preserves async ${phase} values on ordinary non-target reads`, async () => {
        const f = await asyncMetadataFixture(kind);
        f.memory.faults[phase] = async (value, request) => metadataReply(phase, value, request);
        assert.deepEqual(await f.read(), {height: 42});
    });

    test(`${kind} adapter propagates the exact async ${phase} rejection without a detached failure`, async () => {
        const f = await asyncMetadataFixture(kind), error = new Error('original async callback failure');
        f.memory.faults[phase] = async () => {throw error;};
        await assert.rejects(f.read(), actual => actual === error);
    });

    test(`${kind} adapter keeps async ${phase} custody until late success and then honors the original abort reason`, async () => {
        const f = await asyncMetadataFixture(kind), entered = gate(), release = gate(), controller = new AbortController();
        const reason = Object.freeze({caller: 'cancelled while metadata callback was retained'}); let settled = false;
        f.memory.faults[phase] = async (value, request) => {entered.release(); await release.promise; return metadataReply(phase, value, request);};
        const result = f.read(controller.signal).then(value => {settled = true; return {value};}, error => {settled = true; return {error};});
        try {
            await entered.promise; const before = f.memory.calls.length; controller.abort(reason);
            await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
            release.release(); assert.equal((await result).error, reason); assert.equal(f.memory.calls.length, before);
        } finally {release.release(); await result;}
    });
}
