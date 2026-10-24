/** Re-run the production-profile census on relocated, explicitly redacted evidence. No workers/services run. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {auditPortableWorkerProfiles} from './portable-state-worker-profiles.ts';
import {assertNativeQualificationRuntime} from './native-node-runtime.mjs';

assertNativeQualificationRuntime();
const [rootArgument, metadataFile, mode] = process.argv.slice(2);
assert.ok(rootArgument && metadataFile && ['original', 'published'].includes(mode));
const root = resolve(rootArgument), metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
assert.equal(metadata.sourceRevision, '3febe95e9faf52067f96350b9f9df0dd2e2a2678');
assert.equal(metadata.profiles.length, 14);
const receipts = [];
for (const component of ['api', 'master']) {
    const directory = join(root, 'observer', component), rows = [];
    for (const name of (await readdir(directory)).filter(value => /^worker-\d+\.jsonl$/.test(value))) {
        const content = await readFile(join(directory, name), 'utf8');
        assert.ok(Buffer.byteLength(content) <= 24 * 1024 * 1024);
        for (const line of content.trim().split('\n')) {
            const row = JSON.parse(line);
            // Metadata is relocated for the auditor, while archived observation bytes stay immutable.
            for (const field of ['profilePath', 'logfile']) if (row[field] !== undefined && row[field] !== null) {
                assert.ok(row[field].startsWith(metadata.logRoot + '/'), 'foreign observation path');
                row[field] = join(root, row[field].slice(metadata.logRoot.length + 1));
            }
            if (row.kind === 'profile_saved') {
                const profile = metadata.profiles.find(value => value.component === component && value.pid === row.pid);
                assert.ok(profile); assert.equal(row.bytes, profile.sourceBytes);
                // URL redaction changes JSON byte length, never nodes/samples/times. Keep that overlay explicit.
                if (mode === 'published') row.bytes = profile.publishedBytes;
            }
            rows.push(row);
        }
    }
    receipts.push(...await auditPortableWorkerProfiles(root, component, rows, metadata.primaryPids[component], true));
}
for (const receipt of receipts) {
    const expected = metadata.profiles.find(value => value.component === receipt.component && value.pid === receipt.pid);
    assert.ok(expected); assert.equal(receipt.role, expected.role); assert.equal(receipt.file, expected.file);
    assert.equal(receipt.sha256, mode === 'published' ? expected.publishedSha256 : expected.sourceSha256);
    assert.equal(receipt.samples, expected.samples); assert.equal(receipt.durationMicros, expected.durationMicros);
}
console.log(JSON.stringify({passed: true, mode, processes: receipts.length, existingProfileCensus: true,
    byteLengthOverlay: mode === 'published', serviceExecution: false, replayPassed: false}));
