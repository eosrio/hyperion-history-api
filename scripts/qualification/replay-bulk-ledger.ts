/** Qualification-only, byte-preserving HTTP observation of actual worker bulk writes. */
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {once} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {digest} from './contract-fixture.ts';

export function bulkOperations(path: string, bytes: Buffer) {
    const index = decodeURIComponent(path.split('?')[0].split('/').filter(Boolean)[0]);
    const rows = bytes.toString().trimEnd().split('\n'); const operations: any[] = [];
    for (let offset = 0; offset < rows.length;) {
        const metadata = JSON.parse(rows[offset++]); const kinds = Object.keys(metadata); assert.equal(kinds.length, 1);
        const kind = kinds[0]; assert.ok(['index', 'create', 'update', 'delete'].includes(kind));
        const entry = metadata[kind]; assert.ok(entry._id !== undefined); const target = entry._index ?? index;
        assert.ok(target && target !== '_bulk'); operations.push({operation: kind, index: target, id: String(entry._id)});
        if (kind !== 'delete') { assert.ok(offset < rows.length, 'missing bulk source'); JSON.parse(rows[offset++]); }
    }
    assert.ok(operations.length); return operations;
}
export function summarizeBulkLedger(receipts: any[]) {
    assert.ok(receipts.length > 0, 'no actual worker bulk receipts observed');
    let successfulItems = 0; let failedItems = 0; let repeatedAttempts = 0; let afterObservedFailure = 0;
    const previous = new Map<string, {success: boolean; responseReceivedAt: number}>(); const acknowledgedCopies: Record<string, number> = {};
    for (const receipt of receipts) {
        assert.ok(Number.isInteger(receipt.status), 'unfinished bulk request');
        assert.ok(Number.isSafeInteger(receipt.responseReceivedAt) && receipt.responseReceivedAt >= receipt.startedAt);
        const httpSuccess = receipt.status >= 200 && receipt.status < 300;
        if (httpSuccess) assert.equal(receipt.response.items?.length, receipt.operations.length, 'bulk receipt coverage differs');
        let responseFailed = false;
        for (const [index, operation] of receipt.operations.entries()) {
            const item = httpSuccess ? receipt.response.items[index]?.[operation.operation] : undefined;
            if (httpSuccess) { assert.ok(item); assert.equal(String(item._id), operation.id); assert.equal(item._index, operation.index); }
            const success = httpSuccess && item.status >= 200 && item.status < 300 && !item.error;
            responseFailed ||= !success; const key = JSON.stringify([operation.index, operation.id, operation.operation]);
            if (previous.has(key)) repeatedAttempts++;
            const prior = previous.get(key);
            if (prior?.success === false && receipt.startedAt >= prior.responseReceivedAt) afterObservedFailure++;
            previous.set(key, {success, responseReceivedAt: receipt.responseReceivedAt});
            if (success) { successfulItems++; if (item._shards) {
                assert.equal(item._shards.failed, 0); const copies = String(item._shards.successful); acknowledgedCopies[copies] = (acknowledgedCopies[copies] ?? 0) + 1;
            } } else failedItems++;
        }
        if (httpSuccess) assert.equal(receipt.response.errors, responseFailed, 'bulk error summary differs from item outcomes');
    }
    return {requests: receipts.length, successfulItems, failedItems, repeatedAttempts,
        attemptsAfterObservedFailure: afterObservedFailure, acknowledgedCopies,
        limits: ['Repeated IDs alone do not establish retries; only attempts following an observed failure are correlated.']};
}
export async function startBulkLedger(url: string, directory: string, errors: string[], maximumRequests = 10000) {
    assert.ok(Number.isSafeInteger(maximumRequests) && maximumRequests >= 1 && maximumRequests <= 20000,
        'maximumRequests must be an integer between 1 and 20000');
    const target = new URL(url); assert.equal(target.protocol, 'http:'); assert.equal(target.hostname, '127.0.0.1'); assert.ok(target.port && target.port !== '9200');
    const receipts: any[] = []; let next = 0; let capturedBytes = 0; let active = 0;
    const upstreamRequests = new Set<ReturnType<typeof request>>();
    const server = createServer(async (incoming, outgoing) => {
        active++; const started = performance.now(); const chunks: Buffer[] = []; let size = 0;
        try {
            for await (const chunk of incoming) { size += chunk.length; assert.ok(size <= 16 * 1024 * 1024, 'HTTP request byte budget exceeded'); chunks.push(Buffer.from(chunk)); }
            const body = Buffer.concat(chunks); const bulk = incoming.url?.split('?')[0].endsWith('/_bulk');
            let receipt: any;
            if (bulk) {
                assert.ok(receipts.length < maximumRequests, 'bulk receipt budget exceeded'); capturedBytes += body.length; assert.ok(capturedBytes <= 256 * 1024 * 1024);
                const name = String(++next).padStart(5, '0'); receipt = {number: next, startedAt: Date.now(), path: incoming.url,
                    request: {file: `${name}-request.ndjson`, bytes: body.length, sha256: digest(body)}, operations: bulkOperations(incoming.url!, body)};
                receipts.push(receipt); await writeFile(join(directory, receipt.request.file), body, {flag: 'wx'});
            }
            await new Promise<void>((done, reject) => {
                const remote = request(new URL(incoming.url!, target), {method: incoming.method, headers: {...incoming.headers, host: target.host}}, response => {
                    const chunks: Buffer[] = []; let responseBytes = 0;
                    response.on('data', chunk => { responseBytes += chunk.length; if (responseBytes > 16 * 1024 * 1024) response.destroy(new Error('HTTP response byte budget exceeded')); else chunks.push(Buffer.from(chunk)); });
                    response.on('error', reject);
                    response.on('end', () => { void (async () => {
                        const bytes = Buffer.concat(chunks);
                        if (receipt) {
                            capturedBytes += bytes.length; assert.ok(capturedBytes <= 256 * 1024 * 1024);
                            receipt.status = response.statusCode; receipt.responseReceivedAt = Date.now(); receipt.elapsedMs = performance.now() - started; receipt.response = JSON.parse(bytes.toString());
                            receipt.responseBody = {file: `${String(receipt.number).padStart(5, '0')}-response.json`, bytes: bytes.length, sha256: digest(bytes)};
                            await writeFile(join(directory, receipt.responseBody.file), bytes, {flag: 'wx'});
                        }
                        outgoing.writeHead(response.statusCode!, response.headers); outgoing.end(bytes); done();
                    })().catch(reject); });
                });
                upstreamRequests.add(remote); remote.once('close', () => upstreamRequests.delete(remote));
                remote.on('error', reject); remote.setTimeout(20000, () => remote.destroy(new Error('bounded upstream timeout'))); remote.end(body);
            });
        } catch (error) { errors.push(String(error)); outgoing.destroy(error as Error); }
        finally { active--; }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return {url: `http://127.0.0.1:${(server.address() as any).port}`, receipts,
        limits: Object.freeze({maximumRequests, maximumCapturedBytes: 256 * 1024 * 1024}),
        assertIdle: () => assert.equal(active, 0, 'HTTP worker writes still active'),
        close: async () => {
            for (const remote of upstreamRequests) remote.destroy(new Error('qualification ledger closed'));
            server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
            const deadline = Date.now() + 2000;
            while (active > 0 && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
            assert.equal(active, 0, 'bulk ledger handlers did not close');
        }};
}
