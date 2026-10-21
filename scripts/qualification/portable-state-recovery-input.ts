/** Materialize a bounded derivation receipt without starting a service or changing original inputs. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditPortableWorkerSource, boundedPortableFile, ordinaryPortablePath, portableSourceHash} from './portable-state-worker-source.ts';
import {validatePortableWorkerPlan} from './portable-state-worker.ts';
import {buildRecoveryEngineeringSource, recoveryFrame} from './portable-state-recovery-source.ts';

export async function auditRecoveryEngineeringInput(planFile: string) {
    const planBytes = await boundedPortableFile(resolve(planFile), 8 * 1024 * 1024), plan = validatePortableWorkerPlan(JSON.parse(planBytes.toString()));
    const original = await auditPortableWorkerSource(plan.source), oracles: any[] = [];
    for (const item of plan.oracleFiles) {const bytes = await boundedPortableFile(resolve(dirname(planFile), item.path), 16 * 1024 * 1024);
        assert.equal(bytes.length, item.bytes); assert.equal(portableSourceHash(bytes), item.sha256);
        const value = JSON.parse(bytes.toString()); if (value.sourceAbi && value.rows && value.conversions) oracles.push(value);}
    assert.equal(oracles.length, 1);
    const source = buildRecoveryEngineeringSource(original, plan, oracles[0]);
    const manifestBytes = await boundedPortableFile(fileURLToPath(new URL('../../tests/fixtures/portable-state-recovery/manifest.json', import.meta.url)), 65536);
    const manifest = JSON.parse(manifestBytes.toString());
    assert.equal(source.chainId, manifest.original.chainId); assert.equal(source.profileId, manifest.original.profileId);
    assert.equal(source.sourceRevision, manifest.original.upstreamRevision);
    assert.equal(source.records.length, manifest.derived.records); assert.equal(source.manifest.recordsSha256, manifest.derived.recordsSha256);
    let totalBytes = 0;
    for (const record of source.records) {const frame = recoveryFrame(source, record.branch === 'common' ? 'A' : record.branch, record.blockNum);
        assert.equal(frame.length, record.frameBytes); assert.equal(portableSourceHash(frame), record.frameSha256); totalBytes += frame.length;}
    assert.ok(totalBytes <= 128 * 1024 * 1024);
    return {schemaVersion: 1, kind: 'synthetic-engineering-input-audit', nodeAuthenticated: false, node: process.version,
        planSha256: portableSourceHash(planBytes), manifestSha256: portableSourceHash(manifestBytes), manifest: source.manifest,
        inputHashes: source.inputHashes, records: source.records, bytes: totalBytes,
        note: 'Input/derivation receipt only; no worker, database, fork recovery or Wire consensus acceptance.'};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert.equal(process.argv.length, 4, 'usage: node portable-state-recovery-input.ts ORIGINAL_PLAN NEW_RECEIPT_JSON');
    const receipt = await auditRecoveryEngineeringInput(process.argv[2]), output = resolve(process.argv[3]);
    await ordinaryPortablePath(dirname(output), true); await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
    console.log(JSON.stringify({receipt: output, records: receipt.records.length, bytes: receipt.bytes,
        recordsSha256: receipt.manifest.recordsSha256, nodeAuthenticated: false}));
}
