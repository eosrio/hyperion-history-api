/** Source/adapter controls only. Actual emitted runtime/controller and original ABI-correct Wire rows. */
import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {ProjectionContractError} from '@eosrio/hyperion-sdk/projection';
import {PortableStateController} from '../../build/indexer/projection/controller.js';
import {ProofConsumerScope, currentProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';
import {DeclarativeProjectionRuntime, consumeDeclarativeMappingRejection} from '../../build/indexer/projection/runtime.js';
import {originalWireRows, gate, until} from '../fixtures/portable-mapping-retry.mjs';

import {fixture, plan, first, invalid} from '../fixtures/portable-mapping-retry-controller.mjs';

test('finite100ms arrivals avoid repeated preparation of the unchanged durably rejected target until eligible',
    {timeout: 60000}, async () => {
    let now = 0;
    const clock = mock.method(performance, 'now', () => now);
    try {
        const run = async interval => {
            now = 0;
            const original = await originalWireRows();
            const value = await fixture(original, interval), schedule = [];
            try {
                for (const [index, at] of [0, 100, 200, 300, 400, 1100].entries()) {
                    now = at; original.releaseThrough(1243 + 8 * (index + 1));
                    const before = {...value.counts}, reports = value.progress.length;
                    await value.controller.drain();
                    for (const definition of plan.definitions)
                        assert.equal(value.metadata.get(definition.id).checkpoint.blockNum, 1243 + 8 * (index + 1), 'healthy eight-frame budget remains unchanged: ' + JSON.stringify(value.progress));
                    assert.equal(value.metadata.get(invalid.id).checkpoint.blockNum, 1243);
                    assert.equal(value.metadata.get(invalid.id).pending.block.blockNum, 1244);
                    await assert.rejects(value.adapter.open(value.metadata.get(invalid.id).binding), {code: 'projection.incomplete'});
                    schedule.push({at, through: 1243 + 8 * (index + 1), counts: {...value.counts},
                        delta: Object.fromEntries(Object.entries(value.counts).map(([key, count]) => [key, count - before[key]])),
                        reports: value.progress.length - reports});
                }
                return {schedule, counts: {...value.counts}, retries: value.calls.filter(call => call.projectionId === invalid.id),
                    healthy: plan.definitions.map(definition => value.metadata.get(definition.id).checkpoint.blockNum), attempts: value.attempts.length};
            } finally {await value.controller.stop(); await original.dispose();}
        };
        const baseline = await run(undefined);
        const candidate = await run(1000);
        assert.equal(baseline.retries.length, 6, 'legacy default prepares the unchanged rejected target at every arrival');
        assert.equal(candidate.retries.length, 2, 'engineering interval must prevent four repeated invalid source preparations');
        assert.deepEqual(candidate.retries.map(value => value.height), [1244, 1244]);
        assert.deepEqual(candidate.retries[0], candidate.retries[1], 'due retry freshly selects the same authentic source and ABI');
        assert.deepEqual(candidate.healthy, baseline.healthy);
        assert.equal(candidate.counts.apply, baseline.counts.apply);
        assert.equal(candidate.counts.source, baseline.counts.source - 4);
        assert.equal(candidate.counts.revalidate, baseline.counts.revalidate - 4);
        assert.ok(candidate.schedule.slice(1, 5).every(value => value.reports === 16), 'interval skips publish no failed-lane progress');
        console.log(JSON.stringify({control: 'finite-monotonic-clock-source-adapter-ports', node: process.version,
            controllerDefaultMs: 0, selectedWorkerIntervalMs: 1000, engineeringIntervalMs: 1000, baseline, candidate}));
    } finally {clock.mock.restore();}
});

test('engineering interval is bounded and omitted/zero retain immediate legacy retries', {timeout: 30000}, async () => {
    const inert = {chainId: 'c'.repeat(64), position: blockNum => ({blockNum, blockId: 'a'.repeat(64)})};
    for (const interval of [-1, 1001, 0.5, NaN, Infinity, '1000', true])
        await assert.rejects(fixture(inert, interval), {code: 'projection.invalid-contract'});
    const original = await originalWireRows(); original.releaseThrough(1251);
    try {
        for (const interval of [undefined, 0]) {
            const value = await fixture(original, interval, {projections: [invalid], maximumFramesPerProjection: 1});
            try {await value.controller.drain(); await value.controller.drain(); assert.equal(value.counts.source, 2);}
            finally {await value.controller.stop();}
        }
    } finally {await original.dispose();}
});

test('source, proof, ABI, marker uncertainty and foreign errors never select mapping eligibility', {timeout: 60000}, async () => {
    const original = await originalWireRows(); original.releaseThrough(1251);
    const primary = new ProjectionContractError('projection.invalid-contract', '/source/missing: Required source field is missing');
    Object.assign(primary, {mappingRejected: true, retryEligibilityMs: 1000, deterministic: true});
    const cases = [
        ['source-before-admission', ({source}) => {source.frame = async () => {
            // Count the entered source port without pretending the original bytes were selected.
            source.entered = (source.entered ?? 0) + 1; throw primary;
        };}],
        ['source-after-admission', ({source}) => {const frame = source.frame; source.frame = async (...args) => {await frame(...args); throw primary;};}],
        ['proof-revalidation', ({source}) => {source.revalidate = async () => {throw primary;};}],
        ['runtime-abi', ({source}) => {const frame = source.frame; source.frame = async (...args) => {
            const result = await frame(...args); for (const change of result.frame.changes) change.abiSha256 = 'f'.repeat(64); return result;
        };}],
        ['frame-envelope', ({source}) => {const frame = source.frame; source.frame = async (...args) => {
            const result = await frame(...args); result.frame.changes = null; return result;
        };}],
        ...['before', 'after'].map(when => ['admission-' + when, ({adapter}) => {
            const mark = adapter.markIncomplete.bind(adapter); adapter.markIncomplete = async (...args) => {
                if (args[2] === 'Canonical projection source admitted; durable application is pending') {
                    if (when === 'after') await mark(...args); throw new Error('unknown admission outcome');
                } return mark(...args);
            };
        }]),
        ...['before', 'after'].map(when => ['failure-marker-' + when, ({adapter}) => {
            const mark = adapter.markIncomplete.bind(adapter); adapter.markIncomplete = async (...args) => {
                if (args[2] !== 'Canonical projection source admitted; durable application is pending') {
                    if (when === 'after') await mark(...args); throw new Error('unknown failure-marker outcome');
                } return mark(...args);
            };
        }]),
        ['post-marker-recovery', ({adapter}) => {const recovery = adapter.recovery.bind(adapter); let reads = 0;
            adapter.recovery = async (...args) => {if (++reads === 2) throw new Error('unknown current recovery'); return recovery(...args);};}],
        ['oversized-recovery', ({adapter}) => {const recovery = adapter.recovery.bind(adapter);
            adapter.recovery = async (...args) => ({...await recovery(...args), unneededData: 'x'.repeat(32769)});}],
        ['non-json-recovery', ({adapter}) => {const recovery = adapter.recovery.bind(adapter);
            adapter.recovery = async (...args) => ({...await recovery(...args), unneededData: 1n});}],
        ['adapter-apply', ({source, adapter}) => {const frame = source.frame; source.frame = async (...args) => {
            const result = await frame(...args); result.frame.changes = []; return result;
        }; adapter.apply = async () => {throw primary;};}],
    ];
    try {
        for (const [name, beforeCreate] of cases) {
            const value = await fixture(original, 1000, {projections: [invalid], maximumFramesPerProjection: 1, beforeCreate});
            try {
                await value.controller.drain(); await value.controller.drain();
                assert.equal(name === 'source-before-admission' ? value.source.entered : value.counts.source, 2, name + ': fresh immediate preparation remains required');
                assert.equal(value.metadata.get(invalid.id).checkpoint.blockNum, 1243, name + ': no failed input becomes completion');
            } finally {await value.controller.stop();}
        }
    } finally {await original.dispose();}
});

test('a private mapping signal belongs only to the exact runtime, process promise, original error and active scope', {timeout: 30000}, async () => {
    const original = await originalWireRows(); original.releaseThrough(1251);
    const value = await fixture(original, 1000, {projections: [invalid], maximumFramesPerProjection: 1});
    let borrowed;
    const run = async (kind, use) => {
        const scope = new ProofConsumerScope('signal-' + kind);
        try {return await scope.run(async () => {
            const runtime = await DeclarativeProjectionRuntime.create({adapter: value.adapter, definition: invalid,
                binding: value.metadata.get(invalid.id).binding, genesis: {blockNum: 0, blockId: '0'.repeat(64)}});
            const selected = await original.frame(1244, invalid);
            const work = runtime.process(selected.frame), error = await work.then(() => assert.fail('mapping must reject'), error => error);
            borrowed = error;
            return use({runtime, work, error, scope});
        });} finally {await scope.closeAndDrain();}
    };
    try {
        await run('actual', ({runtime, work, error}) => {
            assert.equal(consumeDeclarativeMappingRejection(runtime, work, error).blockNum, 1244);
            assert.equal(consumeDeclarativeMappingRejection(runtime, work, error), undefined, 'issued signal is consumed once');
        });
        await run('copied-error', ({runtime, work, error}) => {
            assert.equal(consumeDeclarativeMappingRejection(runtime, work, Object.assign(new Error(error.message), error)), undefined);
        });
        await run('foreign-work', ({runtime, error}) => {
            assert.equal(consumeDeclarativeMappingRejection(runtime, Promise.resolve(), error), undefined);
        });
        await run('foreign-runtime', ({work, error}) => {
            assert.equal(consumeDeclarativeMappingRejection({}, work, error), undefined);
        });
        let issued;
        await run('ended-scope', result => {issued = result;});
        const other = new ProofConsumerScope('foreign-scope');
        try {await other.run(() => assert.equal(consumeDeclarativeMappingRejection(issued.runtime, issued.work, issued.error), undefined));}
        finally {await other.closeAndDrain();}
        const base = value.source.frame;
        value.source.frame = async (...args) => {await base(...args); throw borrowed;};
        await value.controller.drain(); await value.controller.drain();
        assert.equal(value.counts.source, 2, 'a real error borrowed by a source port cannot select eligibility');
    } finally {await value.controller.stop(); await original.dispose();}
});

test('changed exact recovery and failed fresh recovery invalidate the pause before source selection', {timeout: 60000}, async () => {
    const original = await originalWireRows(); original.releaseThrough(1251);
    const mutations = [
        ['pending target', row => {row.pending.block.blockId = 'f'.repeat(64);}],
        ['pending digest', row => {row.pending.digest = 'f'.repeat(64);}],
        ['pending reason', row => {row.pending.reason = 'changed durable failure';}],
        ['gap', row => {row.gap = {reason: 'needs historical input'};}],
        ['checkpoint', row => {row.checkpoint = original.position(1242);}],
    ];
    try {
        for (const [name, mutate] of mutations) {
            const value = await fixture(original, 1000, {projections: [invalid], maximumFramesPerProjection: 1});
            try {
                await value.controller.drain(); await value.controller.drain(); assert.equal(value.counts.source, 1, 'unchanged recovery is paused');
                mutate(value.metadata.get(invalid.id));
                await value.controller.drain(); assert.equal(value.counts.source, 2, name + ' requires immediate fresh source work');
            } finally {await value.controller.stop();}
        }
        for (const field of ['binding', 'initialized', 'unavailable']) {
            const value = await fixture(original, 1000, {projections: [invalid], maximumFramesPerProjection: 1});
            try {
                await value.controller.drain();
                const read = value.adapter.recovery.bind(value.adapter);
                value.adapter.recovery = async (...args) => {const row = await read(...args);
                    if (field === 'binding') row.binding.generation = 'foreign-generation';
                    if (field === 'initialized') row.initialized = false;
                    if (field === 'unavailable') throw new Error('fresh recovery unavailable'); return row;
                };
                await value.controller.drain(); assert.equal(value.counts.source, 1);
                value.adapter.recovery = read;
                await value.controller.drain(); assert.equal(value.counts.source, 2, field + ' cannot retain a previous pause');
            } finally {await value.controller.stop();}
        }
    } finally {await original.dispose();}
});

test('fork/owner invalidation, changed configuration and controller retirement discard eligibility', {timeout: 30000}, async () => {
    const original = await originalWireRows(); original.releaseThrough(1251);
    const value = await fixture(original, 1000, {projections: [invalid], maximumFramesPerProjection: 1});
    try {
        await value.controller.drain(); await value.controller.drain(); assert.equal(value.counts.source, 1);
        value.controller.invalidateMappingRetryEligibility();
        await value.controller.drain(); assert.equal(value.counts.source, 2, 'stable lifecycle epoch changes clear timing');
        await value.controller.stop();
        const restarted = await PortableStateController.create(value.controllerOptions);
        try {await restarted.drain(); assert.equal(value.counts.source, 3, 'new controller reads the unchanged durable failure immediately');}
        finally {await restarted.stop();}
        const corrected = {...structuredClone(invalid), mappingRevision: 'f'.repeat(64), fields: structuredClone(first.fields)};
        const changed = await fixture(original, 1000, {projections: [corrected], maximumFramesPerProjection: 1});
        try {await changed.controller.drain(); assert.equal(changed.counts.source, 1); assert.equal(changed.counts.apply, 1);
            assert.equal(changed.metadata.get(corrected.id).checkpoint.blockNum, 1244);}
        finally {await changed.controller.stop();}
    } finally {await value.controller.stop(); await original.dispose();}
});

test('held failure marking cannot recreate eligibility after invalidation or stop, and stop waits normally', {timeout: 30000}, async () => {
    const original = await originalWireRows(); original.releaseThrough(1251);
    try {
        for (const mode of ['invalidate', 'stop']) {
            const entered = gate(), held = gate();
            const value = await fixture(original, 1000, {projections: [invalid], maximumFramesPerProjection: 1,
                beforeCreate({adapter}) {const mark = adapter.markIncomplete.bind(adapter); let once = true;
                    adapter.markIncomplete = async (...args) => {
                        await mark(...args);
                        if (once && args[2] !== 'Canonical projection source admitted; durable application is pending') {
                            once = false; entered.release(); await held.promise;
                        }
                    };
                }});
            try {
                const draining = value.controller.drain(); await entered.promise;
                assert.equal(value.metadata.get(invalid.id).checkpoint.blockNum, 1243);
                let stopped = false, stopping;
                if (mode === 'stop') {stopping = value.controller.stop().then(() => {stopped = true;}); await Promise.resolve(); assert.equal(stopped, false);}
                else value.controller.invalidateMappingRetryEligibility();
                held.release(); await draining; await stopping;
                await value.controller.drain(); assert.equal(value.counts.source, mode === 'stop' ? 1 : 2);
            } finally {held.release(); await value.controller.stop();}
        }
    } finally {await original.dispose();}
});

test('fencing after a successful durable mark preserves the primary mapping failure and mints no pause', {timeout: 30000}, async () => {
    const original = await originalWireRows(); original.releaseThrough(1251);
    try {
        for (const boundary of ['marker', 'fallback-recovery']) {
            const value = await fixture(original, 1000, {projections: [invalid], maximumFramesPerProjection: 1,
                beforeCreate({adapter}) {
                    const mark = adapter.markIncomplete.bind(adapter), recovery = adapter.recovery.bind(adapter); let once = true, reads = 0;
                    adapter.markIncomplete = async (...args) => {await mark(...args);
                        if (boundary === 'marker' && once && args[2] !== 'Canonical projection source admitted; durable application is pending') {
                            once = false; currentProofConsumerScope(true).fence();
                        }
                    };
                    adapter.recovery = async (...args) => {const row = await recovery(...args);
                        if (boundary === 'fallback-recovery' && ++reads === 2) currentProofConsumerScope(true).fence(); return row;
                    };
                }});
            try {
                await assert.rejects(value.controller.drain(), error => error.code === 'projection.invalid-contract'
                    && error.message.includes('qualification_missing_required'));
                await value.controller.drain(); assert.equal(value.counts.source, 2, boundary + ': cancelled origin grants no pause');
            } finally {await value.controller.stop();}
        }
    } finally {await original.dispose();}
});

test('a held initial invalid source still waits while healthy eight-frame lanes finish; concurrent drains share ownership', {timeout: 30000}, async () => {
    const original = await originalWireRows(); original.releaseThrough(1251);
    const entered = gate(), held = gate();
    const value = await fixture(original, 1000, {beforeCreate({source}) {const frame = source.frame;
        source.frame = async (height, definition, admit) => {const result = await frame(height, definition, admit);
            if (definition.id === invalid.id) {entered.release(); await held.promise;} return result;
        };}});
    try {
        let settled = false; const draining = value.controller.drain().then(() => {settled = true;});
        await entered.promise;
        await until(() => plan.definitions.every(definition => value.metadata.get(definition.id).checkpoint.blockNum === 1251));
        assert.equal(settled, false, 'eligibility never fabricates physical completion of an already-held operation');
        const same = value.controller.drain(); assert.equal(value.counts.source, 17);
        held.release(); await Promise.all([draining, same]);
        await value.controller.drain(); assert.equal(value.calls.filter(call => call.projectionId === invalid.id).length, 1);
    } finally {held.release(); await value.controller.stop(); await original.dispose();}
});

test('actual projection worker lifecycle handlers discard timing on owner/fork/config/stop notifications', {timeout: 30000}, async () => {
    const {default: ProjectionWorker} = await import('../../build/indexer/workers/projection.js');
    const original = await originalWireRows(); original.releaseThrough(1251);
    const value = await fixture(original, 1000, {projections: [invalid], maximumFramesPerProjection: 1});
    const worker = {controller: value.controller, stopped: false};
    try {
        await value.controller.drain(); await value.controller.drain(); assert.equal(value.counts.source, 1);
        for (const [index, event] of ['worker_attempt_fence_active', 'worker_attempt_fence', 'reload_config', 'reload_contract_config'].entries()) {
            ProjectionWorker.prototype.onIpcMessage.call(worker, {event});
            await value.controller.drain(); assert.equal(value.counts.source, index + 2, event + ' invalidates the old timing record');
        }
        ProjectionWorker.prototype.onIpcMessage.call(worker, {event: 'stop'}); assert.equal(worker.stopped, true);
    } finally {await value.controller.stop(); await original.dispose();}
});

test('actual emitted worker run selects the bounded interval and stops through its original lifecycle', async () => {
    const {default: ProjectionWorker} = await import('../../build/indexer/workers/projection.js');
    const scope = new ProofConsumerScope('actual-worker-policy-selection'), observed = {connect: 0, close: 0, optionalClose: 0, drain: 0, stop: 0, invalidated: 0, exits: []};
    const mongo = {async connect() {observed.connect++;}, async close() {observed.close++;},
        db() {return {collection() {return {};}};}};
    const worker = Object.create(ProjectionWorker.prototype);
    Object.assign(worker, {chainId: 'c'.repeat(64), chain: 'mapping-retry-selection', protocolId: 'controlled-policy',
        protocolComponents: [{id: 'controlled-protocol', runtime: 'node', version: '0.0.0-dev.1', sourceRevision: 'c'.repeat(40), sha256: 'd'.repeat(64)}],
        protocol: {profileId: 'controlled-policy-v1', verifyNativeGenesis() {}}, protocolReady: Promise.resolve(), client: {},
        conf: {settings: {chain: 'mapping-retry-selection'}, indexer: {live_reader: true}, features: {portable_state: {
            backend: {kind: 'mongodb', id: 'controlled', database: 'controlled'}, projections: [first]}}},
        manager: {conn: {mongodb: {}}, mongodbClient: mongo,
            statefulCompleteKindMongoClient() {throw new Error('The portable-only worker must not allocate the optional client');},
            async closeStatefulCompleteKindMongoClient() {observed.optionalClose++;}}, stopped: false, statefulControllers: new Map(), probes: new Set(),
        profiler: {stopReporting() {}}, async runProjectionAttempt(kind, _metadata, operation) {
            assert.equal(kind, 'projection-initialization'); return scope.run(operation);
        }});
    const create = mock.method(PortableStateController, 'create', async options => {
        currentProofConsumerScope(true).assertActive(); observed.selected = options.mappingRetryEligibilityMs;
        return {async drain() {observed.drain++; worker.onIpcMessage({event: 'stop'});}, async stop() {observed.stop++;},
            invalidateMappingRetryEligibility() {observed.invalidated++;}};
    });
    const exit = mock.method(process, 'exit', code => {observed.exits.push(code);});
    try {
        await worker.run();
        assert.equal(observed.selected, 1000, 'the actual worker constructor call must select the reviewed capped policy');
        assert.deepEqual({...observed, selected: undefined}, {connect: 1, close: 1, optionalClose: 1, drain: 1, stop: 1, invalidated: 1, exits: [0], selected: undefined});
    } finally {create.mock.restore(); exit.mock.restore(); await scope.closeAndDrain();}
});
