/** Reconcile every independently validated physical output version with real captured bulk receipts. */
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {boundedPortableFile, portableSourceHash} from './portable-state-worker-source.ts';

export interface StoredNativeVersion {
    readonly index: string; readonly id: string; readonly logicalSha256: string;
    readonly physicalSha256: string; readonly blockNum: number;
}
export class PortableNativeStoredVersions {
    private readonly versions = new Map<string, Map<string, StoredNativeVersion>>();
    private readonly replayedBlock: number | undefined;
    constructor(replayedBlock?: number) {
        assert.ok(replayedBlock === undefined || Number.isSafeInteger(replayedBlock) && replayedBlock >= 1 && replayedBlock <= 4096);
        this.replayedBlock = replayedBlock;
    }
    register(input: StoredNativeVersion): void {
        assert.ok(typeof input.index === 'string' && input.index && typeof input.id === 'string' && input.id);
        assert.match(input.logicalSha256, /^[a-f0-9]{64}$/); assert.match(input.physicalSha256, /^[a-f0-9]{64}$/);
        assert.ok(Number.isSafeInteger(input.blockNum) && input.blockNum > 0);
        const key = JSON.stringify([input.index, input.id]), prior = this.versions.get(key) ?? new Map();
        const version = Object.freeze({...input});
        assert.ok([...prior.values()].every(value => value.blockNum === input.blockNum), 'stored identity changed its original block');
        if (prior.has(input.physicalSha256)) assert.deepEqual(prior.get(input.physicalSha256), version);
        else assert.ok(prior.size < (input.blockNum === this.replayedBlock ? 2 : 1), 'stored output exceeds the selected version count');
        prior.set(input.physicalSha256, version); this.versions.set(key, prior);
    }
    async audit(directory: string, receipts: readonly any[], canonical: (value: unknown) => string): Promise<any[]> {
        const unmatched = new Set([...this.versions].flatMap(([key, versions]) => [...versions.keys()].map(hash => key + ':' + hash)));
        const confirmed: any[] = [];
        for (const entry of receipts) {
            assert.match(entry.request.file, /^[0-9]{5}-request\.ndjson$/);
            const bytes = await boundedPortableFile(join(directory, entry.request.file), 16 * 1024 * 1024);
            assert.equal(bytes.length, entry.request.bytes); assert.equal(portableSourceHash(bytes), entry.request.sha256);
            if (entry.status < 200 || entry.status >= 300) continue;
            assert.match(entry.responseBody.file, /^[0-9]{5}-response\.json$/);
            const responseBytes = await boundedPortableFile(join(directory, entry.responseBody.file), 16 * 1024 * 1024);
            assert.equal(responseBytes.length, entry.responseBody.bytes); assert.equal(portableSourceHash(responseBytes), entry.responseBody.sha256);
            assert.deepEqual(JSON.parse(responseBytes.toString()), entry.response);
            const lines = bytes.toString().trimEnd().split('\n'); let ordinal = 0;
            for (let offset = 0; offset < lines.length; ordinal++) {
                const metadata = JSON.parse(lines[offset++]), operation = Object.keys(metadata)[0], target = metadata[operation];
                const document = operation === 'delete' ? undefined : JSON.parse(lines[offset++]);
                const index = target._index ?? entry.operations[ordinal].index, key = JSON.stringify([index, String(target._id)]);
                const versions = this.versions.get(key); if (!versions || !['index', 'create'].includes(operation)) continue;
                const physicalSha256 = portableSourceHash(canonical(document)), expected = versions.get(physicalSha256);
                assert.ok(expected, 'actual worker bulk bytes differ from every independently validated physical version');
                const result = entry.response.items[ordinal][operation]; assert.equal(result._index, expected.index);
                assert.equal(String(result._id), expected.id); assert.ok(result.status >= 200 && result.status < 300 && !result.error);
                if (result._shards) {assert.equal(result._shards.failed, 0); assert.ok(result._shards.successful >= 1);}
                unmatched.delete(key + ':' + physicalSha256); confirmed.push({requestNumber: entry.number, operationOrdinal: ordinal,
                    expected, result, requestSha256: entry.request.sha256, responseSha256: entry.responseBody.sha256});
            }
        }
        assert.equal(unmatched.size, 0, 'a validated native/notification output version lacks a captured successful worker bulk receipt');
        return confirmed;
    }
}
