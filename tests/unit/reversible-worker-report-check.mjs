/** Construct contradictory report copies while preserving original native/store evidence. */
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {checkReversibleWorkerEvidence} from './reversible-worker-evidence-check.mjs';

const input = process.argv[2], original = await checkReversibleWorkerEvidence(input);
const envelope = JSON.parse(readFileSync(input)), report = envelope.data.report;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const originalParts = Object.fromEntries(['stores', 'processes', 'ends', 'inputs'].map(key => [key, hash(envelope.data[key])]));
const copies = [['report', 'end'], ...(report.revoked ? [
    ['report', 'revoked', 'recoveredOriginalDelivery', 'end'], ['report', 'revoked', 'redelivery', 'end'],
    ['report', 'revoked', 'oldEnd']] : []), ...(report.lateRpc ? [['report', 'lateRpc', 'originalEnd']] : [])];
const directory = mkdtempSync(join(tmpdir(), 'hyperion-evidence-report-'));
try {
    for (const [index, path] of copies.entries()) {
        const end = path.reduce((value, key) => value[key], envelope.data), before = end.descriptor.payloadSha256;
        assert.match(before, /^[0-9a-f]{64}$/);
        assert(!envelope.references.some(ref => JSON.stringify(ref.path) === JSON.stringify([...path, 'descriptor', 'payloadSha256'])));
        end.descriptor.payloadSha256 = before === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
        for (const [key, digest] of Object.entries(originalParts)) assert.equal(hash(envelope.data[key]), digest);
        const candidate = join(directory, index + '.json'); writeFileSync(candidate, JSON.stringify(envelope), {flag: 'wx'});
        await assert.rejects(checkReversibleWorkerEvidence(candidate), /Reported .*end differs/);
        end.descriptor.payloadSha256 = before;
    }
    assert.equal((await checkReversibleWorkerEvidence(input)).passed, true);
    console.log(JSON.stringify({passed: true, mode: envelope.data.mode, originalEvidencePassed: original.passed,
        alteredReportCopiesRejected: copies.map(path => path.join('.')), originalStoreAndNativePartsUnchanged: true,
        originalProcessesRerun: false, coldWrites: 0, capacityAuthority: false, releaseQualified: false}));
} finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(basename(directory), /^hyperion-evidence-report-/);
    rmSync(directory, {recursive: true, force: true});
}

