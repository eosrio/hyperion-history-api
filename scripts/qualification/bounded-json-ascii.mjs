/** Service-free component comparison, never full replay or release qualification. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath, pathToFileURL} from 'node:url';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--baseline', '--candidate', '--source', '--output', '--major'].includes(args[i]) && args[i + 1], 'Explicit component paths/major required');
    assert.ok(!Object.hasOwn(options, args[i]), 'Duplicate argument'); options[args[i]] = args[i + 1];
}
assert.equal(Object.keys(options).length, 5);
assert.ok(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'Explicit native flags/module path required');
const major = Number(options['--major']);
assert.ok([24, 26].includes(major) && Number(process.versions.node.split('.')[0]) === major);
const root = fileURLToPath(new URL('../../', import.meta.url)), source = path.resolve(options['--source']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const setupStarted = performance.now(), harnessBytes = await readFile(fileURLToPath(import.meta.url));
const manifestBytes = await readFile(path.join(root, 'tests/fixtures/portable-state-worker/manifest.json'));
assert.equal(hash(manifestBytes), 'fa48079240a25d6fddfe80b83539bf0735be0f03b034dd816205c7e815d2d305');
const manifest = JSON.parse(manifestBytes), inputPins = [];
async function captured(name) {
    const bytes = await readFile(path.join(source, name)), expected = manifest.members.find(row => row.path === 'source/' + name);
    assert.ok(expected && bytes.length === expected.bytes && hash(bytes) === expected.sha256, 'Captured source bytes differ');
    inputPins.push({path: 'source/' + name, bytes: bytes.length, sha256: hash(bytes)}); return bytes;
}
const schemaBytes = await captured('schema.json'), schemaJson = schemaBytes.toString('utf8');
const abi = JSON.parse(schemaJson), frame803 = await captured('block-000803.bin'), frame805 = await captured('block-000805.bin');
// Independent oracle for these JSON.parse-owned inputs: sorted keys and native primitive JSON/UTF-8 encoding.
function oracle(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(oracle).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + oracle(value[key])).join(',') + '}';
}
const inputs = [
    {name: 'retained-frame803', value: {frameHex: frame803.toString('hex'), schemaJson}},
    {name: 'retained-frame805', value: {frameHex: frame805.toString('hex'), schemaJson}},
    {name: 'captured-ship-abi', value: abi},
    {name: 'mixed-unicode-controls', value: {ascii: 'plain text', escaped: '"\\\n\t\u0000', unicode: 'é中😀', nested: [true, null, 42]}}
].map(row => ({...row, expected: oracle(row.value)}));
const modulePins = {}, implementations = {};
for (const variant of ['baseline', 'candidate']) {
    const filename = path.resolve(options['--' + variant]), bytes = await readFile(filename);
    modulePins[variant] = {path: filename, bytes: bytes.length, sha256: hash(bytes)};
    implementations[variant] = (await import(pathToFileURL(filename).href)).boundedCanonicalJson;
    assert.equal(typeof implementations[variant], 'function');
}
const correctness = [];
for (const input of inputs) {
    const bytes = Buffer.byteLength(input.expected), sha256 = hash(input.expected);
    for (const variant of ['baseline', 'candidate']) {
        const run = implementations[variant];
        const output = run(input.value, {maximumBytes: bytes});
        assert.equal(output, input.expected); assert.equal(hash(output), sha256);
        assert.throws(() => run(input.value, {maximumBytes: bytes - 1}), {message: 'JSON value exceeds bounded JSON byte budget'});
    }
    correctness.push({input: input.name, expectedBytes: bytes, expectedSha256: sha256, exactBytesAndHashBoth: true, exactBoundaryBoth: true, oneByteUnderRefusedBoth: true});
}
const warmupIterations = 64, measuredIterations = 1024, rounds = 5, order = ['baseline', 'candidate', 'candidate', 'baseline'];
for (const input of inputs) for (const variant of ['baseline', 'candidate'])
    for (let i = 0; i < warmupIterations; i++) assert.equal(implementations[variant](input.value), input.expected);
const setupElapsedMs = performance.now() - setupStarted, measurements = [];
for (const input of inputs) for (let round = 0; round < rounds; round++) for (let position = 0; position < order.length; position++) {
    const variant = order[position], run = implementations[variant], memoryBefore = process.memoryUsage(), cpuBefore = process.cpuUsage();
    const wallStart = performance.now(), monotonicStartNs = process.hrtime.bigint();
    let result;
    for (let i = 0; i < measuredIterations; i++) result = run(input.value);
    const monotonicEndNs = process.hrtime.bigint(), elapsedMs = performance.now() - wallStart, cpuMicros = process.cpuUsage(cpuBefore), memoryAfter = process.memoryUsage();
    assert.equal(result, input.expected);
    measurements.push({input: input.name, round, position, variant, iterations: measuredIterations, elapsedMs,
        monotonicStartNs: String(monotonicStartNs), monotonicEndNs: String(monotonicEndNs), cpuMicros,
        memoryBefore, memoryAfter, finalOutputSha256: hash(result), successfulCalls: measuredIterations});
}
// Finite post-measurement observations: intrinsic wrappers never precede or affect timed batches.
// Transparent wrappers count actual intrinsic calls; no substitute serializer or injected delay.
const work = [];
for (const variant of ['baseline', 'candidate']) {
    const originalChar = String.prototype.charCodeAt, originalTest = RegExp.prototype.test, originalJson = JSON.stringify;
    let characters = 0, regex = 0, encodings = 0;
    try {
        String.prototype.charCodeAt = function(...args) {characters++; return originalChar.apply(this, args);};
        RegExp.prototype.test = function(...args) {regex++; return originalTest.apply(this, args);};
        JSON.stringify = function(...args) {encodings++; return originalJson.apply(this, args);};
        const value = frame805.toString('hex'), expected = '"' + value + '"';
        assert.equal(implementations[variant](value, {maximumBytes: value.length + 2}), expected);
        const fitting = {charCodeAtCalls: characters, regexTests: regex, nativeJsonEncodings: encodings};
        characters = regex = encodings = 0;
        assert.throws(() => implementations[variant](value, {maximumBytes: 2}), {message: 'JSON value exceeds bounded JSON byte budget'});
        work.push({variant, input: 'actual-frame805-hex-string', characters: value.length, fitting,
            insufficientLowerBound: {charCodeAtCalls: characters, regexTests: regex, nativeJsonEncodings: encodings}});
        assert.equal(encodings, 0, 'No full encoded allocation before impossible byte budget');
        if (variant === 'candidate' && modulePins.baseline.sha256 !== modulePins.candidate.sha256)
            assert.equal(regex, 0, 'No ASCII scan before impossible lower-bound refusal');
    } finally {
        String.prototype.charCodeAt = originalChar; RegExp.prototype.test = originalTest; JSON.stringify = originalJson;
    }
}
function distribution(values) {
    const sorted = [...values].sort((a, b) => a - b), q = p => sorted[Math.ceil(sorted.length * p) - 1];
    return {count: sorted.length, minimum: sorted[0], p50: q(.5), p95: q(.95), maximum: sorted.at(-1), mean: sorted.reduce((a, b) => a + b, 0) / sorted.length};
}
const summaries = inputs.map(input => ({input: input.name, variants: Object.fromEntries(['baseline', 'candidate'].map(variant => {
    const rows = measurements.filter(row => row.input === input.name && row.variant === variant);
    return [variant, {wallMsPerCall: distribution(rows.map(row => row.elapsedMs / row.iterations)),
        cpuMicrosPerCall: distribution(rows.map(row => (row.cpuMicros.user + row.cpuMicros.system) / row.iterations)), successfulCalls: rows.reduce((n, row) => n + row.successfulCalls, 0)}];
}))}));
for (const variant of ['baseline', 'candidate']) assert.equal(hash(await readFile(modulePins[variant].path)), modulePins[variant].sha256, 'Compared module changed');
assert.equal(hash(await readFile(fileURLToPath(import.meta.url))), hash(harnessBytes), 'Harness changed');
assert.deepEqual(abi, JSON.parse(schemaJson));
const runtimeBytes = await readFile(process.execPath);
const result = {schemaVersion: 1, scope: 'Service-free boundedCanonicalJson component only; no full worker/replay qualification',
    harness: {path: fileURLToPath(import.meta.url), bytes: harnessBytes.length, sha256: hash(harnessBytes)},
    sourceBaseline: 'd08b4127fe434a8fb408e149b23d8fa9b6206abe', fixtureArchiveSha256: manifest.archive.sha256, inputPins, modulePins,
    runtime: {executable: process.execPath, bytes: runtimeBytes.length, sha256: hash(runtimeBytes), versions: process.versions, execArgv: process.execArgv,
        platform: process.platform, architecture: process.arch, osRelease: os.release(), cpu: os.cpus()[0]?.model, logicalCPUs: os.cpus().length},
    protocol: {setupElapsedMs, warmupIterations, measuredIterations, rounds, order, independentUtf8Oracle: true,
        wallAndCPUFiniteBatches: true, performancePassThreshold: null, noInjectedDelay: true, noCacheOrExternalServices: true},
    correctness, work, measurements, summaries, limits: ['Shared Windows host and warm finite component batches; no Linux or full-pipeline speedup claim.',
        'Intrinsic work counters are untimed setup observations, not a throughput pass/fail.', 'Memory snapshots are boundary observations, not allocation/retention or capacity qualification.']};
await writeFile(path.resolve(options['--output']), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({output: path.resolve(options['--output']), measurements: measurements.length, summaries}));
