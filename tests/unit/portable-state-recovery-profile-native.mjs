/** Native component controls only: captured CPU bytes and inherited prefix deadline; no services. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {assertNativeQualificationRuntime} from '../../scripts/qualification/native-node-runtime.mjs';
import * as recovery from '../../scripts/qualification/portable-state-recovery.ts';

const major = assertNativeQualificationRuntime(), mode = process.argv[2];
if (mode === 'prefix-deadline') {
    let now = 10_000, release, finalized = 0, verdict = false;
    const original = {inputHashes: {'source.bin': 'a'.repeat(64)}}, held = new Promise(yes => {release = yes;});
    const budget = new recovery.RecoveryRunDeadline(() => now); now = 909_999;
    const work = budget.completePrefix(async () => {await held; return original;}, original, async () => {finalized++;})
        .then(() => {verdict = true;});
    now = 910_001; release(); await assert.rejects(work, /deadline/);
    assert.equal(finalized, 0); assert.equal(verdict, false); assert.equal(budget.expiresAt, 910_000);
    let profileNow = 0, enter, finish, profileVerdict = false;
    const entered = new Promise(yes => {enter = yes;}), profileHeld = new Promise(yes => {finish = yes;});
    const profileBudget = new recovery.RecoveryRunDeadline(() => profileNow);
    const profile = profileBudget.completePrefix(async () => original, original, async () => {enter(); await profileHeld;})
        .then(() => {profileVerdict = true;});
    await entered; profileNow = 900_001; finish(); await assert.rejects(profile, /deadline/);
    assert.equal(profileVerdict, false);
    console.log(JSON.stringify({passed: true, mode, node: process.version, major, originalRunMs: 900_000,
        lateSourceAuditRejected: true, lateProfileCompletionRejected: true, noFinalizationAfterLateAudit: true,
        serviceExecution: false, fullQualification: false}));
} else {
assert.equal(mode, 'profile');
const origin = JSON.parse(await readFile(new URL('../fixtures/native-cpu-profile/origin.json', import.meta.url)));
const encoded = await readFile(new URL('../fixtures/native-cpu-profile/negative-delta.json.gz.base64', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(encoded.length, origin.base64.bytes); assert.equal(hash(encoded), origin.base64.sha256);
const packed = Buffer.from(encoded.toString().trim(), 'base64');
assert.equal(packed.length, origin.packed.bytes); assert.equal(hash(packed), origin.packed.sha256);
const bytes = gunzipSync(packed, {maxOutputLength: 1024 * 1024});
assert.equal(bytes.length, origin.member.bytes); assert.equal(hash(bytes), origin.member.sha256);
const root = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(root, 'hapi-prefix-native-profile-')));
try {
    const file = join(directory, 'worker-42.cpuprofile'); await writeFile(file, bytes, {flag: 'wx'});
    const rows = [{kind: 'start', pid: 42, role: 'projection'},
        {kind: 'profile_started', pid: 42, at: 100, samplingIntervalMicros: 10000, maximumDurationMs: 900000},
        {kind: 'profile_saved', pid: 42, profilePath: file, bytes: bytes.length},
        {kind: 'flush', pid: 42, at: 300, reason: 'qualifier_shutdown', success: true, error: null, droppedRecords: 0,
            profileState: 'saved', profilePath: file},
        {kind: 'exit', pid: 42, code: 0, profileState: 'saved', flushed: true, droppedRecords: 0},
        {kind: 'shutdown', pid: 42, success: true, forced: [], unresolved: [], failedChildren: [], childExits: []}];
    await writeFile(join(directory, 'worker-42.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n', {flag: 'wx'});
    const [profile] = await recovery.assertRecoveryCpuProfiles(rows, directory, 200, true, {pid: 42, exitCode: 0, signalCode: null});
    assert.equal(profile.samples, 40572); assert.equal(profile.sha256, origin.member.sha256);
    assert.equal(profile.timing.intervalWeightsAvailable, false);
    assert.deepEqual(profile.timing.firstNegativeDeltas, [{index: 45, deltaMicros: -4}]);
    assert.equal(profile.timing.rawSignedDeltaSumMicros, 409102052);
    assert.equal(profile.timing.sampledIntervalMicros, null); assert.equal(profile.timing.normalized, false);
    assert.deepEqual(await readFile(file), bytes);
    const valid = {nodes: [{id: 1}], samples: [1], startTime: 10, endTime: 30, timeDeltas: [10]};
    assert.equal(recovery.recoveryCpuProfileEvidence(valid).timing.sampledIntervalMicros, 10);
    const malformed = [{nodes: []}, {nodes: [{id: 1}, {id: 1}]}, {samples: [2]}, {timeDeltas: []},
        ...[null, '10', NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1].map(delta => ({timeDeltas: [delta]})),
        {endTime: 10}, {samples: Array(200001).fill(1)}, {nodes: Array(100001).fill({id: 1})},
        {samples: [1, 1], timeDeltas: [Number.MAX_SAFE_INTEGER, 1]}];
    for (const patch of malformed) assert.throws(() => recovery.recoveryCpuProfileEvidence({...valid, ...patch}));
    console.log(JSON.stringify({passed: true, mode, node: process.version, major, capturedSha256: origin.member.sha256,
        rawBytesUnchanged: true, negativeDeltaMicros: -4, samples: 40572, malformedCasesRejected: malformed.length,
        controlledReceipts: true, serviceExecution: false, fullQualification: false}));
} finally {
    assert.equal(dirname(directory), root); await rm(directory, {recursive: true, force: true});
}
}
