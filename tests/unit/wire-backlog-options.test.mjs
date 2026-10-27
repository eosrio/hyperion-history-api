/** Actual qualification option/environment functions; no fixture or workers launched. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parsePortableWorkerArguments, validatePortableWorkerOptions, portableWorkerEnvironment}
    from '../../scripts/qualification/portable-state-worker.ts';
const base = ['state.json', 'plan.json', 'new-output'], origin = 'http://127.0.0.1:18888';
test('backlog capture is absent in all original CLI forms by default', () => {
    for (const args of [base, [...base, '--native'], [...base, '--native', '--authority-rpc', origin]])
        assert.equal(Object.hasOwn(parsePortableWorkerArguments(args).options, 'backlogCapture'), false);
});
test('explicit native RPC-bound backlog capture flag is admitted', () => {
    const value = parsePortableWorkerArguments([...base, '--native', '--authority-rpc', origin, '--backlog-capture']);
    assert.deepEqual(value.options, {native: true, authorityRpc: origin, backlogCapture: true});
    assert.equal(value.stateFile, base[0]); assert.equal(value.outputDirectory, base[2]);
});
test('flag refuses missing native/RPC, ambient order or additional profile/fault flags', () => {
    for (const args of [[...base, '--backlog-capture'], [...base, '--native', '--backlog-capture'],
        [...base, '--authority-rpc', origin, '--backlog-capture'],
        [...base, '--native', '--authority-rpc', origin, '--profile', '--backlog-capture'],
        [...base, '--native', '--authority-rpc', origin, '--backlog-capture', '--reader-recovery'],
        [...base, '--native', '--authority-rpc', origin, '--backlog-capture', '--stage-timing']])
        assert.throws(() => parsePortableWorkerArguments(args));
});
test('direct option admission rejects profile, stage and every recovery combination', () => {
    const selected = {native: true, authorityRpc: origin, backlogCapture: true};
    validatePortableWorkerOptions(selected);
    for (const name of ['profile', 'stageTiming', 'workerRecovery', 'masterRecovery', 'readerRecovery', 'brokerRecovery', 'storageRecovery'])
        assert.throws(() => validatePortableWorkerOptions({...selected, [name]: true}), undefined, name);
    for (const value of [{backlogCapture: true}, {native: true, backlogCapture: true}, {...selected, backlogCapture: '1'}])
        assert.throws(() => validatePortableWorkerOptions(value));
});
test('ambient backlog/head/worker/native variables are removed without mutating the caller environment', () => {
    const original = {PATH: 'retained', ES198_WIRE_BACKLOG_CAPTURE: '1', ES198_WIRE_BACKLOG_CAPTURE_HEAD: 'a'.repeat(40),
        ES198_CPU_PROFILE: '1', worker_role: 'ds_pool_worker', HYPERION_PORTABLE_NATIVE_STAGE_TIMING: '1', NODE_OPTIONS: '--trace-gc'};
    const expected = {...original}, selected = portableWorkerEnvironment(original, 'out', 'config', 'hyp-p191-0123456789ab');
    assert.deepEqual(original, expected); assert.equal(selected.PATH, 'retained');
    for (const name of ['ES198_WIRE_BACKLOG_CAPTURE', 'ES198_WIRE_BACKLOG_CAPTURE_HEAD', 'worker_role', 'HYPERION_PORTABLE_NATIVE_STAGE_TIMING'])
        assert.equal(Object.hasOwn(selected, name), false);
    assert.equal(selected.ES198_CPU_PROFILE, '0'); assert.equal(selected.NODE_OPTIONS, '');
});
