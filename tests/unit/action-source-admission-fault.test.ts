import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {actionSourceCrashSnapshot, assertActionSourceCrashStage, createActionSourceCrashControl,
    readActionSourceCrashControl, readActionSourceCrashEvidence, verifyActionSourceCrashRecovery,
    actionSourceCrashLimits} from '../../scripts/qualification/action-source-admission-fault.mjs';
import {assertSuccessfulWorkerShutdown} from '../../scripts/qualification/es955-workers.ts';
import {parseActionSourceAdmissionReplayArguments, runActionSourceAdmissionReplay} from '../../scripts/qualification/action-source-admission-replay.ts';
import {runContractReplay} from '../../scripts/qualification/contract-replay.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const copy = (value: any) => JSON.parse(JSON.stringify(value));
/** All records below are constructed verifier inputs; native qualification is performed separately. */
function evidence(stage = 'before-fragment') {
    const source = {chainId: '1'.repeat(64), blockNum: 4, blockId: '2'.repeat(64), producer: 'eosio', timestamp: '2026-01-01T00:00:00.000'};
    const target = {name: 'hyp-replay-test-action-v1-000001', uuid: 'uuid'};
    const control = {schemaVersion: 1, runId: '12345678-abcd-abcd-abcd-123456789012', stage, chain: 'hyp-replay-test', sourceChainId: source.chainId};
    const body = Buffer.from('{"actual":"constructed-guard-fixture"}');
    const marker = {schemaVersion: 1, ...{runId: control.runId, stage, exitCode: 86, chain: control.chain}, pid: 200, parentPid: 100,
        role: 'ds_pool_worker', workerId: '7', admissionId: 'admission', sourceId: 'source', planId: 'plan', traceOrdinal: 2,
        transactionId: '3'.repeat(64), traceSha256: '4'.repeat(64), payloadBase64: body.toString('base64'), payloadSha256: sha(body),
        payloadBytes: body.length, source, target, roots: ['101', '102'], captureSha256: '5'.repeat(64),
        originalFrameSha256: '6'.repeat(64), producer: {profile: 'fixture'}, executableSha256: '7'.repeat(64),
        fragmentId: stage === 'before-fragment' ? null : 'h45actionfragment1:' + '8'.repeat(64), at: 20,
        controlSha256: sha(JSON.stringify(control)), durability: {fileFsyncBeforeExit: true, directoryFsync: 'required-before-exit'}};
    const {payloadBase64, ...binding} = marker;
    const acks = [{...binding, kind: 'ack-intent', pid: 201, sequence: 1, deliveryTag: 1, redelivered: true},
        {...binding, kind: 'ack-sent', pid: 201, sequence: 2, deliveryTag: 1, redelivered: true}];
    const plan = {admissionId: marker.admissionId, sourceId: marker.sourceId, planId: marker.planId,
        blockNum: source.blockNum, blockId: source.blockId, target, captureSha256: marker.captureSha256,
        originalFrameSha256: marker.originalFrameSha256, producer: marker.producer, executableSha256: marker.executableSha256};
    const membership = {source: 'audited-retained-native-capture', plans: [plan]};
    const childExits = [{pid: 200, clusterId: 7, code: 86, signal: null}, {pid: 201, clusterId: 7, code: 0, signal: null}];
    const rows: any[] = [{kind: 'start', pid: 100, role: 'master', at: 1, chain: control.chain},
        {kind: 'start', pid: 200, parentPid: 100, role: 'ds_pool_worker', workerId: '7', at: 10, chain: control.chain},
        {kind: 'worker_fork', pid: 100, childPid: 200, childClusterId: 7},
        {kind: 'start', pid: 201, parentPid: 100, role: 'ds_pool_worker', workerId: '7', at: 21, chain: control.chain},
        {kind: 'worker_fork', pid: 100, childPid: 201, childClusterId: 7},
        {kind: 'worker_exit', pid: 100, childPid: 200, code: 86, signal: null},
        {kind: 'worker_exit', pid: 100, childPid: 201, code: 0, signal: null},
        {kind: 'exit', pid: 200, code: 86, droppedRecords: 0, profileState: 'disabled', flushed: false},
        {kind: 'exit', pid: 201, code: 0, droppedRecords: 0, profileState: 'disabled', flushed: true},
        {kind: 'exit', pid: 100, code: 1, droppedRecords: 0, profileState: 'disabled', flushed: true},
        ...[100, 201].map(pid => ({kind: 'flush', pid, success: true, error: null, droppedRecords: 0})),
        {kind: 'shutdown', pid: 100, success: false, children: 2, exited: 2, forced: [], unresolved: [],
            childExits, failedChildren: [childExits[0]]}];
    const finalActions = marker.roots.map(global_sequence => ({_source: {global_sequence, trx_id: marker.transactionId,
        block_num: source.blockNum, block_id: source.blockId}}));
    return {control, marker, acks, rows, masterPid: 100, masterExit: {code: 1, signal: null}, membership, finalActions};
}

for (const stage of ['before-fragment', 'after-fragment', 'before-ack']) test(`accepts only proven ${stage} recovery and preserves raw failure codes`, () => {
    const input = evidence(stage), before = copy(input);
    const result = verifyActionSourceCrashRecovery(input);
    expect(result.evidence.outcome).toBe('intentional-process-exit-and-recovery');
    expect(result.evidence.rawMasterExit).toEqual({code: 1, signal: null});
    expect(result.evidence.rawShutdown.failedChildren).toEqual([{pid: 200, clusterId: 7, code: 86, signal: null}]);
    expect(() => assertSuccessfulWorkerShutdown(input.rows, 100, 1, null)).toThrow();
    expect(() => assertSuccessfulWorkerShutdown(result.verificationRows, 100, 0, null)).not.toThrow();
    expect(input).toEqual(before);
});

const failures: [string, (input: any) => void][] = [
    ['wrong stage', x => x.marker.stage = 'before-ack'],
    ['wrong marker PID', x => x.marker.pid = 999],
    ['wrong marker code', x => x.marker.exitCode = 0],
    ['wrong parent', x => x.marker.parentPid = 99],
    ['wrong control', x => x.marker.controlSha256 = 'a'.repeat(64)],
    ['unsynced marker', x => x.marker.durability.fileFsyncBeforeExit = false],
    ['wrong body', x => x.marker.payloadBase64 = Buffer.from('other').toString('base64')],
    ['wrong source', x => x.marker.source.chainId = 'a'.repeat(64)],
    ['absent replacement', x => x.rows = x.rows.filter((r: any) => !(r.kind === 'start' && r.pid === 201))],
    ['absent fork', x => x.rows = x.rows.filter((r: any) => !(r.kind === 'worker_fork' && r.childPid === 201))],
    ['same PID ACK', x => x.acks.forEach((r: any) => r.pid = 200)],
    ['not broker redelivered', x => x.acks.forEach((r: any) => r.redelivered = false)],
    ['other body redelivered', x => x.acks.forEach((r: any) => r.payloadSha256 = 'a'.repeat(64))],
    ['other admission redelivered', x => x.acks.forEach((r: any) => r.admissionId = 'other')],
    ['missing ACK intent', x => x.acks = x.acks.filter((r: any) => r.kind !== 'ack-intent')],
    ['original attempted ACK', x => x.acks.push({...x.acks[0], pid: 200})],
    ['incomplete source manifests', x => x.membership.plans = []],
    ['wrong final outputs', x => x.finalActions.pop()],
    ['unexpected master zero', x => x.masterExit.code = 0],
    ['unexpected master signal', x => x.masterExit.signal = 'SIGTERM'],
    ['extra failed child', x => x.rows.find((r: any) => r.kind === 'shutdown').failedChildren.push({pid: 999, code: 1, signal: null})],
    ['other child exit error', x => x.rows.find((r: any) => r.kind === 'worker_exit' && r.childPid === 201).code = 1],
    ['other child signal', x => x.rows.find((r: any) => r.kind === 'worker_exit' && r.childPid === 201).signal = 'SIGKILL'],
    ['wrong fault child exit', x => x.rows.find((r: any) => r.kind === 'exit' && r.pid === 200).code = 1],
    ['observer error', x => x.rows.push({kind: 'observer_error', pid: 100})],
    ['untracked extra exit failure', x => x.rows.push({kind: 'exit', pid: 999, code: 1})],
    ['fault observer flush error', x => x.rows.push({kind: 'flush', pid: 200, success: false, error: 'failure', droppedRecords: 0})],
    ['failed flush', x => x.rows.find((r: any) => r.kind === 'flush').success = false],
    ['flush reported error', x => x.rows.find((r: any) => r.kind === 'flush').error = 'failure'],
    ['unflushed unrelated child', x => x.rows.find((r: any) => r.kind === 'exit' && r.pid === 201).flushed = false],
    ['dropped evidence', x => x.rows.find((r: any) => r.kind === 'exit' && r.pid === 201).droppedRecords = 1],
    ['forced child', x => x.rows.find((r: any) => r.kind === 'shutdown').forced.push({pid: 201})],
    ['missing exit', x => x.rows = x.rows.filter((r: any) => !(r.kind === 'exit' && r.pid === 201))]
];
for (const [label, mutate] of failures) test(`refuses normalization: ${label}`, () => {
    const input = copy(evidence()); mutate(input);
    expect(() => verifyActionSourceCrashRecovery(input)).toThrow();
});

test('guard options reject unscoped/invalid fault activation before any resource read', async () => {
    expect(parseActionSourceAdmissionReplayArguments(['state', 'out', 'fixture'])).toEqual({stateFile: 'state', output: 'out', retainedFixture: 'fixture', options: {}});
    expect(parseActionSourceAdmissionReplayArguments(['state', 'out', 'fixture', '--crash-at', 'after-fragment']).options).toEqual({crashAt: 'after-fragment'});
    for (const args of [[], ['state', 'out', 'fixture', '--crash-at', 'bogus'], ['state', 'out', '--crash-at']])
        expect(() => parseActionSourceAdmissionReplayArguments(args)).toThrow();
    expect(() => assertActionSourceCrashStage(null)).toThrow();
    await expect(runContractReplay('does-not-exist', 'does-not-exist', {actionSourceCrashAt: 'before-ack'})).rejects.toThrow('requires admission');
    await expect(runContractReplay('does-not-exist', 'does-not-exist', {actionSourceAdmission: true, actionSourceCrashAt: 'before-ack'})).rejects.toThrow('requires audited');
    await expect(runActionSourceAdmissionReplay('missing', 'missing', 'missing', {crashAt: 'unknown' as any})).rejects.toThrow('invalid');
});

test('snapshot binds actual scope, broker body and independent source inventory with copy bounds', () => {
    const body = Buffer.from('{"source":"fixture"}');
    const admission: any = {id: 'admission', sourceId: 'source', planId: 'plan', incomplete: null, target: {name: 'fixture', uuid: 'uuid'},
        inventory: {source: {blockNum: 4}, transactions: [{traceOrdinal: 2, transactionId: 'tx', traceSha256: 'a'.repeat(64),
            dispatch: {bodySha256: sha(body)}, groups: [{metadata: {global_sequence: '9007199254740993'}}]}]},
        source: {inventoryInput: {profileId: 'antelope-default-v1'}, frameHex: '0102', producer: {fixture: true},
            captureSha256: 'b'.repeat(64), executableSha256: 'c'.repeat(64)}};
    const worker = {chain: 'hyp-replay-test', activeActionAdmission: {admission, traceOrdinal: 2, payload: body, owner: {current: () => true}}};
    const message = {content: body, properties: {headers: {'hyperion-action-admission-v1': 'admission', action_trace_ordinal: 2}}, fields: {deliveryTag: 1, redelivered: false}};
    const snapshot = actionSourceCrashSnapshot(worker, message);
    expect(snapshot.payloadSha256).toBe(sha(body)); expect(snapshot.roots).toEqual(['9007199254740993']);
    admission.inventory.source.blockNum = 5; expect(snapshot.source.blockNum).toBe(4);
    expect(() => actionSourceCrashSnapshot(worker, {...message, content: Buffer.from('wrong')})).toThrow();
    expect(() => actionSourceCrashSnapshot(worker, {...message, content: Buffer.alloc(actionSourceCrashLimits.payloadBytes + 1)})).toThrow('bound');
    expect(() => actionSourceCrashSnapshot(worker, {...message, properties: {headers: {...message.properties.headers, action_trace_ordinal: 3}}})).toThrow();
});

test('actual guard child exits 86 only after fsynced one-shot marker; a fresh child cannot repeat it', async () => {
    const output = mkdtempSync(join(tmpdir(), 'action-crash-guard-'));
    try {
        mkdirSync(join(output, 'config')); mkdirSync(join(output, 'observer'));
        const configFile = join(output, 'config', 'chain.json'); writeFileSync(configFile, '{"fixture":"guard-only"}\n');
        const {file, control} = createActionSourceCrashControl({output, configFile, chain: 'hyp-replay-test', sourceChainId: '1'.repeat(64),
            fixtureSha256: '2'.repeat(64), stateSha256: '3'.repeat(64), stage: 'before-fragment'});
        expect(readActionSourceCrashControl(file, {observerDirectory: join(output, 'observer'), chain: control.chain, configFile})).toEqual(control);
        const launch = () => Bun.spawn([process.execPath, fileURLToPath(new URL('./action-source-admission-fault-child.mjs', import.meta.url)), file],
            {env: {...process.env, ES198_OBSERVER_DIR: join(output, 'observer'), CHAIN_NAME: control.chain, CONFIG_JSON: configFile}, stdout: 'pipe', stderr: 'pipe', timeout: 5000});
        const first = launch(), firstCode = await first.exited;
        expect({code: firstCode, stderr: await new Response(first.stderr).text()}).toEqual({code: 86, stderr: ''});
        const markerBytes = readFileSync(join(output, 'admission-fault', 'fault.json'));
        const marker = JSON.parse(markerBytes.toString());
        expect(marker.pid).toBe(first.pid); expect(marker.durability.fileFsyncBeforeExit).toBe(true);
        expect(marker.fixtureLevel).toBe('constructed-guard-only');
        const second = launch();
        expect({code: await second.exited, stderr: await new Response(second.stderr).text(), stdout: await new Response(second.stdout).text()})
            .toEqual({code: 0, stderr: '', stdout: '{"oneShotSkipped":true}\n'});
        expect(readFileSync(join(output, 'admission-fault', 'fault.json'))).toEqual(markerBytes);
        expect(() => readActionSourceCrashEvidence(control)).toThrow(); // A process exit alone cannot certify broker recovery.
        expect(() => readActionSourceCrashControl(file, {observerDirectory: join(output, 'observer'), chain: 'other', configFile})).toThrow();
        writeFileSync(configFile, '{"changed":true}');
        expect(() => readActionSourceCrashControl(file, {observerDirectory: join(output, 'observer'), chain: control.chain, configFile})).toThrow('configuration changed');
    } finally {rmSync(output, {recursive: true, force: true});}
}, 10000);
