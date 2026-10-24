import {expect, test} from 'bun:test';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {portableSourceHash as hash} from '../../scripts/qualification/portable-state-worker-source.ts';
import {PortableNativeStoredVersions} from '../../scripts/qualification/portable-state-native-bulk.ts';

test('bulk evidence requires every validated version and rejects an unvalidated replacement for the same ID', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-native-bulk-versions-'));
    const versions = new PortableNativeStoredVersions(33), receipts: any[] = [];
    const documents = [{block_num: 33, protocol: {selectionId: 'old-reader'}}, {block_num: 33, protocol: {selectionId: 'new-reader'}}];
    try {
        for (const [index, document] of documents.entries()) {
            const json = JSON.stringify(document), request = Buffer.from(JSON.stringify({index: {_index: 'owned-action', _id: 'same-action'}}) + '\n' + json + '\n');
            const response = {items: [{index: {_index: 'owned-action', _id: 'same-action', status: 200, _shards: {failed: 0, successful: 2}}}]};
            const responseBytes = Buffer.from(JSON.stringify(response));
            const name = String(index).padStart(5, '0');
            await writeFile(join(directory, name + '-request.ndjson'), request, {flag: 'wx'});
            await writeFile(join(directory, name + '-response.json'), responseBytes, {flag: 'wx'});
            receipts.push({number: index, status: 200, operations: [{index: 'owned-action'}], response,
                request: {file: name + '-request.ndjson', bytes: request.length, sha256: hash(request)},
                responseBody: {file: name + '-response.json', bytes: responseBytes.length, sha256: hash(responseBytes)}});
            versions.register({index: 'owned-action', id: 'same-action', blockNum: 33, logicalSha256: hash(json), physicalSha256: hash(json)});
        }
        await expect(versions.audit(directory, receipts.slice(1), JSON.stringify)).rejects.toThrow('lacks a captured successful');
        expect(await versions.audit(directory, receipts, JSON.stringify)).toHaveLength(2);
        const firstOnly = new PortableNativeStoredVersions(), json = JSON.stringify(documents[0]);
        firstOnly.register({index: 'owned-action', id: 'same-action', blockNum: 33, logicalSha256: hash(json), physicalSha256: hash(json)});
        const next = JSON.stringify(documents[1]);
        expect(() => firstOnly.register({index: 'owned-action', id: 'same-action', blockNum: 33,
            logicalSha256: hash(next), physicalSha256: hash(next)})).toThrow('version count');
        expect(() => versions.register({index: 'owned-action', id: 'same-action', blockNum: 34,
            logicalSha256: hash(next), physicalSha256: hash(next)})).toThrow('original block');
        expect(() => versions.register({index: 'owned-action', id: 'same-action', blockNum: 33,
            logicalSha256: 'a'.repeat(64), physicalSha256: 'b'.repeat(64)})).toThrow('version count');
        const ordinaryVersions = new PortableNativeStoredVersions(33);
        ordinaryVersions.register({index: 'owned-action', id: 'ordinary-action', blockNum: 34, logicalSha256: hash(json), physicalSha256: hash(json)});
        expect(() => ordinaryVersions.register({index: 'owned-action', id: 'ordinary-action', blockNum: 34,
            logicalSha256: hash(next), physicalSha256: hash(next)})).toThrow('version count');
        await expect(firstOnly.audit(directory, receipts, JSON.stringify)).rejects.toThrow('differ from every independently validated');
        const failed = structuredClone(receipts); failed[1].response.items[0].index.status = 500;
        const body = Buffer.from(JSON.stringify(failed[1].response));
        await writeFile(join(directory, failed[1].responseBody.file), body);
        failed[1].responseBody.bytes = body.length; failed[1].responseBody.sha256 = hash(body);
        await expect(versions.audit(directory, failed, JSON.stringify)).rejects.toThrow();
    } finally {
        const resolved = await realpath(directory);
        expect(dirname(resolved)).toBe(await realpath(tmpdir()));
        expect(basename(resolved).startsWith('hapi-native-bulk-versions-')).toBe(true);
        await rm(resolved, {recursive: true, force: true});
    }
});
