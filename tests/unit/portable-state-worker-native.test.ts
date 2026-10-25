import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';
import {assertPortableNativeAction, assertPortableNativeUnavailable, nativePortableHolds, portableNativeProfile} from '../../scripts/qualification/portable-state-worker-native.ts';

const expected = {blockNum: 33, blockId: 'a'.repeat(64), transactionId: 'b'.repeat(64), actionOrdinal: 1,
    globalSequence: '9007199254740993', nativeKind: 'wire.sysio.onblock.v1', rawHex: 'aabb',
    expectedValue: {header: {threshold: '18446744073709551615'}}};
const input = {transactionId: expected.transactionId, actionOrdinal: 1, inputActionOrdinal: 1,
    account: 'sysio', receiver: 'sysio', name: 'onblock', rawHex: expected.rawHex,
    globalSequence: expected.globalSequence, receiptAbiSequence: '1'};
const action = () => ({block_num: 33, block_id: expected.blockId, trx_id: expected.transactionId,
    action_ordinal: 1, global_sequence: expected.globalSequence, act: {account: 'sysio', name: 'onblock', data: expected.expectedValue},
    receipts: [{receiver: 'sysio', global_sequence: expected.globalSequence, recv_sequence: '18446744073709551615', auth_sequence: [{account: 'sysio', sequence: '0'}]}],
    protocol: {schemaVersion: 2, kind: 'native', input, source: {blockNum: 33, blockId: expected.blockId},
        native: {nativeKind: expected.nativeKind, profile: {profileId: portableNativeProfile}}}});

test('native holds preserve the original Mongo barriers and bound notification ancestry', () => {
    const original = [1244, 1480], before = [...original];
    expect(nativePortableHolds(original)).toEqual([1, 33, 122, 256, 397, 1244, 1480]);
    expect(original).toEqual(before); expect(() => nativePortableHolds([100])).toThrow();
});
test('decoded unavailability requires explicit retryable proof errors without a partial success body', () => {
    const response = {status: 503, body: {statusCode: 503, code: 'ancestry_unavailable'}};
    expect(() => assertPortableNativeUnavailable(response, ['ancestry_unavailable'])).not.toThrow();
    expect(() => assertPortableNativeUnavailable({...response, body: {...response.body, code: 'unrelated'}}, ['ancestry_unavailable'])).toThrow();
    expect(() => assertPortableNativeUnavailable({...response, body: {...response.body, actions: []}}, ['ancestry_unavailable'])).toThrow();
});
test('persisted native assertions require original wrapper, source identity, lossless strings and exact encoding', async () => {
    const row = action(), encode = (_kind: string, value: unknown) => {
        expect(value).toEqual(expected.expectedValue); return Buffer.from(expected.rawHex, 'hex');
    };
    await expect(assertPortableNativeAction(row, expected, encode)).resolves.toBeUndefined();
    for (const mutate of [(value: any) => {value.act.data = value.act.data.header;},
        (value: any) => {value.protocol.schemaVersion = 1;}, (value: any) => {value.protocol.status = 'incomplete';},
        (value: any) => {value.global_sequence = Number(expected.globalSequence);},
        (value: any) => {value.protocol.input.inputActionOrdinal = 2;},
        (value: any) => {value.receipts[0].recv_sequence = 18446744073709551615;},
        (value: any) => {value.protocol.native.profile.profileId = 'wire-sysio-6508c9e8-engineering-v1';}]) {
        const changed = structuredClone(row); mutate(changed);
        await expect(assertPortableNativeAction(changed, expected, encode)).rejects.toThrow();
    }
    await expect(assertPortableNativeAction(row, expected, () => Buffer.from('aabb00', 'hex'))).rejects.toThrow();
});
test('ordinary installed native profile verifies original1480 source and all genuine notification origins without services', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--experimental-strip-types',
        fileURLToPath(new URL('./portable-state-worker-native-source.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 90000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, error: code ? stderr : undefined}).toEqual({code: 0, error: undefined});
    const report = JSON.parse(stdout); expect(report.status).toBe('passed'); expect(report.retainedFrames).toBe(1480);
    expect(report.notificationOccurrences).toBe(25); expect(report.notificationBlocks).toBe(17);
    expect(report.nativeOracleBlocks).toEqual([33, 122, 397]); expect(report.serviceExecution).toBe(false);
}, 95000);

test('original native hold captures missing/wrong/orphan and shard failures before its unchanged assertions', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--experimental-strip-types',
        fileURLToPath(new URL('./portable-native-history-capture.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 90000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, error: code ? stderr : undefined}).toEqual({code: 0, error: undefined});
    const report = JSON.parse(stdout); expect(report.status).toBe('characterized'); expect(report.retainedFrames).toBe(1480);
    expect(report.diagnosticRecords).toBe(8); expect(report.proofSuccessFabricated).toBe(false); expect(report.fullWorkerQualification).toBe(false);
    expect(report.results.filter(row => row.mode === 'delayed')).toHaveLength(2);
    expect(report.results.filter(row => row.reachedIndependentProofGuard).map(row => row.mode)).toEqual(['visible']);
}, 95000);
