import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

type ExpectedWrite = {index: string; id: string};
type Stage = 'coordinating' | 'primary' | 'replica';
type PressureDocument = {id: string; source: {global_sequence: number; block_num: number; payload: string}; sha256: string};
type PressureOptions = {
    client: any; index: string; owner: string; assertOwned: () => Promise<void>; snapshot: () => Promise<any>;
};
type Receipt = {
    requestId: string; ids: string[]; requestBytes: number; elapsedMs: number; statusCode: number;
    body: any; headers: any;
};
const currentFields = ['combined_coordinating_and_primary_in_bytes', 'coordinating_in_bytes',
    'primary_in_bytes', 'replica_in_bytes', 'all_in_bytes'] as const;
const stages: Stage[] = ['coordinating', 'primary', 'replica'];
const fixtureNodeCount = 3;
const pressureLimitBytes = 1024 * 1024;
const maxRequestBytes = 3 * 1024 * 1024;
const maxTotalRequestBytes = 8 * 1024 * 1024;
const documentCount = 640;
const retryChunkSize = 8;

function counter(value: any, description: string): number {
    assert.ok(Number.isSafeInteger(value) && value >= 0, `invalid or missing ${description}`);
    return value;
}

/** A 2xx item alone does not prove that both durable shard copies acknowledged it. */
export function assertDurableBulkAcknowledged(response: any, expected: ExpectedWrite[], expectedCopies = 2): void {
    assert.ok(Number.isSafeInteger(expectedCopies) && expectedCopies > 0, 'positive expected shard-copy count required');
    assert.ok(expected.length > 0, 'empty work cannot establish a durable acknowledgement');
    assert.equal(response.errors, false, 'bulk reported failed work');
    assert.ok(Array.isArray(response.items), 'bulk item receipts missing');
    assert.equal(response.items.length, expected.length, 'bulk item count differs from submitted work');
    assert.equal(new Set(expected.map(item => `${item.index}\0${item.id}`)).size, expected.length, 'duplicate expected IDs');
    for (let position = 0; position < expected.length; position++) {
        const item = response.items[position];
        assert.deepEqual(Object.keys(item), ['index'], 'expected an index-operation receipt');
        const result = item.index;
        assert.equal(result._index, expected[position].index, 'bulk index mismatch');
        assert.equal(result._id, expected[position].id, 'bulk ID or item order mismatch');
        assert.ok([200, 201].includes(result.status) && !result.error,
            `bulk item ${position} failed`);
        assert.ok(['created', 'updated'].includes(result.result), 'bulk item has no successful index result');
        assert.equal(result._shards?.total, expectedCopies, 'unexpected durable shard-copy total');
        assert.equal(result._shards?.successful, expectedCopies, 'not all expected shard copies acknowledged');
        assert.equal(result._shards?.failed, 0, 'a shard copy failed');
        if (result._shards.failures !== undefined) {
            assert.ok(Array.isArray(result._shards.failures), 'malformed shard failure details');
            assert.equal(result._shards.failures.length, 0, 'shard failure details present');
        }
        counter(result._seq_no, 'acknowledged sequence number');
        assert.ok(counter(result._primary_term, 'acknowledged primary term') > 0, 'primary term must be positive');
    }
}

/** Match Elasticsearch's native pressure rejection, rather than any HTTP 429 or write-pool rejection. */
export function assertNativePressureRejection(error: any, statusCode: number): Stage {
    assert.equal(statusCode, 429, 'pressure rejection must be HTTP/item 429');
    assert.equal(error?.type, 'es_rejected_execution_exception', 'not a native execution rejection');
    assert.equal(typeof error.reason, 'string', 'native pressure reason missing');
    const stage = /^rejected execution of (coordinating|primary|replica) operation \[/.exec(error.reason)?.[1] as Stage | undefined;
    assert.ok(stage, 'not an indexing-pressure operation rejection');
    assert.match(error.reason, new RegExp(`(?:${stage}_operation_bytes|operation_bytes)=[0-9]+`), 'pressure operation bytes absent');
    assert.match(error.reason, /max_(?:coordinating(?:_and_primary)?|primary|replica)_bytes=[0-9]+/,
        'pressure limit absent');
    return stage;
}

/** Incomplete node listings, counter resets, and generic write-pool counters cannot prove pressure. */
export function pressureCounters(snapshot: any) {
    assert.equal(snapshot?._nodes?.total, fixtureNodeCount, 'all three fixture nodes must be measured');
    assert.equal(snapshot._nodes.successful, fixtureNodeCount, 'fixture node statistics missing');
    assert.equal(snapshot._nodes.failed, 0, 'fixture node statistics failed');
    const entries = Object.entries(snapshot.nodes ?? {});
    assert.equal(entries.length, fixtureNodeCount, 'complete node statistics required');
    return Object.fromEntries(entries.map(([id, node]: [string, any]) => {
        const memory = node.indexing_pressure?.memory;
        assert.equal(memory?.limit_in_bytes, pressureLimitBytes, 'only the isolated one-MiB pressure fixture is allowed');
        const current = Object.fromEntries(currentFields.map(field => [field, counter(memory.current?.[field], `${id}.${field}`)]));
        const rejections = Object.fromEntries(stages.map(stage => [stage,
            counter(memory.total?.[`${stage}_rejections`], `${id}.${stage}_rejections`)]));
        const pools = Object.fromEntries(['write', 'write_coordination'].map(pool => [pool, {
            active: counter(node.thread_pool?.[pool]?.active, `${id}.${pool}.active`),
            queue: counter(node.thread_pool?.[pool]?.queue, `${id}.${pool}.queue`),
            rejected: counter(node.thread_pool?.[pool]?.rejected, `${id}.${pool}.rejected`)
        }]));
        return [id, {current, rejections, pools}];
    }));
}

export function assertPressureCounterDelta(before: any, after: any, observedStages: Stage[]): void {
    assert.ok(observedStages.length > 0, 'no native pressure rejection observed');
    const first = pressureCounters(before); const last = pressureCounters(after);
    assert.deepEqual(Object.keys(last).sort(), Object.keys(first).sort(), 'measurement node set changed');
    for (const id of Object.keys(first)) {
        for (const stage of stages) assert.ok(last[id].rejections[stage] >= first[id].rejections[stage], 'pressure counter reset');
    }
    for (const stage of new Set(observedStages)) {
        assert.ok(Object.keys(first).some(id => last[id].rejections[stage] > first[id].rejections[stage]),
            `no matching native ${stage} pressure-counter delta`);
    }
}

export function assertPressureRecovered(before: any, after: any): void {
    const first = pressureCounters(before); const last = pressureCounters(after);
    assert.deepEqual(Object.keys(last).sort(), Object.keys(first).sort(), 'measurement node set changed');
    for (const id of Object.keys(first)) {
        for (const field of currentFields) assert.ok(last[id].current[field] <= first[id].current[field], `pressure bytes retained: ${id}.${field}`);
        for (const pool of ['write', 'write_coordination']) {
            assert.ok(last[id].pools[pool].active <= first[id].pools[pool].active, `write work retained: ${id}.${pool}`);
            assert.ok(last[id].pools[pool].queue <= first[id].pools[pool].queue, `write queue retained: ${id}.${pool}`);
        }
        for (const stage of stages) assert.ok(last[id].rejections[stage] >= first[id].rejections[stage], 'pressure counter reset');
    }
}

function documents(): PressureDocument[] {
    return Array.from({length: documentCount}, (_, sequence) => {
        const source = {global_sequence: 2_000_000 + sequence, block_num: 2_000_000 + sequence,
            payload: `${sequence.toString().padStart(6, '0')}:` + 'p'.repeat(3065)};
        const encoded = JSON.stringify(source);
        assert.ok(Buffer.byteLength(encoded) <= 4096, 'source document exceeds the four-KiB bound');
        return {id: `pressure-${sequence.toString().padStart(6, '0')}`, source,
            sha256: createHash('sha256').update(encoded).digest('hex')};
    });
}

/** A bounded oversized request proves rejection/accounting, not a throughput or production saturation limit. */
export async function runPressureQualification(options: PressureOptions) {
    const {client, index, owner, assertOwned, snapshot} = options;
    const phaseDeadline = performance.now() + 120_000;
    assert.match(index, /^hyp-es955-[a-z0-9]{8,32}-[a-z0-9-]+$/, 'isolated qualification index required');
    assert.ok(owner.length >= 8 && owner.length <= 128 && !/[\r\n]/.test(owner), 'bounded opaque ownership token required');
    await assertOwned();
    const settingsResponse = await client.indices.getSettings({index, flat_settings: true, include_defaults: true});
    const settings = {...settingsResponse[index]?.defaults, ...settingsResponse[index]?.settings};
    assert.equal(settings['index.translog.durability'], 'request', 'pressure retry acknowledgements require request durability');
    assert.equal(String(settings['index.number_of_replicas']), '1', 'exactly one replica required');
    const expectedDocs = documents();
    const before = await snapshot();
    for (const node of Object.values(pressureCounters(before))) {
        for (const value of Object.values(node.current)) assert.equal(value, 0, 'pressure fixture must start quiescent');
        for (const pool of Object.values(node.pools)) { assert.equal(pool.active, 0); assert.equal(pool.queue, 0); }
    }
    let requestSequence = 0; let totalRequestBytes = 0;
    const receipts: Receipt[] = [];
    const acknowledged = new Set<string>();
    const observedStages: Stage[] = [];

    async function submit(batch: PressureDocument[]): Promise<PressureDocument[]> {
        assert.ok(performance.now() < phaseDeadline, 'pressure phase exceeded its bounded duration');
        await assertOwned();
        assert.ok(performance.now() < phaseDeadline, 'ownership check completed after the pressure deadline');
        const operations = batch.flatMap(doc => [{index: {_index: index, _id: doc.id}}, doc.source]);
        const requestBytes = operations.reduce((sum, operation) => sum + Buffer.byteLength(JSON.stringify(operation)) + 1, 0);
        totalRequestBytes += requestBytes;
        assert.ok(requestBytes <= maxRequestBytes && totalRequestBytes <= maxTotalRequestBytes, 'pressure request byte budget exceeded');
        assert.ok(++requestSequence <= 161, 'pressure request count budget exceeded');
        const requestId = `${owner}:pressure:${requestSequence}`;
        const started = performance.now();
        let body: any; let statusCode: number; let headers: any;
        try {
            const response = await client.bulk({operations, wait_for_active_shards: 'all', refresh: false, timeout: '5s'},
                {opaqueId: requestId, maxRetries: 0, requestTimeout: 15_000, meta: true});
            body = response.body; statusCode = response.statusCode; headers = response.headers;
        } catch (error: any) {
            if (error.meta?.statusCode !== 429 || !error.meta?.body?.error) throw error;
            body = error.meta.body; statusCode = error.meta.statusCode; headers = error.meta.headers;
        }
        receipts.push({requestId, ids: batch.map(doc => doc.id), requestBytes, elapsedMs: performance.now() - started,
            statusCode, body, headers});
        if (statusCode === 429) {
            observedStages.push(assertNativePressureRejection(body.error, statusCode));
            return batch;
        }
        assert.equal(statusCode, 200, 'unexpected bulk response status');
        assert.ok(Array.isArray(body.items), 'bulk item receipts missing');
        assert.equal(body.items.length, batch.length, 'bulk item count differs from submitted work');
        const rejected: PressureDocument[] = [];
        for (let position = 0; position < batch.length; position++) {
            const item = body.items[position];
            assert.deepEqual(Object.keys(item), ['index'], 'unexpected bulk operation receipt');
            const result = item.index; const doc = batch[position];
            assert.equal(result?._index, index, 'bulk item index mismatch');
            assert.equal(result?._id, doc.id, 'bulk item ID/order mismatch');
            if (result.status === 429) {
                observedStages.push(assertNativePressureRejection(result.error, result.status)); rejected.push(doc);
            } else {
                assertDurableBulkAcknowledged({errors: false, items: [item]}, [{index, id: doc.id}]);
                assert.ok(!acknowledged.has(doc.id), 'successful work submitted twice');
                acknowledged.add(doc.id);
            }
        }
        assert.equal(body.errors, rejected.length > 0, 'bulk errors flag contradicts item receipts');
        return rejected;
    }

    const retryDocs = await submit(expectedDocs);
    assert.ok(retryDocs.length > 0, 'bounded oversized request did not exercise native indexing pressure');
    const afterPressure = await snapshot();
    assertPressureCounterDelta(before, afterPressure, observedStages);
    for (let offset = 0; offset < retryDocs.length; offset += retryChunkSize) {
        let pending = retryDocs.slice(offset, offset + retryChunkSize);
        for (let attempt = 0; pending.length && attempt < 2; attempt++) {
            if (attempt) await new Promise(resolve => setTimeout(resolve, 250));
            pending = await submit(pending);
        }
        assert.equal(pending.length, 0, 'bounded retries exhausted with unacknowledged documents');
    }
    assert.equal(acknowledged.size, expectedDocs.length, 'not every known ID has an exact successful receipt');
    const deadline = performance.now() + 15_000;
    const recoverySamples: {elapsedMs: number; snapshot: any; recovered: boolean}[] = [];
    const recoveryStarted = performance.now();
    let consecutive = 0;
    while (performance.now() < deadline && consecutive < 3) {
        const measured = await snapshot();
        assert.ok(performance.now() <= deadline, 'recovery sample completed after the deadline');
        let recovered = true;
        // Validate the measurement outside the recoverable assertion: missing nodes/counters are never a pending recovery.
        pressureCounters(measured);
        assertPressureCounterDelta(before, measured, observedStages);
        try { assertPressureRecovered(before, measured); } catch { recovered = false; }
        recoverySamples.push({elapsedMs: performance.now() - recoveryStarted, snapshot: measured, recovered});
        consecutive = recovered ? consecutive + 1 : 0;
        if (consecutive < 3) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(consecutive, 3, 'pressure accounting did not recover within the bounded deadline');
    assertPressureCounterDelta(before, recoverySamples.at(-1)!.snapshot, observedStages);
    return {expectedDocs, acknowledgedIds: [...acknowledged], rejectedIds: retryDocs.map(doc => doc.id),
        before, afterPressure, recoverySamples, receipts, observedStages,
        bounds: {documentCount, maxSourceBytes: 4096, maxRequestBytes, maxTotalRequestBytes, maxRequests: 161,
            retryChunkSize, retriesPerChunk: 2, concurrency: 1, pressureLimitBytes, requestTimeoutMs: 15_000,
            phaseTimeoutMs: 120_000, recoveryTimeoutMs: 15_000}, totalRequestBytes};
}
