import {expect, test} from 'bun:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bulkOperations, startBulkLedger, summarizeBulkLedger} from '../../scripts/qualification/replay-bulk-ledger.ts';
import {digest} from '../../scripts/qualification/contract-fixture.ts';

test('bulk ledger preserves actual request/response bytes and records item outcomes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hyperion-bulk-ledger-')); let received: Buffer | undefined;
    const body = Buffer.from('{"index":{"_id":"1"}}\n{"memo":"actual worker body"}\n');
    const response = Buffer.from('{ "errors":false, "items":[{"index":{"_id":"1","_index":"hyp-replay-owned-action-v1","status":201,"_shards":{"total":2,"successful":2,"failed":0}}}] }\n');
    const upstream = createServer(async (request, reply) => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); received = Buffer.concat(chunks);
        reply.writeHead(200, {'content-type': 'application/json', 'x-proof': 'unchanged'}); reply.end(response);
    }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); const errors: string[] = [];
    const ledger = await startBulkLedger(`http://127.0.0.1:${(upstream.address() as any).port}`, directory, errors);
    try {
        const result = await fetch(ledger.url + '/hyp-replay-owned-action-v1/_bulk', {method: 'POST', body, headers: {'content-type': 'application/x-ndjson'}});
        expect(result.status).toBe(200); expect(result.headers.get('x-proof')).toBe('unchanged'); expect(Buffer.from(await result.arrayBuffer())).toEqual(response);
        expect(received).toEqual(body); expect(await readFile(join(directory, ledger.receipts[0].request.file))).toEqual(body);
        expect(await readFile(join(directory, ledger.receipts[0].responseBody.file))).toEqual(response); expect(ledger.receipts[0].request.sha256).toBe(digest(body));
        expect(summarizeBulkLedger(ledger.receipts)).toMatchObject({requests: 1, successfulItems: 1, failedItems: 0, repeatedAttempts: 0, attemptsAfterObservedFailure: 0});
        ledger.assertIdle(); expect(errors).toEqual([]);
    } finally { await ledger.close(); upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done())); await rm(directory, {recursive: true, force: true}); }
});
test('repeated successes remain separate from retries after an observed failure', () => {
    const operation = {operation: 'index', index: 'owned-action', id: '1'};
    let timestamp = 0;
    const receipt = (status: number) => ({status: 200, startedAt: ++timestamp, responseReceivedAt: timestamp, operations: [operation], response: {errors: status !== 201,
        items: [{index: {_index: operation.index, _id: operation.id, status, ...(status === 201 ? {} : {error: {type: 'rejected'}})}}]}});
    expect(summarizeBulkLedger([receipt(201), receipt(201)])).toMatchObject({repeatedAttempts: 1, attemptsAfterObservedFailure: 0, failedItems: 0});
    expect(summarizeBulkLedger([receipt(429), receipt(201)])).toMatchObject({repeatedAttempts: 1, attemptsAfterObservedFailure: 1, failedItems: 1});
    expect(summarizeBulkLedger([{...receipt(429), startedAt: 10, responseReceivedAt: 20}, {...receipt(201), startedAt: 15, responseReceivedAt: 30}]))
        .toMatchObject({repeatedAttempts: 1, attemptsAfterObservedFailure: 0});
    expect(() => summarizeBulkLedger([{...receipt(201), response: {errors: false, items: []}}])).toThrow('coverage');
    expect(() => bulkOperations('/owned-action/_bulk', Buffer.from('{"index":{"_id":"1"}}\n'))).toThrow('missing bulk source');
});
test('closing a failed run terminates an in-flight upstream request and its handler', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hyperion-bulk-close-')); let observed!: () => void;
    const seen = new Promise<void>(done => { observed = done; });
    const upstream = createServer(async request => { for await (const _chunk of request) {} observed(); });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); const errors: string[] = [];
    const ledger = await startBulkLedger(`http://127.0.0.1:${(upstream.address() as any).port}`, directory, errors);
    const response = fetch(ledger.url + '/owned-action/_bulk', {method: 'POST', body: '{"index":{"_id":"1"}}\n{}\n'}).then(() => 'completed', () => 'closed');
    try {
        await seen; expect(() => ledger.assertIdle()).toThrow('still active'); await ledger.close();
        expect(await response).toBe('closed'); ledger.assertIdle(); expect(errors.some(error => error.includes('ledger closed'))).toBe(true);
    } finally { upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done())); await rm(directory, {recursive: true, force: true}); }
});
