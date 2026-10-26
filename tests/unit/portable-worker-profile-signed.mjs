/** Offline original-validator regression; the reused engineering run remains failed. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {auditPortableWorkerProfiles, portableWorkerProfileLimits} from '../../scripts/qualification/portable-state-worker-profiles.ts';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const origin = JSON.parse(await readFile(new URL('../fixtures/native-cpu-profile/origin.json', import.meta.url), 'utf8'));
const encoded = await readFile(new URL('../fixtures/native-cpu-profile/negative-delta.json.gz.base64', import.meta.url));
assert.equal(origin.originalRunStatus, 'failed');
assert.equal(encoded.length, origin.base64.bytes); assert.equal(sha(encoded), origin.base64.sha256);
const packed = Buffer.from(encoded.toString('utf8').trim(), 'base64');
assert.equal(packed.toString('base64'), encoded.toString('utf8').trim());
assert.equal(packed.length, origin.packed.bytes); assert.equal(sha(packed), origin.packed.sha256);
const bytes = gunzipSync(packed, {maxOutputLength: 1024 * 1024});
assert.equal(bytes.length, origin.member.bytes); assert.equal(sha(bytes), origin.member.sha256);
assert.equal(sha(bytes), '01e4bc6d485fbc462ac2f3274cd389a6d3833e742aecbc6aa99c297b8e025ccd');
const profile = JSON.parse(bytes.toString('utf8'));
const negative = profile.timeDeltas.flatMap((value, index) => value < 0 ? [{index, value}] : []);
assert.deepEqual(negative, [{index: 45, value: -4}]);
assert.equal(profile.samples.length, 40572); assert.equal(profile.timeDeltas.length, profile.samples.length);
assert.equal(profile.timeDeltas.reduce((sum, value) => sum + value, 0), 409102052);
assert.equal(profile.endTime - profile.startTime, 409102260);

const temporary = await realpath(tmpdir());
const output = await realpath(await mkdtemp(join(temporary, 'hyperion-signed-profile-')));
let receipt;
try {
    const directory = join(output, 'observer/master'); await mkdir(directory, {recursive: true});
    const file = join(directory, 'worker-123.cpuprofile'); await writeFile(file, bytes, {flag: 'wx'});
    // Controlled process/flush metadata exercises artifact validation, not a fresh physical capture.
    const rows = [{kind: 'start', pid: 123, role: 'deserializer'}, {kind: 'profile_started', pid: 123,
        samplingIntervalMicros: portableWorkerProfileLimits.samplingIntervalMicros,
        maximumDurationMs: portableWorkerProfileLimits.maximumDurationMs},
    {kind: 'profile_saved', pid: 123, profilePath: file, bytes: bytes.length},
    {kind: 'flush', pid: 123, success: true, droppedRecords: 0, profileState: 'saved', profilePath: file}];
    const result = await auditPortableWorkerProfiles(output, 'master', rows, 123, true);
    assert.equal(result.length, 1); receipt = result[0];
    assert.equal(receipt.sha256, origin.member.sha256); assert.equal(receipt.samples, 40572);
    assert.equal(receipt.durationMicros, 409102260); assert.deepEqual(await readFile(file), bytes);
} finally {
    const owned = await realpath(output);
    assert.equal(dirname(owned), temporary); assert.ok(basename(owned).startsWith('hyperion-signed-profile-'));
    await rm(owned, {recursive: true});
}
console.log(JSON.stringify({passed: true, native: process.version, sha256: receipt.sha256, samples: receipt.samples,
    negativeDeltaCount: negative.length, minimumDeltaMicros: -4, signedDeltaSumMicros: 409102052,
    durationMicros: receipt.durationMicros, originalRunStatus: origin.originalRunStatus,
    rawBytesUnchanged: true, controlledProcessReceipts: true, fullWorkerQualification: false}));
