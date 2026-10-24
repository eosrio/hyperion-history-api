import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditWireAttemptRecovery, createWireRecoveryControl, readWireRecoveryControl, wireRecoveryShutdownRows,
    wireRecoveryPublicationOwners} from '../../scripts/qualification/portable-state-worker-recovery.mjs';
import {assertPortableNativePublications} from '../../scripts/qualification/portable-state-worker-native.ts';
import {parsePortableWorkerArguments, validatePortableWorkerOptions} from '../../scripts/qualification/portable-state-worker.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d', profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
test('worker recovery is explicit, source-bound and separate from CPU captures', () => {
    const files = ['state', 'plan', 'new-output'], authorityRpc = 'http://127.0.0.1:58271';
    expect(parsePortableWorkerArguments([...files, '--native', '--authority-rpc', authorityRpc, '--worker-recovery']).options)
        .toEqual({native: true, authorityRpc, workerRecovery: true});
    for (const options of [{workerRecovery: true}, {native: true, workerRecovery: true},
        {native: true, authorityRpc, workerRecovery: true, profile: true}, {workerRecovery: 1}])
        expect(() => validatePortableWorkerOptions(options)).toThrow();
    expect(() => parsePortableWorkerArguments([...files, '--worker-recovery'])).toThrow();
    expect(() => parsePortableWorkerArguments([...files, '--native', '--authority-rpc', authorityRpc, '--profile', '--worker-recovery'])).toThrow();
});

async function controlFixture(run: (value: any) => Promise<void>) {
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'hyperion-wire-recovery-')));
    const configFile = join(output, 'chain.json'), observerDirectory = join(output, 'observer/master'), chain = 'hyp-p191-abcdef012345';
    mkdirSync(observerDirectory, {recursive: true});
    const config = {settings: {chain, protocol: {profileId}}}; writeFileSync(configFile, JSON.stringify(config));
    const selected = createWireRecoveryControl({output, configFile, chain, source: {chainId, profileId, endBlock: 1480,
        records: Array.from({length: 33}, () => ({blockId: 'b'.repeat(64)}))}, frameSha256: 'a'.repeat(64)});
    try {await run({...selected, output, configFile, observerDirectory, chain, config});}
    finally {const owned = resolve(output); expect(dirname(owned)).toBe(realpathSync(tmpdir()));
        expect(basename(owned).startsWith('hyperion-wire-recovery-')).toBe(true); rmSync(owned, {recursive: true, force: true});}
}
test('fault control binds the exact owned config, observer, chain and native profile', async () => controlFixture(async value => {
    expect(readWireRecoveryControl(value.file, value)).toEqual(value.control);
    for (const patch of [{chain: 'other'}, {configFile: join(value.output, 'other.json')},
        {observerDirectory: value.output}]) expect(() => readWireRecoveryControl(value.file, {...value, ...patch})).toThrow();
    writeFileSync(value.configFile, JSON.stringify({...value.config, altered: true}));
    expect(() => readWireRecoveryControl(value.file, value)).toThrow();
}));
test('the owned native fault child actually exits before returning and the exclusive marker prevents a second exit', async () => controlFixture(async value => {
    const childFile = join(value.output, 'fault-child.mjs');
    const module = new URL('../../scripts/qualification/portable-state-worker-recovery.mjs', import.meta.url).href;
    const snapshot = {role: 'ds_pool_worker', source: {blockNum: 33, blockId: value.control.blockId, chainId},
        originalFrameSha256: value.control.frameSha256, redelivered: false, freshId: 'h45actionhandoff1:' + 'f'.repeat(64),
        payloadSha256: 'c'.repeat(64), attempt: {mode: 'managed', masterEnd: null, descriptor: {payloadSha256: 'c'.repeat(64)}}};
    writeFileSync(childFile, 'import {exitWireWorkerBeforeAck} from ' + JSON.stringify(module)
        + '; const result = exitWireWorkerBeforeAck(' + JSON.stringify(value.control) + ',' + JSON.stringify(snapshot)
        + '); console.log(JSON.stringify({returned: true, result}));');
    for (const expected of [86, 0]) {
        const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', childFile], {stdout: 'pipe', stderr: 'pipe', timeout: 5000});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stderr}).toEqual({code: expected, stderr: ''});
        expect(stdout).toBe(expected === 86 ? '' : '{"returned":true,"result":false}\n');
    }
    const marker = JSON.parse(readFileSync(join(value.output, 'attempt-recovery/fault.json'), 'utf8'));
    expect(marker.exitCode).toBe(86); expect(marker.controlSha256).toBe(hash(JSON.stringify(value.control)));
}));

function recoveryFixture() {
    const control = {runId: 'run', chain: 'hyp-p191-abcdef012345', chainId, blockId: 'b'.repeat(64), frameSha256: 'a'.repeat(64)};
    const descriptor = {kind: 'ds-delivery', receiptId: 'receipt-old', payloadSha256: 'c'.repeat(64), headersSha256: 'd'.repeat(64),
        consumerId: 'consumer-old', publisherId: 'publisher-old'};
    const binding = {admissionId: 'admission', planId: 'plan', blockNum: 33, blockId: control.blockId, traceOrdinal: 0};
    const freshWrites = [{kind: 'confirmed-handoff', id: 'h45actionhandoff1:' + 'f'.repeat(64),
        recordSha256: 'e'.repeat(64), workSha256: '1'.repeat(64), classification: 'confirmed-handoff'}];
    const end = {epoch: 'epoch', incarnation: 'old', attemptId: 'attempt-old', role: 'ds_pool_worker',
        status: 'process-exited-unresolved', rootResult: 'unknown', acknowledgementAttempted: null,
        descriptor, binding, freshWrites, freshWriteOverflow: false};
    const marker = {runId: control.runId, parentPid: 10, pid: 11, workerId: 'slot', role: 'ds_pool_worker',
        controlSha256: hash(JSON.stringify(control)), exitCode: 86, source: {blockNum: 33, blockId: control.blockId, chainId},
        originalFrameSha256: control.frameSha256, payloadSha256: descriptor.payloadSha256, freshId: freshWrites[0].id,
        admissionId: binding.admissionId, traceOrdinal: 0, attempt: {attemptId: end.attemptId, descriptor, binding, mode: 'managed', masterEnd: null}};
    const replacement = {...structuredClone(end), incarnation: 'new', attemptId: 'attempt-new', status: 'quiescent',
        rootResult: 'returned', acknowledgementAttempted: true, descriptor: {...descriptor,
            receiptId: 'receipt-new', consumerId: 'consumer-new', publisherId: 'publisher-new'}};
    const events = [{event: 'end', pid: 10, end}, {event: 'adjudicated', pid: 10, end, result: {state: 'unresolved'}},
        {event: 'ack-sent', pid: 12, parentPid: 10, workerId: 'slot', role: 'ds_pool_worker', redelivered: true, payloadSha256: marker.payloadSha256,
            admissionId: marker.admissionId, traceOrdinal: 0, attempt: {attemptId: replacement.attemptId,
                descriptor: structuredClone(replacement.descriptor), binding: structuredClone(replacement.binding), mode: 'managed', masterEnd: null}},
        {event: 'adjudicated', pid: 10, end: replacement, result: {state: 'associated', id: 'association'}}];
    const saved = {id: 'association', observation: {end: replacement, brokerSettlement: 'unknown',
        results: [{id: marker.freshId, classification: 'confirmed-handoff'}]}};
    const store = {readAttemptAssociation: async (id: string) => {
        if (id === saved.id) return saved;
        throw Object.assign(new Error('missing original association'), {name: 'ImmutableProtocolBundleReadError', code: 'missing', recordId: id});
    }};
    return {control, marker, events, masterPid: 10, store,
        queues: [{name: control.chain + ':ds_pool:1', redelivered: 1, ready: 0, unacked: 0, delivered: 2, ack: 1}]};
}
test('recovery oracle requires the original unresolved end, a different physical attempt and the actual retained association', async () => {
    expect((await auditWireAttemptRecovery(recoveryFixture())).outcome).toBe('real-worker-exit-and-redelivery');
    for (const mutate of [(value: any) => {value.events[1].result = {state: 'associated'};},
        (value: any) => {value.events[3].end.freshWrites = [];}, (value: any) => {value.events[2].redelivered = false;},
        (value: any) => {value.events[3].end.incarnation = 'old';},
        (value: any) => {value.events[3].end.descriptor.consumerId = 'consumer-old';},
        (value: any) => {value.events[3].end.binding.planId = 'other';},
        (value: any) => {value.queues[0].ack = 2;},
        (value: any) => {value.store.readAttemptAssociation = async () => ({observation: {}});},
        (value: any) => {value.store.readAttemptAssociation = async () => {throw new Error('storage unavailable');};}]) {
        const value = recoveryFixture(); mutate(value); await expect(auditWireAttemptRecovery(value)).rejects.toThrow();
    }
});
test('only a fresh completed recovery audit declares the two publication owners for its exact transaction', async () => {
    const value = recoveryFixture(), receipt = await auditWireAttemptRecovery(value);
    const context = {admissionId: value.marker.admissionId, planId: value.marker.attempt.binding.planId,
        traceOrdinal: value.marker.traceOrdinal, blockNum: 33, blockId: value.control.blockId};
    expect(wireRecoveryPublicationOwners(receipt, context)).toEqual([11, 12]);
    expect(wireRecoveryPublicationOwners(undefined, context)).toBeUndefined();
    expect(() => wireRecoveryPublicationOwners(structuredClone(receipt), context)).toThrow('unissued');
    for (const patch of [{admissionId: 'foreign'}, {planId: 'foreign'}, {traceOrdinal: 1}, {blockNum: 34}, {blockId: 'foreign'}])
        expect(wireRecoveryPublicationOwners(receipt, {...context, ...patch})).toBeUndefined();
    receipt.marker.pid = 999;
    expect(wireRecoveryPublicationOwners(receipt, context)).toEqual([11, 12]);
});
test('recovery issuance rejects marker and ACK scope that disagree with authenticated ends', async () => {
    for (const mutate of [
        (value: any) => {value.marker.traceOrdinal = 1; value.events[2].traceOrdinal = 1;},
        (value: any) => {value.marker.admissionId = 'foreign'; value.events[2].admissionId = 'foreign';},
        (value: any) => {value.marker.payloadSha256 = '9'.repeat(64); value.events[2].payloadSha256 = value.marker.payloadSha256;},
        (value: any) => {value.marker.source.blockId = '9'.repeat(64); value.control.blockId = value.marker.source.blockId;},
        (value: any) => {value.events[2].attempt.binding.traceOrdinal = 1;},
        (value: any) => {value.events[2].attempt.descriptor.payloadSha256 = '9'.repeat(64);},
        (value: any) => {value.marker.attempt.mode = 'controlled-local-only';},
        (value: any) => {value.events[2].role = 'projection';}
    ]) {
        const value = recoveryFixture(); mutate(value);
        await expect(auditWireAttemptRecovery(value)).rejects.toThrow();
    }
});
test('publication accounting keeps ordinary cardinality and checks both exact recovery copies completely', () => {
    const expected = {payloadSha256: 'a'.repeat(64), admissionId: 'admission', fragmentId: 'fragment', blockNum: 33};
    const original = {pid: 11, payloadSha256: expected.payloadSha256, canonicalPayloadSha256: expected.payloadSha256,
        persistent: true, mandatory: true,
        headers: {'hyperion-action-admission-v1': 'admission', action_fragment_id: 'fragment', block_num: 33}};
    const replacement = {...structuredClone(original), pid: 12}, pair = [original, replacement];
    expect(() => assertPortableNativePublications([original], expected)).not.toThrow();
    expect(() => assertPortableNativePublications(pair, expected)).toThrow();
    const recovery = {...expected, owners: [11, 12]};
    expect(() => assertPortableNativePublications(pair, recovery)).not.toThrow();
    for (const observed of [[original], [original, original], [...pair, replacement], [original, {...replacement, pid: 13}]])
        expect(() => assertPortableNativePublications(observed, recovery)).toThrow();
    for (const mutate of [(row: any) => {row.payloadSha256 = 'bad';}, (row: any) => {row.canonicalPayloadSha256 = 'bad';},
        (row: any) => {row.persistent = false;}, (row: any) => {row.mandatory = false;},
        (row: any) => {row.headers['hyperion-action-admission-v1'] = 'bad';},
        (row: any) => {row.headers.action_fragment_id = 'bad';}, (row: any) => {row.headers.block_num = 34;}]) {
        const changed = structuredClone(pair); mutate(changed[1]);
        expect(() => assertPortableNativePublications(changed, recovery)).toThrow();
    }
});
test('shutdown verification cannot hide a second process failure or mutate raw observed exits', () => {
    const marker = {pid: 11, parentPid: 10};
    const rows: any[] = [{kind: 'start', pid: 10}, {kind: 'start', pid: 11, parentPid: 10, role: 'ds_pool_worker'},
        {kind: 'start', pid: 12, parentPid: 10, role: 'ds_pool_worker'},
        {kind: 'worker_fork', pid: 10, childPid: 11}, {kind: 'worker_fork', pid: 10, childPid: 12},
        {kind: 'worker_exit', pid: 10, childPid: 11, code: 86, signal: null},
        {kind: 'worker_exit', pid: 10, childPid: 12, code: 0, signal: null},
        ...[10, 11, 12].map(pid => ({kind: 'exit', pid, code: pid === 11 ? 86 : pid === 10 ? 1 : 0, droppedRecords: 0, profileState: 'disabled'})),
        ...[10, 12].map(pid => ({kind: 'flush', pid, success: true, droppedRecords: 0})),
        {kind: 'shutdown', pid: 10, success: false, forced: [], unresolved: [], children: 2, exited: 2,
            failedChildren: [{pid: 11, code: 86, signal: null}], childExits: [{pid: 11, code: 86, signal: null}, {pid: 12, code: 0, signal: null}]}];
    const original = structuredClone(rows), verified = wireRecoveryShutdownRows(rows, marker, 10, 1, null);
    expect(rows).toEqual(original); expect(verified.find((row: any) => row.kind === 'exit' && row.pid === 11).code).toBe(0);
    rows.find(row => row.kind === 'exit' && row.pid === 12).code = 1;
    expect(() => wireRecoveryShutdownRows(rows, marker, 10, 1, null)).toThrow();
});
