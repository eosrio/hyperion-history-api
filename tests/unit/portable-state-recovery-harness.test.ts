import {expect, test} from 'bun:test';
import {mkdtemp, open, readFile, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecoverySourceFlow, recoverySourceLimits, serveRecoveryEngineeringSource} from '../../scripts/qualification/portable-state-recovery-source.ts';
import {recoveryExpectedRows, assertRecoveryHttp, assertRecoveryPhysical, assertRecoveryUnavailable, assertRecoveryProbe} from '../../scripts/qualification/portable-state-recovery-oracle.ts';
import {rollbackIntentReceipt} from '../../scripts/qualification/portable-state-recovery-observer.mjs';
import {assertRecoveryShutdown, assertRecoveryDiskReadiness, assertRecoveryCpuProfiles, recoveryCpuProfileEvidence, validateRecoveryRunOptions} from '../../scripts/qualification/portable-state-recovery.ts';

const request = (start: number, positions: any[] = [], window = 8) => ['get_blocks_request_v0', {
    start_block_num: start, end_block_num: 0xffffffff, max_messages_in_flight: window, have_positions: positions,
    irreversible_only: false, fetch_block: true, fetch_traces: true, fetch_deltas: true,
}];
const ack = (count: number) => ['get_blocks_ack_request_v0', {num_messages: count}];

test('prefix profiling is explicit, fixed at288 and keeps CPU controls out of ordinary qualification', () => {
    expect(validateRecoveryRunOptions()).toBeUndefined();
    expect(validateRecoveryRunOptions({profilePrefix: 288})).toBe(288);
    expect(validateRecoveryRunOptions({profilePrefix: 288, cpuProfile: false})).toBe(288);
    for (const options of [{profilePrefix: 256}, {profilePrefix: '288'}, {cpuProfile: false},
        {profilePrefix: 288, cpuProfile: 'off'}, {profilePrefix: 288, skipTo: 221}, null]) {
        expect(() => validateRecoveryRunOptions(options as any)).toThrow();
    }
});

for (const enabled of [true, false]) test('prefix ' + (enabled ? 'CPU' : 'control') + ' inventory requires every independently owned child observer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-prefix-pids-'));
    try {
        const parent: any = {pid: 42, exitCode: 0, signalCode: null};
        const bytes = Buffer.from(JSON.stringify({nodes: [{id: 1}], samples: [1], startTime: 10, endTime: 20, timeDeltas: [10]}));
        const receipt = async (pid: number) => {
            const file = join(directory, `worker-${pid}.cpuprofile`);
            const rows: any[] = [{kind: 'start', pid, parentPid: pid === 42 ? 1 : 42, role: pid === 44 ? 'projection' : pid === 42 ? 'master' : 'ingestor'},
                ...(enabled ? [{kind: 'profile_started', pid, at: 100, samplingIntervalMicros: 10000, maximumDurationMs: 900000},
                    {kind: 'profile_saved', pid, profilePath: file, bytes: bytes.length}] : []),
                {kind: 'flush', pid, at: 300, reason: 'qualifier_shutdown', success: true, error: null, droppedRecords: 0,
                    profileState: enabled ? 'saved' : 'disabled', profilePath: enabled ? file : null},
                {kind: 'exit', pid, code: 0, profileState: enabled ? 'saved' : 'disabled', flushed: true, droppedRecords: 0}];
            await writeFile(join(directory, `worker-${pid}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
            if (enabled) await writeFile(file, bytes);
            return rows;
        };
        const rows: any[] = [...await receipt(42), ...await receipt(44),
            ...[43, 44].flatMap(pid => [{kind: 'worker_fork', pid: 42, childPid: pid}, {kind: 'worker_exit', pid: 42, childPid: pid, code: 0, signal: null}]),
            {kind: 'shutdown', pid: 42, success: true, forced: [], unresolved: [], failedChildren: [],
                childExits: [43, 44].map(pid => ({pid, code: 0, signal: null}))}];
        expect(() => assertRecoveryShutdown(rows, parent, [])).not.toThrow();
        await expect(assertRecoveryCpuProfiles(rows, directory, 200, enabled, parent)).rejects.toThrow();
        const complete = [...rows, ...await receipt(43)];
        expect((await assertRecoveryCpuProfiles(complete, directory, 200, enabled, parent)).length).toBe(enabled ? 3 : 0);
        for (const mutate of [(copy: any[]) => {copy.push({...copy.find(row => row.kind === 'worker_fork')});},
            (copy: any[]) => {copy.find(row => row.kind === 'shutdown').childExits[1].pid = 43;},
            (copy: any[]) => {copy.find(row => row.kind === 'start' && row.pid === 43).parentPid = 99;},
            (copy: any[]) => {copy.push({...copy.find(row => row.kind === 'start' && row.pid === 43)});},
            (copy: any[]) => {copy.find(row => row.kind === 'worker_exit').code = 1;},
            (copy: any[]) => {copy.push({kind: 'worker_online', pid: 42, childPid: 99});}]) {
            const copy = structuredClone(complete); mutate(copy);
            await expect(assertRecoveryCpuProfiles(copy, directory, 200, enabled, parent)).rejects.toThrow();
        }
        const foreign = join(directory, 'worker-99.cpuprofile'); await writeFile(foreign, bytes);
        await expect(assertRecoveryCpuProfiles(complete, directory, 200, enabled, parent)).rejects.toThrow();
    } finally {await rm(directory, {recursive: true, force: true});}
});

test('stable HTTP evidence must carry the independently paired physical revision', () => {
    const binding: any = {projectionId: 'items'}, checkpoint = {blockNum: 288, blockId: 'a'.repeat(64)};
    const revision = 'b'.repeat(64), physical = {rows: [], metadata: {initialized: true, pending: null, gap: null, rollback: null,
        revision, checkpoint: {...checkpoint, revision}}};
    const body = {view: {binding, checkpoint, revision: 'c'.repeat(64)}, rows: [], count: {value: 0, exact: true}};
    const headers = new Headers({'hyperion-state-block-num': '288', 'hyperion-state-block-id': checkpoint.blockId,
        'hyperion-state-last-valid': 'false', 'hyperion-state-finality': 'reversible', 'cache-control': 'no-store'});
    expect(() => assertRecoveryPhysical(physical, checkpoint, [])).not.toThrow();
    expect(() => assertRecoveryHttp(body, headers, binding, checkpoint, [], 'reversible', physical.metadata.revision)).toThrow();
    body.view.revision = revision;
    expect(() => assertRecoveryHttp(body, headers, binding, checkpoint, [], 'reversible', physical.metadata.revision)).not.toThrow();
});

test('prefix CPU completion requires matching saved files, stable-stage coverage and complete native observer shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-prefix-profile-'));
    try {
        const file = join(directory, 'worker-42.cpuprofile'), bytes = Buffer.from(JSON.stringify({nodes: [{id: 1}], samples: [1],
            startTime: 10, endTime: 20, timeDeltas: [10]}));
        const parent: any = {pid: 42, exitCode: 0, signalCode: null};
        await writeFile(file, bytes);
        const rows: any[] = [{kind: 'start', pid: 42, role: 'projection'},
            {kind: 'profile_started', pid: 42, at: 100, samplingIntervalMicros: 10000, maximumDurationMs: 900000},
            {kind: 'profile_saved', pid: 42, profilePath: file, bytes: bytes.length},
            {kind: 'flush', pid: 42, at: 300, reason: 'qualifier_shutdown', success: true, error: null, droppedRecords: 0,
                profileState: 'saved', profilePath: file},
            {kind: 'exit', pid: 42, code: 0, profileState: 'saved', flushed: true, droppedRecords: 0},
            {kind: 'shutdown', pid: 42, success: true, forced: [], unresolved: [], failedChildren: [], childExits: []}];
        await writeFile(join(directory, 'worker-42.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
        expect((await assertRecoveryCpuProfiles(rows, directory, 200, true, parent))[0]).toMatchObject({pid: 42, samples: 1, bytes: bytes.length});
        for (const mutate of [(copy: any[]) => {copy[3].reason = 'profile_time_limit';},
            (copy: any[]) => {copy[3].at = 199;}, (copy: any[]) => {copy[3].droppedRecords = 1;},
            (copy: any[]) => {copy[4].flushed = false;}, (copy: any[]) => {copy[2].bytes++;},
            (copy: any[]) => {copy.splice(1, 1);}, (copy: any[]) => {copy.push({kind: 'observer_error', error: 'failed'});}]) {
            const copy = structuredClone(rows); mutate(copy);
            await expect(assertRecoveryCpuProfiles(copy, directory, 200, true, parent)).rejects.toThrow();
        }
        const control = [rows[0], {...rows[3], profileState: 'disabled', profilePath: null}, {...rows[4], profileState: 'disabled'}, rows[5]];
        await rm(file); expect(await assertRecoveryCpuProfiles(control, directory, 200, false, parent)).toEqual([]);
        await expect(assertRecoveryCpuProfiles(rows, directory, 200, false, parent)).rejects.toThrow();
        await expect(assertRecoveryCpuProfiles(rows, directory, 200, true, parent)).rejects.toThrow();
        const oversized = await open(file, 'wx'); await oversized.truncate(32 * 1024 * 1024 + 1); await oversized.close();
        await expect(assertRecoveryCpuProfiles(rows, directory, 200, true, parent)).rejects.toThrow();
    } finally {await rm(directory, {recursive: true, force: true});}
});

test('signed CPU sample deltas retain the captured profile and make interval weights unavailable', async () => {
    const origin = JSON.parse(await readFile(new URL('../fixtures/native-cpu-profile/origin.json', import.meta.url), 'utf8'));
    const encoded = await readFile(new URL('../fixtures/native-cpu-profile/negative-delta.json.gz.base64', import.meta.url));
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    expect(encoded.length).toBe(origin.base64.bytes); expect(sha(encoded)).toBe(origin.base64.sha256);
    const packed = Buffer.from(encoded.toString().trim(), 'base64');
    expect(packed.toString('base64')).toBe(encoded.toString().trim());
    expect(packed.length).toBe(origin.packed.bytes); expect(sha(packed)).toBe(origin.packed.sha256);
    const bytes = gunzipSync(packed, {maxOutputLength: 1024 * 1024});
    expect(bytes.length).toBe(origin.member.bytes); expect(sha(bytes)).toBe(origin.member.sha256);
    const directory = await mkdtemp(join(tmpdir(), 'hapi-prefix-signed-'));
    try {
        const file = join(directory, 'worker-42.cpuprofile'); await writeFile(file, bytes);
        const rows: any[] = [{kind: 'start', pid: 42, role: 'projection'},
            {kind: 'profile_started', pid: 42, at: 100, samplingIntervalMicros: 10000, maximumDurationMs: 900000},
            {kind: 'profile_saved', pid: 42, profilePath: file, bytes: bytes.length},
            {kind: 'flush', pid: 42, at: 300, reason: 'qualifier_shutdown', success: true, error: null, droppedRecords: 0,
                profileState: 'saved', profilePath: file},
            {kind: 'exit', pid: 42, code: 0, profileState: 'saved', flushed: true, droppedRecords: 0},
            {kind: 'shutdown', pid: 42, success: true, forced: [], unresolved: [], failedChildren: [], childExits: []}];
        await writeFile(join(directory, 'worker-42.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
        const profiles = await assertRecoveryCpuProfiles(rows, directory, 200, true, {pid: 42, exitCode: 0, signalCode: null} as any);
        expect(profiles).toHaveLength(1);
        expect(profiles[0]).toMatchObject({samples: 40572, sha256: origin.member.sha256,
            timing: {intervalWeightsAvailable: false, unavailableReasons: ['out-of-order-samples'], negativeDeltaCount: 1,
                minimumDeltaMicros: -4, negativeDeltaTotalMicros: -4, rawSignedDeltaSumMicros: 409102052,
                firstNegativeDeltas: [{index: 45, deltaMicros: -4}], normalized: false,
                sampledIntervalMicros: null, unweightedTailMicros: null}});
        expect(await readFile(file)).toEqual(bytes);
        expect(origin.originalRunStatus).toBe('failed');
    } finally {await rm(directory, {recursive: true, force: true});}
});

test('profile timing keeps recorded elapsed, sampled intervals and terminal gap distinct', () => {
    const profile = {nodes: [{id: 1}], samples: [1, 1, 1], startTime: 10, endTime: 25, timeDeltas: [0, 5, 5]};
    const before = JSON.stringify(profile);
    Object.freeze(profile.nodes); Object.freeze(profile.samples); Object.freeze(profile.timeDeltas); Object.freeze(profile);
    expect(recoveryCpuProfileEvidence(profile)).toMatchObject({samples: 3, startTime: 10, endTime: 25,
        timing: {elapsedMicros: 15, rawSignedDeltaSumMicros: 10, rawLastSampleToEndMicros: 5,
            negativeDeltaCount: 0, minimumDeltaMicros: 0, intervalWeightsAvailable: true,
            unavailableReasons: [], sampledIntervalMicros: 10, unweightedTailMicros: 5, normalized: false}});
    expect(JSON.stringify(profile)).toBe(before);
});

test('out-of-window or absent elapsed coverage remains explicitly unavailable', () => {
    const profile = {nodes: [{id: 1}], samples: [1], startTime: 10, endTime: 30, timeDeltas: [30]};
    expect(recoveryCpuProfileEvidence(profile).timing).toMatchObject({intervalWeightsAvailable: false,
        unavailableReasons: ['sample-outside-recording-extent'], outsideExtentSampleCount: 1,
        sampledIntervalMicros: null, unweightedTailMicros: null});
    expect(recoveryCpuProfileEvidence({...profile, timeDeltas: [0]}).timing).toMatchObject({intervalWeightsAvailable: false,
        unavailableReasons: ['no-positive-sampled-interval'], rawSignedDeltaSumMicros: 0, sampledIntervalMicros: null});
    expect(recoveryCpuProfileEvidence({...profile, samples: [1, 1], timeDeltas: [-4, 14]}).timing).toMatchObject({
        intervalWeightsAvailable: false, unavailableReasons: ['out-of-order-samples', 'sample-outside-recording-extent'],
        reconstructedOffsetRangeMicros: {min: -4, max: 10}, outsideExtentSampleCount: 1});
});

test('signed timing support still rejects malformed, inexact and over-budget profile input', () => {
    const profile = {nodes: [{id: 1}], samples: [1], startTime: 10, endTime: 30, timeDeltas: [10]};
    for (const patch of [{nodes: []}, {nodes: [{id: 1}, {id: 1}]}, {nodes: [{id: -1}]}, {samples: []}, {samples: [2]},
        {timeDeltas: []}, ...[null, '10', NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1].map(delta => ({timeDeltas: [delta]})),
        {startTime: -1}, {startTime: 1.5}, {endTime: 10}, {endTime: Infinity},
        {samples: Array(200001).fill(1)}, {nodes: Array(100001).fill({id: 1})},
        {samples: [1, 1], timeDeltas: [Number.MAX_SAFE_INTEGER, 1]}]) {
        expect(() => recoveryCpuProfileEvidence({...profile, ...patch})).toThrow();
    }
});

test('bounded timing examples do not truncate the raw sample or delta inventory', () => {
    const timeDeltas = Array.from({length: 40}, (_, index) => index % 2 ? 2 : -1);
    const profile = {nodes: [{id: 1}], samples: timeDeltas.map(() => 1), startTime: 10, endTime: 100, timeDeltas};
    const result = recoveryCpuProfileEvidence(profile);
    expect(result.samples).toBe(40); expect(result.timing.negativeDeltaCount).toBe(20);
    expect(result.timing.firstNegativeDeltas).toHaveLength(16);
    expect(result.timing.firstNegativeDeltas.at(-1)).toEqual({index: 30, deltaMicros: -1});
    expect(profile.timeDeltas).toEqual(timeDeltas);
    expect(result.timing.intervalWeightsAvailable).toBe(false);
});

test('recovery source honors exact requested replay ranges and credits on each connection', () => {
    const flow = new RecoverySourceFlow(() => true);
    expect(flow.receive(['get_status_request_v0', {}], 'A', 1247)).toEqual({status: true, blocks: []});
    expect(flow.receive(request(1244, [], 2), 'A', 1247).blocks).toEqual([1244, 1245]);
    expect(flow.available('A', 1247)).toEqual([]);
    expect(flow.receive(ack(1), 'A', 1247).blocks).toEqual([1246]);
    expect(flow.receive(ack(2), 'A', 1247).blocks).toEqual([1247]);
    expect(flow.receive(ack(1), 'A', 1247).blocks).toEqual([]);
    expect(flow.sent.map(value => value.blockNum)).toEqual([1244, 1245, 1246, 1247]);
    expect(flow.acknowledged).toEqual(flow.sent);
    const replacement = new RecoverySourceFlow(() => true);
    expect(replacement.receive(request(1248), 'B', 1248).blocks).toEqual([1248]);
    expect(replacement.sent).toEqual([{branch: 'B', blockNum: 1248}]); // Never manufacture skipped B1244..1247.
});

test('recovery source validates canonical known anchors, fetch flags and acknowledgement budgets', () => {
    const known = {block_num: 1243, block_id: 'a'.repeat(64)};
    const canonical = (position: any, branch: string) => branch === 'B' && JSON.stringify(position) === JSON.stringify(known);
    expect(new RecoverySourceFlow(canonical).receive(request(1244, [known]), 'B', 1243).blocks).toEqual([]);
    expect(() => new RecoverySourceFlow(canonical).receive(request(1244, [known]), 'A', 1243)).toThrow();
    expect(() => new RecoverySourceFlow(canonical).receive(request(1243, [known]), 'B', 1243)).toThrow();
    const hugeWindow = new RecoverySourceFlow(() => true);
    expect(hugeWindow.receive(request(1, [], 10000), 'A', 1247).blocks).toHaveLength(recoverySourceLimits.window);
    for (const mutate of [(body: any) => {body.fetch_traces = false;}, (body: any) => {body.irreversible_only = true;},
        (body: any) => {body.operator_ready = true;}, (body: any) => {body.start_block_num = 0;}]) {
        const input = request(1); mutate(input[1]);
        expect(() => new RecoverySourceFlow(() => true).receive(input, 'A', 1)).toThrow();
    }
    expect(() => hugeWindow.receive(ack(recoverySourceLimits.window + 1), 'A', 1247)).toThrow();
    expect(() => new RecoverySourceFlow(() => true).receive(ack(1), 'A', 1)).toThrow();
});

test('an unbranded engineering object cannot serve as a source', async () => {
    await expect(serveRecoveryEngineeringSource({} as any, [])).rejects.toThrow();
});

test('manual branch expectations reuse independent original rows, never source mutation output', () => {
    const plan: any = {definitions: [{id: 'counter', source: {table: 'attseq'}}, {id: 'items', source: {table: 'outenvelopes'}}],
        barriers: [{through: 1244, rows: {counter: [{key: '0', value: {next: '5'}}], items: [{key: '1'}, {key: '2'}]}},
            {through: 1480, rows: {counter: [{key: '0', value: {next: '9'}}], items: [{key: '3'}, {key: '4'}]}}]};
    expect(recoveryExpectedRows(plan, 'A', 1243)).toEqual({counter: [], items: []});
    expect(recoveryExpectedRows(plan, 'A', 1247)).toEqual(plan.barriers[1].rows);
    expect(recoveryExpectedRows(plan, 'B', 1246)).toEqual(plan.barriers[0].rows);
    expect(recoveryExpectedRows(plan, 'A', 1245)).toEqual({counter: plan.barriers[1].rows.counter, items: plan.barriers[0].rows.items});
    expect(recoveryExpectedRows(plan, 'B', 1245)).toEqual({counter: plan.barriers[0].rows.counter, items: plan.barriers[1].rows.items});
    const detached: any = recoveryExpectedRows(plan, 'B', 1246); detached.counter[0].value.next = 'changed';
    expect(plan.barriers[0].rows.counter[0].value.next).toBe('5');
    expect(() => recoveryExpectedRows(plan, 'A', 1248)).toThrow();
});

test('API oracle requires exact revision-bearing view, finality and unavailable metadata', () => {
    const binding: any = {projectionId: 'items'}, checkpoint = {blockNum: 1248, blockId: 'b'.repeat(64)}, rows: any[] = [];
    const result = {view: {binding, checkpoint, revision: 'c'.repeat(64)}, rows, count: {value: 0, exact: true}};
    const headers = new Headers({'hyperion-state-block-num': '1248', 'hyperion-state-block-id': checkpoint.blockId,
        'hyperion-state-last-valid': 'false', 'hyperion-state-finality': 'reversible', 'cache-control': 'no-store'});
    expect(() => assertRecoveryHttp(result, headers, binding, checkpoint, rows, 'reversible')).not.toThrow();
    expect(() => assertRecoveryHttp(result, headers, binding, checkpoint, rows, 'irreversible')).toThrow();
    expect(() => assertRecoveryHttp({...result, view: {...result.view, revision: undefined}}, headers, binding, checkpoint, rows, 'reversible')).toThrow();
    const unavailable = {status: 503, headers: new Headers({'retry-after': '1', 'cache-control': 'no-store'}), body: {retryable: true}};
    expect(() => assertRecoveryUnavailable(unavailable)).not.toThrow();
    unavailable.headers.set('hyperion-state-finality', 'irreversible'); expect(() => assertRecoveryUnavailable(unavailable)).toThrow();
});

test('crash observer accepts only the actual owned metadata rollback intent with majority+journal concern', () => {
    const id = 'a'.repeat(64), event: any = {databaseName: 'h45_p191_123456abcdef', commandName: 'findAndModify',
        command: {findAndModify: 'h45_projection_metadata', query: {_id: id}, writeConcern: {w: 'majority', j: true},
            update: {$set: {revision: 'b'.repeat(64), rollback: {status: 'running', operationId: 'fork', sourceRevision: 'c'.repeat(64),
                from: {blockNum: 1247, blockId: 'd'.repeat(64)}, ancestor: {blockNum: 1243, blockId: 'e'.repeat(64)}}}}}};
    expect(rollbackIntentReceipt(event, event.databaseName, id)).toMatchObject({operationId: 'fork', writeConcern: {w: 'majority', j: true}});
    expect(rollbackIntentReceipt(event, 'foreign', id)).toBeUndefined();
    expect(rollbackIntentReceipt(event, event.databaseName, 'f'.repeat(64))).toBeUndefined();
    event.command.writeConcern.j = false; expect(() => rollbackIntentReceipt(event, event.databaseName, id)).toThrow();
});

test('every successful probe rejects orphan or partial row images even under a canonical checkpoint label', () => {
    const plan: any = {definitions: [{id: 'counter', source: {table: 'attseq'}}, {id: 'items', source: {table: 'outenvelopes'}}],
        barriers: [{through: 1244, rows: {counter: [{key: '0', value: {next: '5'}}], items: []}},
            {through: 1480, rows: {counter: [{key: '0', value: {next: '9'}}], items: []}}]};
    const binding: any = {projectionId: 'counter'}, a = {blockNum: 1244, blockId: 'a'.repeat(64)}, b = {blockNum: 1244, blockId: 'b'.repeat(64)};
    const source: any = {records: [{...a, branch: 'A'}, {...b, branch: 'B'}]};
    const result = (checkpoint: any, rows: any[]) => ({view: {binding, checkpoint, revision: 'c'.repeat(64)}, rows, count: {value: rows.length, exact: true}});
    const headers = (checkpoint: any) => new Headers({'hyperion-state-block-num': String(checkpoint.blockNum), 'hyperion-state-block-id': checkpoint.blockId,
        'hyperion-state-last-valid': 'false', 'hyperion-state-finality': 'reversible', 'cache-control': 'no-store'});
    expect(() => assertRecoveryProbe(result(a, plan.barriers[0].rows.counter), headers(a), binding, 'reversible', source, plan, false)).not.toThrow();
    expect(() => assertRecoveryProbe(result(a, plan.barriers[0].rows.counter), headers(a), binding, 'reversible', source, plan, true)).toThrow();
    expect(() => assertRecoveryProbe(result(b, plan.barriers[1].rows.counter), headers(b), binding, 'reversible', source, plan, true)).not.toThrow();
    expect(() => assertRecoveryProbe(result(b, plan.barriers[0].rows.counter), headers(b), binding, 'reversible', source, plan, true)).toThrow();
    expect(() => assertRecoveryProbe(result(b, []), headers(b), binding, 'reversible', source, plan, true)).toThrow();
});

test('shutdown oracle permits only explicitly observed intentional kills and accounts for every fork', () => {
    const rows: any[] = [{kind: 'worker_fork'}, {kind: 'worker_fork'}, {kind: 'shutdown', pid: 10, forced: [], unresolved: [], success: false,
        failedChildren: [{pid: 11, code: null, signal: 'SIGKILL'}], childExits: [{pid: 11, code: null, signal: 'SIGKILL'}, {pid: 12, code: 0, signal: null}]}];
    const parent: any = {pid: 10, exitCode: 1, signalCode: null};
    expect(() => assertRecoveryShutdown(rows, parent, [11])).not.toThrow();
    expect(() => assertRecoveryShutdown(rows, parent, [])).toThrow();
    expect(() => assertRecoveryShutdown(rows, {...parent, exitCode: 0}, [11])).toThrow();
    expect(() => assertRecoveryShutdown([...rows, {kind: 'worker_fork'}], parent, [11])).toThrow();
});

test('disposable disk profiles require actual settings, active thresholds and available headroom after image pulls', () => {
    const core: any = {diskWatermarkProfile: '8-4-2gb', diskWatermarks: {low: '8gb', high: '4gb', floodStage: '2gb'},
        nodes: [{name: 'a', role: 'data'}, {name: 'b', role: 'data'}, {name: 'w', role: 'master'}]};
    const settings: any = {nodes: Object.fromEntries(core.nodes.map((node: any) => [node.name, {name: node.name, settings: {
        'cluster.routing.allocation.disk.watermark.low': '8gb', 'cluster.routing.allocation.disk.watermark.high': '4gb',
        'cluster.routing.allocation.disk.watermark.flood_stage': '2gb', 'indexing_pressure.memory.limit': '64mb'}}]))};
    const stats: any = {nodes: Object.fromEntries(core.nodes.map((node: any) => [node.name,
        {name: node.name, fs: {total: {available_in_bytes: 12 * 1024 ** 3, free_in_bytes: 50 * 1024 ** 3}}}]))};
    const cluster: any = {defaults: {'cluster.routing.allocation.disk.threshold_enabled': 'true'}, transient: {}, persistent: {}};
    expect(assertRecoveryDiskReadiness(core, settings, stats, cluster).minimumAvailableBytes).toBe(10 * 1024 ** 3);
    expect(() => assertRecoveryDiskReadiness({...core, diskWatermarkProfile: 'unsafe'}, settings, stats, cluster)).toThrow();
    expect(() => assertRecoveryDiskReadiness({...core, diskWatermarks: {...core.diskWatermarks, low: '1gb'}}, settings, stats, cluster)).toThrow();
    const dynamic = structuredClone(cluster); dynamic.persistent['cluster.routing.allocation.disk.watermark.low'] = '20gb';
    expect(() => assertRecoveryDiskReadiness(core, settings, stats, dynamic)).toThrow();
    const disabled = structuredClone(cluster); disabled.transient['cluster.routing.allocation.disk.threshold_enabled'] = 'false';
    expect(() => assertRecoveryDiskReadiness(core, settings, stats, disabled)).toThrow();
    const insufficient = structuredClone(stats); insufficient.nodes.a.fs.total.available_in_bytes = 9 * 1024 ** 3;
    expect(() => assertRecoveryDiskReadiness(core, settings, insufficient, cluster)).toThrow();
    const wrongPressure = structuredClone(settings); wrongPressure.nodes.a.settings['indexing_pressure.memory.limit'] = '1mb';
    expect(() => assertRecoveryDiskReadiness(core, wrongPressure, stats, cluster)).toThrow();
    const standard = structuredClone(core); standard.diskWatermarkProfile = '20-10-5gb'; standard.diskWatermarks = {low: '20gb', high: '10gb', floodStage: '5gb'};
    const standardSettings = structuredClone(settings), room = structuredClone(stats);
    for (const name of ['a', 'b', 'w']) {Object.assign(standardSettings.nodes[name].settings, {
        'cluster.routing.allocation.disk.watermark.low': '20gb', 'cluster.routing.allocation.disk.watermark.high': '10gb',
        'cluster.routing.allocation.disk.watermark.flood_stage': '5gb'}); room.nodes[name].fs.total.available_in_bytes = 24 * 1024 ** 3;}
    expect(assertRecoveryDiskReadiness(standard, standardSettings, room, cluster).minimumAvailableBytes).toBe(22 * 1024 ** 3);
});
