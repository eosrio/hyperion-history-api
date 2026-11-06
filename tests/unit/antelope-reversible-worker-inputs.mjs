/** Saved independent Antelope SHiP bytes and literal oracle; never imports Wire. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function prepareAntelopeReversibleWorkerInputs() {
    const raw = readFileSync(new URL('../fixtures/antelope-reversible-worker/source.json', import.meta.url));
    const fixture = JSON.parse(raw), schemaJson = readFileSync(new URL('../fixtures/antelope-worker/ship.abi.json', import.meta.url), 'utf8');
    assert.equal(hash(raw), '8b04e86f2eae02b4c8212f6f343adce0ad5c8c393d092f96ae21e639723fb2f8');
    assert.equal(fixture.generatorSha256, hash(readFileSync(new URL('../fixtures/antelope-reversible-worker/generate.mjs', import.meta.url))));
    assert.equal(fixture.originalFixtureSha256, hash(readFileSync(new URL('../fixtures/antelope-worker/source.json', import.meta.url))));
    assert.equal(hash(schemaJson), fixture.upstream.extractedAbiSha256);
    assert.deepEqual([fixture.firstBlock, fixture.selectedBlock, fixture.continuationBlock], [1, 2, 3]);
    const frames = fixture.frames.map(row => {
        const bytes = Buffer.from(row.hex, 'hex'); assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256);
        return {number: row.number, originalSha256: row.sha256, controlledFrameSha256: row.sha256, frameHex: row.hex,
            position: row.position, capturedReceipt: {sha256: row.sha256, blockId: row.position.blockId}};
    });
    assert.equal(hash(Buffer.from(fixture.status.hex, 'hex')), fixture.status.sha256);
    return {schemaJson, chainId: fixture.chainId, profileId: fixture.profileId, frames,
        positions: new Map(frames.map(row => [row.number, row.position])), expected: new Map(fixture.expected.map(row => [row.blockNum, row])),
        sourcePayloadUnchanged: true, sourceFixtureSha256: hash(raw), statusHex: fixture.status.hex};
}
