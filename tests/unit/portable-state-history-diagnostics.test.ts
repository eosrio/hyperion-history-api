import {expect, test} from 'bun:test';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';
import {createPortableHistoryDiagnostics, portableHistoryDiagnosticLimits} from '../../scripts/qualification/portable-state-history-diagnostics.ts';
import {digest} from '../../scripts/qualification/contract-fixture.ts';

async function fixture(work: (directory: string) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), 'hyperion-history-diagnostics-'));
    try {await work(directory);} finally {
        expect(dirname(resolve(directory))).toBe(resolve(tmpdir())); expect(basename(directory).startsWith('hyperion-history-diagnostics-')).toBe(true);
        await rm(directory, {recursive: true, force: true});
    }
}

test('history capture detaches the actual request and complete response before caller assertions or mutations', async () => fixture(async directory => {
    const errors: string[] = [], capture = createPortableHistoryDiagnostics(directory, errors);
    const request = {index: 'owned-action-*', size: 1024, track_total_hits: true, query: {term: {block_num: 397}}};
    const originalRequest = structuredClone(request), response = {timed_out: false, _shards: {total: 2, successful: 2, failed: 0},
        hits: {total: {value: 0, relation: 'eq'}, hits: []}};
    let calls = 0;
    const result = await capture.observe('action-search', {request, expected: {globalSequence: '637'}}, async () => {
        calls++; request.query.term.block_num = 398; return response;
    });
    expect(result).toBe(response); expect(calls).toBe(1);
    const entry = capture.evidence.records[0], bytes = await readFile(join(directory, entry.file));
    expect(entry.sha256).toBe(digest(bytes)); expect(entry.bytes).toBe(bytes.length);
    const retained = JSON.parse(bytes.toString());
    expect(retained.context.request).toEqual(originalRequest); expect(retained.response).toEqual(response);
    response.timed_out = true; expect(JSON.parse((await readFile(join(directory, entry.file))).toString()).response.timed_out).toBe(false);
    expect(retained.clock.pid).toBe(process.pid); expect(BigInt(retained.completed.monotonicNs)).toBeGreaterThanOrEqual(BigInt(retained.started.monotonicNs));
    expect(capture.evidence.failedCaptures).toBe(0); expect(errors).toEqual([]);
}));

test('a rejected original operation keeps its identity and server failure body in diagnostic evidence', async () => fixture(async directory => {
    const errors: string[] = [], capture = createPortableHistoryDiagnostics(directory, errors);
    const error = Object.assign(new Error('original shard failure'), {meta: {statusCode: 503, body: {error: {type: 'unavailable_shards_exception'}}}});
    await expect(capture.observe('action-refresh', {request: {index: 'owned-action-*'}}, async () => {throw error;})).rejects.toBe(error);
    const retained = JSON.parse((await readFile(join(directory, capture.evidence.records[0].file))).toString());
    expect(retained.outcome).toBe('rejected'); expect(retained.error.response).toEqual(error.meta.body); expect(retained.error.statusCode).toBe(503);
    expect(errors).toEqual([]);
}));

test('capture failures preserve original success and rejection while making missing evidence explicit', async () => fixture(async directory => {
    const errors: string[] = [], capture = createPortableHistoryDiagnostics(join(directory, 'absent'), errors), response = {accepted: true};
    let calls = 0;
    expect(await capture.observe('action-search', {}, async () => {calls++; return response;})).toBe(response);
    const error = new Error('original request failure');
    await expect(capture.observe('action-search', {}, async () => {calls++; throw error;})).rejects.toBe(error);
    expect(calls).toBe(2); expect(capture.evidence.failedCaptures).toBe(2); expect(capture.evidence.records).toEqual([]);
    expect(errors).toHaveLength(1); expect(errors[0]).toContain('capture incomplete');
    const cyclic: any = {}; cyclic.self = cyclic;
    expect(await capture.observe('action-search', cyclic, async () => response)).toBe(response);
    expect(capture.evidence.failedCaptures).toBe(3);
    const unprintable = {toString() {throw new Error('unprintable');}}, context = {toJSON() {throw unprintable;}};
    expect(await capture.observe('action-search', context, async () => response)).toBe(response);
    expect(capture.evidence.failedCaptures).toBe(4);
}));

test('the total byte bound applies across complete records without truncating or suppressing a later result', async () => fixture(async directory => {
    const records = join(directory, 'total'); await mkdir(records);
    const errors: string[] = [], capture = createPortableHistoryDiagnostics(records, errors);
    const large = 'x'.repeat(portableHistoryDiagnosticLimits.maximumRecordBytes - 4096);
    for (let index = 0; index < 4; index++) expect(await capture.observe('action-search', {index}, async () => large)).toBe(large);
    const final = 'y'.repeat(65536); expect(await capture.observe('action-search', {}, async () => final)).toBe(final);
    expect(capture.evidence.records).toHaveLength(4); expect(capture.evidence.capturedBytes).toBeLessThanOrEqual(portableHistoryDiagnosticLimits.maximumCapturedBytes);
    expect(capture.evidence.failedCaptures).toBe(1); expect(errors[0]).toContain('total byte budget exceeded');
    expect(await readdir(records)).toHaveLength(4);
}));

test('exclusive capture files cannot overwrite earlier evidence', async () => fixture(async directory => {
    const file = join(directory, '001-action-search.json'); await writeFile(file, 'preserved\n', {flag: 'wx'});
    const errors: string[] = [], capture = createPortableHistoryDiagnostics(directory, errors);
    expect(await capture.observe('action-search', {}, async () => 7)).toBe(7);
    expect(await readFile(file, 'utf8')).toBe('preserved\n'); expect(capture.evidence.failedCaptures).toBe(1); expect(errors).toHaveLength(1);
}));

test('record and byte bounds reject diagnostic overflow without skipping the observed work or truncating a result', async () => fixture(async directory => {
    const errors: string[] = [], capture = createPortableHistoryDiagnostics(directory, errors); let calls = 0;
    for (let index = 0; index < portableHistoryDiagnosticLimits.maximumRecords + 1; index++)
        expect(await capture.observe('action-search', {index}, async () => ++calls)).toBe(index + 1);
    expect(calls).toBe(129); expect(await readdir(directory)).toHaveLength(128); expect(capture.evidence.failedCaptures).toBe(1);
    const overflowErrors: string[] = [], overflow = createPortableHistoryDiagnostics(directory, overflowErrors), original = 'x'.repeat(portableHistoryDiagnosticLimits.maximumRecordBytes);
    expect(await overflow.observe('action-search', {}, async () => original)).toBe(original);
    expect(overflow.evidence.records).toHaveLength(0); expect(overflow.evidence.failedCaptures).toBe(1); expect(overflowErrors[0]).toContain('byte budget exceeded');
}));
