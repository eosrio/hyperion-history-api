/** Native controlled transport regression; no live Mongo, source proof or release qualification. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync, mkdtempSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {mongoSamplingComponent, recorded} from './portable-state-mongo-sampling-fixture.mjs';
import {samplePortableMongoIsolation, createPortableMongoSamples} from '../../scripts/qualification/portable-state-mongo-sampling.ts';
import {isPortableMongoAdmissionTransition} from '../../scripts/qualification/portable-state-worker-mongo.ts';
import {assertNativeQualificationRuntime} from '../../scripts/qualification/native-node-runtime.mjs';
assertNativeQualificationRuntime();
const captureRoot = new URL('../../out/mongo341/control-captures/', import.meta.url); mkdirSync(captureRoot, {recursive: true});
const recorder = label => {const directory = mkdtempSync(join(fileURLToPath(captureRoot), label + '-'));
    return {directory, capture: createPortableMongoSamples(directory)};};
function options(component, capture, controls = {}) {let clock = 0;
    return {input: component.input, budget: {deadline: 1000}, now: () => clock,
        sleep: async milliseconds => {clock += milliseconds;}, recovery: component.recovery, query: component.query,
        guard() {}, capture: sample => capture.record(sample), ...controls};}

test('same-source fresh controller admission is retained, then a complete coherent mapping-error sample passes in the original phase', async () => {
    const c = await mongoSamplingComponent(), {capture, directory} = recorder('transient');
    assert.equal(c.input.source[1242].blockId, recorded.checkpoint.blockId);
    assert.equal(c.input.source[1243].blockId, recorded.failedBlock.blockId);
    await c.audit(); c.state.calls.length = 0; const retry = await c.retry(); let closed = false, clock = 0, guards = 0;
    try {
        const sampled = await samplePortableMongoIsolation(options(c, capture, {guard() {guards++;}, now: () => clock,
            sleep: async milliseconds => {clock += milliseconds; await retry.close(); closed = true; await c.settle();}}));
        assert.equal(sampled.physical.readOnly, true); assert.match(sampled.isolation.recovery.pending.reason, /Required source field is missing/);
        assert.equal(sampled.isolation.api.status, 503); assert.equal(guards, 4);
        assert.deepEqual(capture.evidence.records.map(value => value.outcome), ['admission-transition', 'passed']);
        assert.equal(capture.evidence.failedCaptures, 0); assert.equal(capture.evidence.rejected, 1); assert.equal(capture.evidence.accepted, 1);
        const samples = capture.evidence.records.map(value => {const bytes = readFileSync(join(directory, value.file));
            assert.equal(createHash('sha256').update(bytes).digest('hex'), value.sha256); return JSON.parse(bytes);});
        assert.equal(samples[0].physical.complete, true); assert.ok(samples[0].physical.observations.serverAfter);
        assert.equal(samples[0].logical.pending.reason, 'Canonical projection source admitted; durable application is pending');
        assert.match(samples[1].logical.pending.reason, /Required source field is missing/);
        assert.equal(samples[0].deadline, samples[1].deadline); assert.equal(samples[0].logical.checkpoint.blockNum, 1243);
        assert.equal(samples[0].logical.pending.block.blockNum, 1244);
        assert.ok(c.state.calls.filter(value => value.options?.timeoutMS).every(value => value.options.timeoutMS <= 1000));
    } finally {if (!closed) await retry.close(); await c.close();}
});

test('a reason-only metadata snapshot transition is rejected and retained before a fresh coherent sample', async () => {
    const c = await mongoSamplingComponent(), {capture, directory} = recorder('snapshot'); let retry, clock = 0;
    c.state.beforeMetadata = async number => {if (number === 2) retry = await c.retry();};
    try {
        await samplePortableMongoIsolation(options(c, capture, {now: () => clock, sleep: async milliseconds => {
            clock += milliseconds; await retry.close(); retry = undefined; await c.settle();}}));
        assert.deepEqual(capture.evidence.records.map(value => value.outcome), ['admission-transition', 'passed']);
        const first = JSON.parse(readFileSync(join(directory, capture.evidence.records[0].file)));
        assert.match(first.logical.pending.reason, /Required source field is missing/);
        const obs = first.physical.observations, old = obs.metadataBefore.find(value => value.binding.projectionId === c.binding.projectionId),
            fresh = obs.metadataSnapshot.find(value => value.binding.projectionId === c.binding.projectionId);
        assert.match(old.pending.reason, /Required source field is missing/);
        assert.equal(fresh.pending.reason, 'Canonical projection source admitted; durable application is pending');
        assert.ok(obs.serverAfter); assert.equal(first.physical.complete, true);
    } finally {if (retry) await retry.close(); await c.close();}
});

test('permanent admission-pending fails in the original remaining deadline and retains every rejected sample', async () => {
    const c = await mongoSamplingComponent(), {capture} = recorder('permanent'), retry = await c.retry(); let clock = 0;
    try {
        await assert.rejects(samplePortableMongoIsolation(options(c, capture, {budget: {deadline: 250}, now: () => clock,
            sleep: async milliseconds => {clock += milliseconds;}})), /inherited isolation deadline exceeded/);
        assert.equal(clock, 250); assert.equal(capture.evidence.rejected, 3); assert.equal(capture.evidence.attempts, 3);
        assert.equal(capture.evidence.accepted, 0); assert.equal(capture.evidence.failedCaptures, 0);
    } finally {await retry.close(); await c.close();}
});

test('an expired inherited budget performs no recovery, API, guard or physical work', async () => {
    const c = await mongoSamplingComponent(), {capture} = recorder('expired');
    try {
        await assert.rejects(samplePortableMongoIsolation(options(c, capture, {budget: {deadline: 0},
            recovery: async () => assert.fail('expired recovery'), query: async () => assert.fail('expired API'),
            guard: () => assert.fail('expired guard')})), /inherited isolation deadline exceeded/);
        assert.equal(c.state.calls.length, 0); assert.equal(capture.evidence.attempts, 0);
    } finally {await c.close();}
});

const physicalNegatives = [
    ['binding-generation', c => {c.healthyMetadata().binding.generation = 'f'.repeat(64);}],
    ['definition', c => {c.healthyMetadata().definition.fields[0].path = ['foreign'];}],
    ['definition-digest', c => {c.healthyMetadata().definitionHash = 'f'.repeat(64);}],
    ['storage-version', c => {c.healthyMetadata().storageVersion = 'foreign';}],
    ['checkpoint', c => {c.healthyMetadata().checkpoint = recorded.source[1242];}],
    ['not-initialized', c => {c.healthyMetadata().initialized = false;}],
    ['gap', c => {c.healthyMetadata().gap = {reason: 'missing source'};}],
    ['failed-source-id', c => {c.metadata().pending.block.blockId = 'f'.repeat(64);}],
    ['failed-source-height', c => {c.metadata().pending.block.blockNum++;}],
    ['failed-parent', c => {c.metadata().pending.block.previousBlockId = 'f'.repeat(64);}],
    ['failed-digest', c => {c.metadata().pending.digest = 'f'.repeat(64);}],
    ['wrong-reason', c => {c.metadata().pending.reason = 'A different failure must not retry';}],
    ['metadata-field', c => {c.healthyMetadata().extra = 'foreign';}],
    ['receipt-source', c => {c.healthyMetadata().receipts[0].blockId = 'f'.repeat(64);}],
    ['receipt-digest', c => {c.healthyMetadata().receipts[0].digest = 'invalid';}],
    ['receipt-order', c => {c.healthyMetadata().receipts.reverse();}],
    ['receipt-end', c => {c.healthyMetadata().receipts.pop();}],
    ['receipt-field', c => {c.healthyMetadata().receipts[0].extra = 1;}],
    ['receipt-bound', c => {c.healthyMetadata().receipts = Array(4097).fill(c.healthyMetadata().receipts[0]);}],
    ['extra-row', c => {const collection = [...c.fixture.storage].find(([name, rows]) => name !== 'h45_projection_metadata' && rows.size);
        collection[1].set('foreign', {_id: 'foreign', value: {id: '2', next: '2'}});}],
    ['missing-row', c => {const collection = [...c.fixture.storage].find(([name, rows]) => name !== 'h45_projection_metadata' && rows.size); collection[1].clear();}],
    ['wrong-key', c => {const row = [...c.fixture.storage].filter(([name]) => name !== 'h45_projection_metadata').flatMap(([, rows]) => [...rows.values()])[0]; row._id = 'foreign';}],
    ['wrong-value', c => {const row = [...c.fixture.storage].filter(([name]) => name !== 'h45_projection_metadata').flatMap(([, rows]) => [...rows.values()])[0]; row.value.next = '999';}],
    ['row-field', c => {const row = [...c.fixture.storage].filter(([name]) => name !== 'h45_projection_metadata').flatMap(([, rows]) => [...rows.values()])[0]; row.extra = 'foreign';}],
    ['namespace', c => {c.fixture.storage.set('foreign_collection', new Map());}],
];
for (const [label, mutate] of physicalNegatives) test(`admission transition cannot hide independent physical ${label}`, async () => {
    const c = await mongoSamplingComponent(), {capture, directory} = recorder(label), retry = await c.retry(); let sleeps = 0;
    c.state.beforeMetadata = number => {if (number === 1) mutate(c);};
    if (label === 'namespace') {mutate(c); c.state.beforeMetadata = undefined;}
    try {
        await assert.rejects(samplePortableMongoIsolation(options(c, capture, {sleep: async () => {sleeps++;}})));
        assert.equal(sleeps, 0); assert.equal(capture.evidence.attempts, 1); assert.equal(capture.evidence.accepted, 0);
        const failed = JSON.parse(readFileSync(join(directory, capture.evidence.records[0].file)));
        assert.equal(failed.outcome, 'fatal'); assert.equal(failed.retryable, false); assert.equal(failed.physical.outcome, 'fatal');
        assert.ok(failed.error && failed.physical.error);
    } finally {await retry.close(); await c.close();}
});

for (const [label, configure] of [
    ['server-process', c => {c.state.changeHello = (value, call) => {if (call === 2) value.topologyVersion.processId = 'foreign';};}],
    ['server-set', c => {c.state.changeHello = value => {value.setName = 'foreign';};}],
    ['server-primary', c => {c.state.changeHello = value => {value.isWritablePrimary = false;};}],
    ['collation', c => {c.state.changeCollections = rows => {rows[0].options.collation.locale = 'en';};}],
    ['capped', c => {c.state.changeCollections = rows => {rows[0].options.capped = true;};}],
    ['view', c => {c.state.changeCollections = rows => {rows[0].type = 'view';};}],
    ['document-byte-bound', c => {c.state.largeBuild = true;}],
    ['aggregate-byte-bound', c => {c.state.changeCollections = rows => {for (const row of rows) row.options.noise = 'x'.repeat(900000);};}],
    ['snapshot-read-failure', c => {c.state.beforeMetadata = number => {if (number === 2) throw new Error('snapshot read rejected');};}],
    ['snapshot-checkpoint-transition', c => {c.state.beforeMetadata = number => {if (number === 2) c.healthyMetadata().checkpoint = recorded.source[1242];};}],
    ['after-checkpoint-transition', c => {c.state.beforeMetadata = number => {if (number === 3) c.healthyMetadata().checkpoint = recorded.source[1242];};}],
]) test(`admission transition cannot hide independent ${label}`, async () => {
    const c = await mongoSamplingComponent(), {capture} = recorder(label), retry = await c.retry(); let sleeps = 0; configure(c);
    try {
        await assert.rejects(samplePortableMongoIsolation(options(c, capture, {sleep: async () => {sleeps++;}})));
        assert.equal(sleeps, 0); assert.equal(capture.evidence.attempts, 1); assert.equal(capture.evidence.accepted, 0);
        assert.equal(capture.evidence.records[0].outcome, 'fatal');
    } finally {await retry.close(); await c.close();}
});

test('logical wrong reason, API success, and original liveness guards are fatal without physical retry', async () => {
    for (const variant of ['reason', 'api', 'guard']) {
        const c = await mongoSamplingComponent(), {capture} = recorder('logical-' + variant); let sleeps = 0;
        try {
            const control = {sleep: async () => {sleeps++;}};
            if (variant === 'reason') control.recovery = async () => ({...await c.recovery(), pending: {...(await c.recovery()).pending, reason: 'foreign'}});
            if (variant === 'api') control.query = async () => ({...await c.query(), status: 200});
            if (variant === 'guard') control.guard = () => assert.fail('actual child exited or report capture error');
            await assert.rejects(samplePortableMongoIsolation(options(c, capture, control)));
            assert.equal(sleeps, 0); assert.equal(c.state.calls.length, 0); assert.equal(capture.evidence.accepted, 0);
        } finally {await c.close();}
    }
});

test('physical completion and post-capture expiration never start a new deadline or pass the phase', async () => {
    for (const phase of ['read', 'capture']) {
        const c = await mongoSamplingComponent(), {capture} = recorder('expiry-' + phase); let clock = 0;
        if (phase === 'read') c.state.beforeMetadata = number => {if (number === 2) clock = 1000;};
        try {
            await assert.rejects(samplePortableMongoIsolation(options(c, capture, {now: () => clock,
                capture: sample => {capture.record(sample); if (phase === 'capture') clock = 1000;}})), /inherited isolation deadline exceeded/);
            assert.equal(clock, 1000); assert.equal(capture.evidence.attempts, 1);
            if (phase === 'read') assert.equal(capture.evidence.accepted, 0);
        } finally {await c.close();}
    }
});

test('record count exhaustion and file collision are explicit capture failures with all earlier records intact', async () => {
    const {capture} = recorder('capture-exhausted'); const sample = {schemaVersion: 1, attempt: 1, through: 1244,
        deadline: 1000, started: 0, completed: 0, outcome: 'admission-transition', retryable: true};
    for (let i = 0; i < 64; i++) capture.record(sample);
    assert.throws(() => capture.record(sample), /record budget exhausted/);
    assert.equal(capture.evidence.records.length, 64); assert.equal(capture.evidence.rejected, 64);
    assert.equal(capture.evidence.attempts, 65); assert.equal(capture.evidence.failedCaptures, 1);
    const original = recorder('capture-collision'); original.capture.record(sample);
    const again = createPortableMongoSamples(original.directory);
    assert.throws(() => again.record(sample), /EEXIST/); assert.equal(again.evidence.failedCaptures, 1);
    assert.equal(again.evidence.records.length, 0);
});

test('a logical admission view cannot borrow a later physical required-field view for immediate success', async () => {
    const c = await mongoSamplingComponent(), {capture, directory} = recorder('logical-transition'), retry = await c.retry();
    let clock = 0, queries = 0, closed = false;
    try {
        await samplePortableMongoIsolation(options(c, capture, {now: () => clock, query: async () => {
            if (++queries === 1) {await retry.close(); closed = true; await c.settle();} return c.query();},
            sleep: async milliseconds => {clock += milliseconds;}}));
        assert.deepEqual(capture.evidence.records.map(value => value.outcome), ['admission-transition', 'passed']);
        const first = JSON.parse(readFileSync(join(directory, capture.evidence.records[0].file)));
        assert.equal(first.physical.outcome, 'passed');
        assert.equal(first.logical.pending.reason, 'Canonical projection source admitted; durable application is pending');
        assert.equal(queries, 2);
    } finally {if (!closed) await retry.close(); await c.close();}
});

test('a held actual adapter recovery read stays awaited, receives the remaining cap and cannot earn late acceptance', async () => {
    const c = await mongoSamplingComponent(), {capture} = recorder('held-recovery'); let clock = 0, entered, release, apiCalls = 0, settled = false;
    const started = new Promise(resolve => {entered = resolve;}), hold = new Promise(resolve => {release = resolve;});
    c.fixture.beforeFind = async (_name, opts) => {assert.equal(opts.timeoutMS, 75); entered(); await hold;};
    const pending = samplePortableMongoIsolation(options(c, capture, {budget: {deadline: 75}, now: () => clock,
        query: async () => {apiCalls++; return c.query();}}));
    pending.then(() => {settled = true;}, () => {settled = true;});
    try {
        await started; await Promise.resolve(); assert.equal(settled, false); assert.equal(apiCalls, 0); assert.equal(c.state.calls.length, 0);
        clock = 76; release(); await assert.rejects(pending, /inherited isolation deadline exceeded/);
        assert.equal(settled, true); assert.equal(apiCalls, 0); assert.equal(c.state.calls.length, 0);
        assert.equal(capture.evidence.attempts, 1); assert.equal(capture.evidence.accepted, 0);
    } finally {release(); await c.close();}
});

test('a timeout-shaped rejection from the actual capped recovery adapter is fatal and retains its original cause', async () => {
    const c = await mongoSamplingComponent(), {capture, directory} = recorder('timeout-recovery'); let sleeps = 0, apiCalls = 0;
    const original = Object.assign(new Error('controlled recovery operation timed out'), {name: 'MongoOperationTimeoutError', code: 50});
    c.fixture.beforeFind = async (_name, opts) => {assert.equal(opts.timeoutMS, 25); throw original;};
    try {
        await assert.rejects(samplePortableMongoIsolation(options(c, capture, {budget: {deadline: 25},
            query: async () => {apiCalls++; return c.query();}, sleep: async () => {sleeps++;}})), /MongoDB projection operation did not complete/);
        assert.equal(apiCalls, 0); assert.equal(sleeps, 0); assert.equal(c.state.calls.length, 0);
        const failed = JSON.parse(readFileSync(join(directory, capture.evidence.records[0].file)));
        assert.equal(failed.outcome, 'fatal'); assert.equal(failed.error.cause.name, 'MongoOperationTimeoutError');
        assert.equal(failed.error.cause.code, 50); assert.equal(failed.error.cause.message, original.message);
    } finally {await c.close();}
});

test('copied and stale transition errors cannot issue a retry classification for another physical sample', async () => {
    const c = await mongoSamplingComponent(), retry = await c.retry(); let issued;
    try {
        await assert.rejects(c.audit(), error => {issued = error; return isPortableMongoAdmissionTransition(error);});
        assert.equal(isPortableMongoAdmissionTransition(Object.assign(new Error(issued.message), issued)), false);
        assert.equal(isPortableMongoAdmissionTransition(JSON.parse(JSON.stringify(issued))), false);
        c.state.metadataReads = 0; c.state.beforeMetadata = number => {if (number === 2) throw issued;};
        const {capture, directory} = recorder('stale-transition'); let sleeps = 0;
        await assert.rejects(samplePortableMongoIsolation(options(c, capture, {sleep: async () => {sleeps++;}})), error => error === issued);
        assert.equal(sleeps, 0); assert.equal(capture.evidence.accepted, 0);
        const failed = JSON.parse(readFileSync(join(directory, capture.evidence.records[0].file)));
        assert.equal(failed.outcome, 'fatal'); assert.equal(failed.physical.outcome, 'fatal'); assert.equal(failed.physical.complete, false);
    } finally {await retry.close(); await c.close();}
});

test('bounded per-record/aggregate bytes and serialization failures retain their explicit incomplete-capture counters', () => {
    const sample = {schemaVersion: 1, attempt: 1, through: 1244, deadline: 1000, started: 0, outcome: 'fatal', retryable: false};
    const oversized = recorder('oversized-record');
    assert.throws(() => oversized.capture.record({...sample, error: {message: 'x'.repeat(8 * 1024 * 1024)}}), /record byte budget exhausted/);
    assert.equal(oversized.capture.evidence.failedCaptures, 1); assert.equal(oversized.capture.evidence.records.length, 0);
    const aggregate = recorder('aggregate-record'), bounded = {...sample, error: {message: 'x'.repeat(7.5 * 1024 * 1024)}};
    for (let i = 0; i < 8; i++) aggregate.capture.record(bounded);
    assert.throws(() => aggregate.capture.record(bounded), /total byte budget exhausted/);
    assert.equal(aggregate.capture.evidence.failedCaptures, 1); assert.equal(aggregate.capture.evidence.records.length, 8);
    const cyclic = recorder('cyclic-record'), error = {}; error.self = error;
    assert.throws(() => cyclic.capture.record({...sample, error}));
    assert.equal(cyclic.capture.evidence.failedCaptures, 1); assert.equal(cyclic.capture.evidence.records.length, 0);
});

test('a capture failure during a physical admission transition stops before any retry or late acceptance', async () => {
    const c = await mongoSamplingComponent(), retry = await c.retry(), original = recorder('pipeline-collision'); let sleeps = 0;
    original.capture.record({schemaVersion: 1, attempt: 0, through: 1244, deadline: 1000, started: 0, outcome: 'sentinel', retryable: false});
    const capture = createPortableMongoSamples(original.directory);
    try {
        await assert.rejects(samplePortableMongoIsolation(options(c, capture, {sleep: async () => {sleeps++;}})), /EEXIST/);
        assert.equal(sleeps, 0); assert.equal(capture.evidence.failedCaptures, 1); assert.equal(capture.evidence.accepted, 0);
        assert.equal(original.capture.evidence.records.length, 1);
    } finally {await retry.close(); await c.close();}
});

test('each logical identity/source/digest invariant and unavailable API field stays fatal before physical work', async () => {
    const variants = ['binding', 'checkpoint', 'source', 'digest', 'initialized', 'gap', 'retryable', 'retry-after', 'state-header', 'rows'];
    for (const variant of variants) {
        const c = await mongoSamplingComponent(), {capture} = recorder('logical-' + variant); let sleeps = 0;
        const control = {sleep: async () => {sleeps++;}};
        if (variants.indexOf(variant) < 6) control.recovery = async timeout => {
            const value = await c.recovery(timeout);
            if (variant === 'binding') value.binding.generation = 'f'.repeat(64);
            if (variant === 'checkpoint') value.checkpoint.blockId = 'f'.repeat(64);
            if (variant === 'source') value.pending.block.blockId = 'f'.repeat(64);
            if (variant === 'digest') value.pending.digest = 'f'.repeat(64);
            if (variant === 'initialized') value.initialized = false;
            if (variant === 'gap') value.gap = {reason: 'foreign'};
            return value;
        };
        else control.query = async () => {const value = await c.query();
            if (variant === 'retryable') value.body.retryable = false;
            if (variant === 'retry-after') value.headers['retry-after'] = '2';
            if (variant === 'state-header') value.headers['hyperion-state-block-num'] = '1243';
            if (variant === 'rows') value.body.rows = [];
            return value;
        };
        try {
            await assert.rejects(samplePortableMongoIsolation(options(c, capture, control)));
            assert.equal(sleeps, 0); assert.equal(c.state.calls.length, 0); assert.equal(capture.evidence.accepted, 0);
        } finally {await c.close();}
    }
});

test('the post-physical liveness guard cannot be bypassed by a complete physical result', async () => {
    const c = await mongoSamplingComponent(), {capture, directory} = recorder('after-guard'); let guards = 0;
    try {
        await assert.rejects(samplePortableMongoIsolation(options(c, capture, {guard() {if (++guards === 2) assert.fail('actual child exited after physical read');}})), /actual child exited/);
        const failed = JSON.parse(readFileSync(join(directory, capture.evidence.records[0].file)));
        assert.equal(failed.physical.complete, true); assert.equal(failed.physical.outcome, 'passed'); assert.equal(failed.outcome, 'fatal');
        assert.equal(capture.evidence.accepted, 0);
    } finally {await c.close();}
});
