/** Captured write completion before visibility refresh; this issues no source, write or progress authority. */
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {bulkOperations} from './replay-bulk-ledger.ts';
import {boundedPortableFile, portableSourceHash} from './portable-state-worker-source.ts';
import type {PortableNativePhaseBudget} from './portable-state-worker-native.ts';

interface HistoryExpectation {readonly target: {readonly name: string; readonly uuid: string}; readonly id: string;}
export function portableNativeHistoryRemaining(budget?: PortableNativePhaseBudget): number {
    assert.ok(budget && Number.isFinite(budget.deadline), 'original native history phase budget is required');
    const remaining = Math.floor(budget.deadline - performance.now());
    assert.ok(remaining > 0, 'original native history phase deadline exceeded'); return remaining;
}
export async function observePortableNativeHistoryWrite<T extends HistoryExpectation>(options: {
    chain: string; bulk: {readonly directory: string; readonly receipts: readonly any[]};
    expectation: () => Promise<T | undefined>; validate: (document: any, expected: T) => Promise<void>;
    budget?: PortableNativePhaseBudget;
    wait: (name: string, work: () => Promise<void>, budget?: PortableNativePhaseBudget) => Promise<unknown>;
}) {
    const pending = new Error('exact original native history write is not completely captured');
    const inspect = async () => {
        portableNativeHistoryRemaining(options.budget);
        const expected = await options.expectation(); portableNativeHistoryRemaining(options.budget);
        if (!expected) return undefined;
        assert.ok(expected.target.name.startsWith(options.chain + '-action-'));
        assert.ok(typeof expected.target.uuid === 'string' && expected.target.uuid.length > 0);
        assert.match(expected.id, /^(?:0|[1-9][0-9]*)$/);
        for (const entry of options.bulk.receipts) {
            if (entry.captureComplete !== true || !entry.operations.some((operation: any) =>
                operation.index === expected.target.name && operation.id === expected.id)) continue;
            assert.ok(Number.isSafeInteger(entry.number) && entry.number > 0 && entry.number <= 20000);
            const prefix = String(entry.number).padStart(5, '0');
            assert.equal(entry.request.file, prefix + '-request.ndjson');
            assert.equal(entry.responseBody.file, prefix + '-response.json');
            const request = await boundedPortableFile(join(options.bulk.directory, entry.request.file), 16 * 1024 * 1024);
            portableNativeHistoryRemaining(options.budget);
            assert.equal(request.length, entry.request.bytes); assert.equal(portableSourceHash(request), entry.request.sha256);
            const operations = bulkOperations(entry.path, request); assert.deepEqual(operations, entry.operations);
            const responseBytes = await boundedPortableFile(join(options.bulk.directory, entry.responseBody.file), 16 * 1024 * 1024);
            portableNativeHistoryRemaining(options.budget);
            assert.equal(responseBytes.length, entry.responseBody.bytes); assert.equal(portableSourceHash(responseBytes), entry.responseBody.sha256);
            const response = JSON.parse(responseBytes.toString()); assert.deepEqual(response, entry.response);
            assert.ok(Number.isInteger(entry.status) && entry.status >= 200 && entry.status < 300, 'required native bulk HTTP request failed');
            assert.equal(response.items.length, operations.length, 'required native bulk response is incomplete');
            const lines = request.toString().trimEnd().split('\n'); let offset = 0;
            for (const [ordinal, operation] of operations.entries()) {
                JSON.parse(lines[offset++]); const document = operation.operation === 'delete' ? undefined : JSON.parse(lines[offset++]);
                if (operation.index !== expected.target.name || operation.id !== expected.id) continue;
                assert.ok(['index', 'create'].includes(operation.operation), 'required native history operation is not an original write');
                await options.validate(document, expected);
                portableNativeHistoryRemaining(options.budget);
                const result = response.items[ordinal][operation.operation];
                assert.equal(result._index, expected.target.name); assert.equal(String(result._id), expected.id);
                assert.ok(result.status >= 200 && result.status < 300 && !result.error, 'required native bulk item failed');
                assert.equal(result._shards.total, 2); assert.equal(result._shards.successful, 2); assert.equal(result._shards.failed, 0);
                return {observationOnly: true, expected, requestNumber: entry.number, operationOrdinal: ordinal,
                    phaseBudget: {clock: 'performance.now', deadline: options.budget!.deadline},
                    requestSha256: entry.request.sha256, responseSha256: entry.responseBody.sha256, result};
            }
        }
        return undefined;
    };
    let witness: Awaited<ReturnType<typeof inspect>>, failure: {error: unknown} | undefined;
    const check = async () => {witness = await inspect(); if (!witness) throw pending;};
    try {await check();} catch (error) {
        if (error !== pending) throw error;
        portableNativeHistoryRemaining(options.budget);
        // Only absence is retryable. An invalid captured witness must not be normalized by later observations.
        try {await options.wait('exact original native history write captured', async () => {
            try {await check();} catch (error) {if (error === pending) throw error; failure = {error};}
        }, options.budget);} catch (error) {if (failure) throw failure.error; throw error;}
        if (failure) throw failure.error;
    }
    portableNativeHistoryRemaining(options.budget);
    assert.ok(witness, 'required native history write was not observed'); return witness;
}
