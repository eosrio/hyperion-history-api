import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, mkdir, writeFile, symlink, lstat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {
    assertNativeRuntime, buildFixtures, callOrder, cardinalities, decodeMetadata, freshOutput,
    gcOverlap, limits, parseOptions, selectCounter, validateOutputArgument, writeFreshReport,
} from '../../scripts/qualification/projection-validation-kernel.mjs';

// Bun's native runner owns its tests; native Node uses node:test without loading Bun.
const runner = await import(process.versions.bun ? 'bun:test' : 'node:test');
function test(name: string, optionsOrOperation: any, operation?: any) {
    const options = typeof optionsOrOperation === 'function' ? {} : optionsOrOperation;
    const body = operation ?? optionsOrOperation;
    if (process.versions.bun) {
        if (options.skip) runner.test.skip(name, body);
        else runner.test(name, body, 120000);
    } else runner.test(name, options, body);
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = join(root, 'scripts/qualification/projection-validation-kernel.mjs');
const fixture = join(root, 'tests/fixtures/projection-validation');
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const native = process.versions.bun ? process.env.HYPERION_NATIVE_NODE ?? process.env.HYPERION_TEST_NODE ?? 'node' : process.execPath;
let nativeAvailable = false;
try {nativeAvailable = /^v(?:22|24)\./.test(execFileSync(native, ['--version'], {encoding: 'utf8', timeout: 5000, windowsHide: true}));} catch {}
const nativeOnly = {skip: !nativeAvailable};

async function temporary(operation: (directory: string) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), 'hyperion-validation-kernel-'));
    try {await operation(directory);} finally {
        // mkdtemp owns this exact ordinary directory; no computed or shared checkout is removed.
        const info = await lstat(directory);
        assert.ok(info.isDirectory() && !info.isSymbolicLink());
        assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
        assert.match(directory.slice(dirname(directory).length + 1), /^hyperion-validation-kernel-/);
        await rm(directory, {recursive: true});
    }
}

async function original() {
    const origin = JSON.parse(await readFile(join(fixture, 'origin.json'), 'utf8'));
    return {origin, packed: await readFile(join(fixture, 'metadata.json.gz.base64'))};
}

function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
    const result = spawnSync(native, args, {cwd: root, encoding: 'utf8', timeout: 120000,
        windowsHide: true, maxBuffer: 1024 * 1024, env});
    assert.ifError(result.error);
    return result;
}

test('only explicit native Node 22/24 measurement runtimes are accepted', () => {
    for (const version of ['v22.0.0', 'v22.23.3', 'v24.19.0', 'v24.99.1']) {
        assert.doesNotThrow(() => assertNativeRuntime({version, release: {name: 'node'}, versions: {}}));
    }
    for (const version of ['v20.0.0', 'v23.0.0', 'v26.4.0', '24.19.0', 'v224.0.0']) {
        assert.throws(() => assertNativeRuntime({version, release: {name: 'node'}, versions: {}}));
    }
    assert.throws(() => assertNativeRuntime({version: 'v24.19.0', release: {name: 'node'}, versions: {bun: '1.4.3'}}));
    assert.throws(() => assertNativeRuntime({version: 'v24.19.0', release: {name: 'other'}, versions: {}}));
});

test('CLI bounds separate count capture from bounded timing options', () => {
    assert.deepEqual(parseOptions(['--mode', 'count', '--out', 'count.json']),
        {mode: 'count', out: 'count.json', warmup: 2, iterations: 5, order: 'both'});
    assert.equal(parseOptions(['--mode', 'timing', '--out', 'time.json', '--warmup', '0', '--iterations', '30', '--order', 'reverse']).iterations, 30);
    for (const args of [[], ['--mode', 'count'], ['--mode', 'both', '--out', 'x.json'],
        ['--mode', 'count', '--out', 'x.json', '--warmup', '0'],
        ['--mode', 'count', '--out', 'x.json', '--mode', 'timing'],
        ['--mode', 'timing', '--out', 'x.json', '--iterations', '0'],
        ['--mode', 'timing', '--out', 'x.json', '--iterations', '31'],
        ['--mode', 'timing', '--out', 'x.json', '--warmup', '11'],
        ['--mode', 'timing', '--out', 'x.json', '--warmup', '-1'],
        ['--mode', 'timing', '--out', 'x.json', '--iterations', '01'],
        ['--mode', 'timing', '--out', 'x.json', '--order', 'random'],
        ['--mode', 'timing', '--out', 'x.json', '--extra', 'x']]) {
        assert.throws(() => parseOptions(args), 'Rejected argv: ' + args.join(' '));
    }
});

test('output names reject Windows aliases, drive-relative paths and unbounded leaves', () => {
    for (const value of ['', 'C:escape.json', 'C:', '../CON.json', 'NUL.json', 'con.json', 'aux.foo.json',
        'com1.json', 'lpt9.any.json', 'Mixed.json', '.json', '../..', 'x.json/', 'x\0.json',
        'a'.repeat(103) + '.json', 'a'.repeat(4097)]) {
        assert.throws(() => validateOutputArgument(value), 'Rejected path: ' + JSON.stringify(value));
    }
    for (const value of ['count.json', 'public-inputs-fresh.json', './out/count.json', 'C:/owned/count.json']) {
        assert.equal(validateOutputArgument(value), value);
    }
});

test('fresh exclusive output refuses existing files, missing parents, links and oversized reports', async () => {
    await temporary(async directory => {
        const path = await freshOutput(join(directory, 'fresh.json'));
        const receipt = await writeFreshReport(path, {exact: true});
        const bytes = await readFile(path);
        assert.equal(receipt.bytes, bytes.length); assert.equal(receipt.sha256, sha(bytes));
        await assert.rejects(freshOutput(path));
        await assert.rejects(writeFreshReport(path, {changed: true}));
        await assert.rejects(freshOutput(join(directory, 'missing', 'fresh.json')));
        await assert.rejects(writeFreshReport(join(directory, 'large.json'), {x: 'x'.repeat(limits.outputBytes)}));
        await assert.rejects(lstat(join(directory, 'large.json')));
        let linked = false;
        try {await symlink(join(directory, 'absent'), join(directory, 'dangling.json')); linked = true;} catch (error: any) {
            assert.ok(['EPERM', 'EACCES', 'ENOSYS'].includes(error.code));
        }
        if (linked) await assert.rejects(freshOutput(join(directory, 'dangling.json')));
    });
});

test('the compact exact fixture rejects corrupt, malformed and expanding inputs', async () => {
    const {origin, packed} = await original();
    const metadata = decodeMetadata(packed, origin);
    assert.equal(metadata.checkpoint.blockNum, 288); assert.equal(metadata.undo.length, 256);
    assert.throws(() => decodeMetadata(Buffer.from(packed.toString().replace(/\S/, '!')), origin));
    const wrong = structuredClone(origin); wrong.metadata.sha256 = '0'.repeat(64);
    assert.throws(() => decodeMetadata(packed, wrong));
    const oversized = structuredClone(origin); oversized.metadata.bytes = limits.metadataBytes + 1;
    assert.throws(() => decodeMetadata(packed, oversized));
    const expanded = Buffer.from(' '.repeat(limits.metadataBytes + 1)), compressed = gzipSync(expanded);
    const bomb = structuredClone(origin);
    Object.assign(bomb.metadata, {bytes: 1, sha256: sha(expanded), gzipBytes: compressed.length, gzipSha256: sha(compressed)});
    assert.throws(() => decodeMetadata(Buffer.from(compressed.toString('base64')), bomb));
    const malformed = Buffer.from('{'), packedMalformed = gzipSync(malformed), malformedOrigin = structuredClone(origin);
    Object.assign(malformedOrigin.metadata, {bytes: 1, sha256: sha(malformed), gzipBytes: packedMalformed.length, gzipSha256: sha(packedMalformed)});
    assert.throws(() => decodeMetadata(Buffer.from(packedMalformed.toString('base64')), malformedOrigin));
});

test('all six valid states keep exact fixed receipts, positive policy and original floor identities', async () => {
    const {origin, packed} = await original(), metadata = decodeMetadata(packed, origin), before = JSON.stringify(metadata);
    const fixtures = buildFixtures(metadata), receipts = new Map([metadata.floorReceipt, ...metadata.receipts].map(row => [row.blockNum, row]));
    assert.deepEqual(fixtures.map(row => row.descriptors), cardinalities);
    for (const {descriptors, state} of fixtures) {
        assert.equal(state.undo.length, descriptors); assert.equal(state.coverageFloor.blockNum, 288 - descriptors);
        assert.equal(state.receipts.length, 256); assert.equal(state.policy.maxBlocks, 256);
        assert.deepEqual(state.floorReceipt, receipts.get(288 - descriptors)); assert.deepEqual(state.receipts, metadata.receipts);
        if (descriptors) assert.equal(state.undo[0].block.previousBlockId, state.coverageFloor.blockId);
    }
    assert.equal(JSON.stringify(metadata), before);
    const broken = structuredClone(metadata); broken.undo[0].block.previousBlockId = '0'.repeat(64);
    assert.throws(() => buildFixtures(broken));
});

test('count selection preserves unavailable/ambiguous counters and validates function-only ranges', () => {
    const selector = {url: 'file:///exact.js', name: 'real'}, sources = new Map([['7', {utf16Length: 30, sha256: 'a'.repeat(64)}]]);
    const fn = (count = 3) => ({functionName: 'real', ranges: [{startOffset: 2, endOffset: 20, count}], isBlockCoverage: false});
    const scripts = (functions: any[]) => [{url: selector.url, scriptId: '7', functions}];
    assert.deepEqual(selectCounter([], selector, sources), {available: false, reason: 'no named entry returned', matches: 0});
    assert.equal(selectCounter(scripts([fn(), fn()]), selector, sources).reason, 'ambiguous named entries');
    assert.equal(selectCounter([...scripts([fn()]), ...scripts([fn()])], selector, sources).reason, 'ambiguous named entries');
    assert.equal(selectCounter(scripts([fn(0)]), selector, sources).range.count, 0);
    for (const malformed of [{...fn(), isBlockCoverage: true}, {...fn(), ranges: []}, fn(-1), fn(0.5),
        {...fn(), ranges: [{startOffset: 2, endOffset: 31, count: 1}]},
        {...fn(), ranges: [{startOffset: 2.5, endOffset: 20, count: 1}]}]) {
        assert.throws(() => selectCounter(scripts([malformed]), selector, sources));
    }
});

test('forward/reverse ordering and clipped GC intervals have explicit endpoint math', () => {
    assert.deepEqual(callOrder('both').map(row => row.cardinalities), [cardinalities, [...cardinalities].reverse()]);
    assert.throws(() => callOrder('random'));
    const entries = [{startTime: 5, duration: 8}, {startTime: 19, duration: 4}, {startTime: 20, duration: 3}, {startTime: 0, duration: 10}];
    assert.deepEqual(gcOverlap(entries, 10, 20), {events: 2, overlapMs: 4});
    assert.deepEqual(gcOverlap(entries, 30, 40), {events: 0, overlapMs: 0});
    assert.deepEqual(gcOverlap([], 1, 1), {events: 0, overlapMs: 0});
    assert.deepEqual(gcOverlap([{startTime: 1, duration: 8}, {startTime: 2, duration: 3}, {startTime: 5, duration: 5}], 3, 9), {events: 3, overlapMs: 6});
    assert.throws(() => gcOverlap([{startTime: 0, duration: -1}], 0, 2));
    assert.throws(() => gcOverlap([], 2, 1));
});

test('import does not read fixtures, run git, open inspector, observe GC or write files', nativeOnly, () => {
    const body = `
        import fs from 'node:fs'; import fsp from 'node:fs/promises';
        import cp from 'node:child_process'; import inspector from 'node:inspector';
        import {PerformanceObserver} from 'node:perf_hooks'; import {syncBuiltinESMExports} from 'node:module';
        const forbidden=()=>{throw Error('module import performed work')};
        for(const key of ['readFile','lstat','open','realpath','writeFile'])fsp[key]=forbidden;
        fs.createReadStream=forbidden; cp.execFileSync=forbidden; inspector.Session.prototype.connect=forbidden;
        PerformanceObserver.prototype.observe=forbidden; syncBuiltinESMExports();
        await import(${JSON.stringify(pathToFileURL(script).href)}); process.stdout.write('side-effect-free');`;
    const result = run(['--input-type=module', '-e', body]);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'side-effect-free');
});

test('backend-anchored SDK resolution chooses a nested import-only package over root', nativeOnly, async () => {
    await temporary(async directory => {
        const backend = join(directory, 'packages/backend/dist/rollback-contract.js');
        await mkdir(dirname(backend), {recursive: true}); await writeFile(backend, 'export {};');
        for (const prefix of [directory, join(directory, 'packages/backend')]) {
            const sdk = join(prefix, 'node_modules/@eosrio/hyperion-sdk');
            await mkdir(join(sdk, 'dist'), {recursive: true});
            await writeFile(join(sdk, 'package.json'), JSON.stringify({name: '@eosrio/hyperion-sdk', type: 'module', version: prefix === directory ? 'root' : 'nested', exports: {'./projection': {types: './dist/projection.d.ts', import: './dist/projection.js'}}}));
            await writeFile(join(sdk, 'dist/projection.js'), 'export const exact=true;');
        }
        const body = `import {resolveBackendSdk} from ${JSON.stringify(pathToFileURL(script).href)};
            process.stdout.write(JSON.stringify(await resolveBackendSdk(${JSON.stringify(backend)})));`;
        const result = run(['--input-type=module', '-e', body]);
        assert.equal(result.status, 0, result.stderr);
        const receipt = JSON.parse(result.stdout); assert.equal(receipt.version, 'nested');
        assert.equal(receipt.importTarget, './dist/projection.js'); assert.match(receipt.packageSha256, /^[a-f0-9]{64}$/);
    });
});

test('real count CLI validates inputs, calibrates reset/recursion and pins actual SDK source', nativeOnly, async () => {
    await temporary(async directory => {
        const path = join(directory, 'counts.json'), result = run([script, '--mode', 'count', '--out', path]);
        assert.equal(result.status, 0, result.stderr); const report = JSON.parse(await readFile(path, 'utf8'));
        assert.equal(report.status, 'measured'); assert.equal(report.mode, 'count'); assert.equal(report.provenance.validity.positiveCases, 12);
        assert.equal(report.provenance.validity.negativeCases, 13);
        assert.ok(report.provenance.validity.negatives.every((row: any) => row.code === 'projection.invalid-contract'));
        assert.equal(report.measured.calibrated, true); assert.equal(report.measured.countsAreNotCpuOrTiming, true);
        assert.equal(report.measured.captures.length, 33); assert.equal(report.measured.captures.filter((row: any) => row.phase === 'valid-count-only').length, 24);
        assert.ok(report.measured.sources.some((row: any) => row.sha256 === report.provenance.code[2].sha256));
        for (const row of report.measured.captures.filter((row: any) => row.phase === 'valid-count-only')) {
            assert.equal(row.metrics.state.range.count, row.repetitions); assert.ok(row.metrics.snapshot.range.count > 0);
            if (row.entry === 'metadata') assert.equal(row.metrics.metadata.range.count, row.repetitions);
        }
        assert.match(report.runtime.binarySha256, /^[a-f0-9]{64}$/); assert.equal(report.runtime.version, execFileSync(native, ['--version'], {encoding: 'utf8'}).trim());
        const before = await readFile(path), repeated = run([script, '--mode', 'count', '--out', path]);
        assert.notEqual(repeated.status, 0); assert.deepEqual(await readFile(path), before);
    });
});

test('real timing CLI emits bounded per-call spans and distinct CPU/RSS/GC without count capture', nativeOnly, async () => {
    await temporary(async directory => {
        const path = join(directory, 'timing.json'), result = run([script, '--mode', 'timing', '--out', path, '--warmup', '0', '--iterations', '1', '--order', 'both']);
        assert.equal(result.status, 0, result.stderr); const report = JSON.parse(await readFile(path, 'utf8')), measured = report.measured;
        assert.equal(report.mode, 'timing'); assert.equal(measured.preciseCoverageRequested, false);
        assert.equal(measured.rows.length, 24); assert.equal(measured.order, 'both'); assert.equal(measured.warmupPerStateAndEntryPerPass, 0);
        assert.equal(Object.hasOwn(measured, 'captures'), false); assert.ok(measured.processLifetimeMaxRSSKiB > 0);
        for (const row of measured.rows) {
            assert.equal(row.elapsedMs, row.endMs - row.startMs); assert.ok(row.elapsedMs >= 0);
            assert.ok(row.processCpuMicros.user >= 0 && row.processCpuMicros.system >= 0);
            assert.equal(row.processCpuMicros.total, row.processCpuMicros.user + row.processCpuMicros.system);
            assert.ok(row.rssBytes.before > 0 && row.rssBytes.after > 0); assert.equal(row.gc.available, measured.gc.available);
            if (row.gc.available) assert.ok(row.gc.overlapMs >= 0 && row.gc.overlapMs <= row.elapsedMs);
        }
        assert.equal(measured.unavailable.actualWorkerFrequency, 'Service-free kernel only');
    });
});

test('CLI rejects ambient coverage before creating its output', nativeOnly, async () => {
    await temporary(async directory => {
        const path = join(directory, 'forbidden.json');
        const result = run([script, '--mode', 'timing', '--out', path], {...process.env, NODE_V8_COVERAGE: join(directory, 'coverage')});
        assert.notEqual(result.status, 0); assert.match(result.stderr, /Ambient V8 coverage/); await assert.rejects(lstat(path));
    });
});
