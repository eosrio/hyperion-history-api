import {expect, test} from 'bun:test';
import {RecoverySourceFlow, recoverySourceLimits, serveRecoveryEngineeringSource} from '../../scripts/qualification/portable-state-recovery-source.ts';
import {recoveryExpectedRows, assertRecoveryHttp, assertRecoveryUnavailable, assertRecoveryProbe} from '../../scripts/qualification/portable-state-recovery-oracle.ts';
import {rollbackIntentReceipt} from '../../scripts/qualification/portable-state-recovery-observer.mjs';
import {assertRecoveryShutdown} from '../../scripts/qualification/portable-state-recovery.ts';

const request = (start: number, positions: any[] = [], window = 8) => ['get_blocks_request_v0', {
    start_block_num: start, end_block_num: 0xffffffff, max_messages_in_flight: window, have_positions: positions,
    irreversible_only: false, fetch_block: true, fetch_traces: true, fetch_deltas: true,
}];
const ack = (count: number) => ['get_blocks_ack_request_v0', {num_messages: count}];

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
