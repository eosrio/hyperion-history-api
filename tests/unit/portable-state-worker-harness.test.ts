import {describe, expect, it} from 'bun:test';
import {PortableSourceFlow, portableSourceLimits, servePortableWorkerSource} from '../../scripts/qualification/portable-state-worker-source.ts';
import {independentWirePrimaryRow} from '../../scripts/qualification/portable-state-worker-oracle.ts';
import {assertPortableApiResult, assertPortablePending, assertPortableUnavailable, describePortableWorkerError, portableWorkerConfig,
    portableWorkerEnvironment, portableWorkerFaultDefinition, validatePortableWorkerPlan} from '../../scripts/qualification/portable-state-worker.ts';
import {projectTableValue, validateProjectionDefinition} from '@eosrio/hyperion-sdk/projection';

const request = (last: number, window = 8) => ['get_blocks_request_v0', {start_block_num: 1, end_block_num: last + 1,
    max_messages_in_flight: window, have_positions: [], irreversible_only: true, fetch_block: true, fetch_traces: true, fetch_deltas: true}];
const ack = (count: number) => ['get_blocks_ack_request_v0', {num_messages: count}];
const definition = {schemaVersion: 1, id: 'rows', mappingRevision: 'a'.repeat(64), source: {contract: 'items', table: 'rows',
    abiDeployment: 'source-deployment', abiSha256: 'b'.repeat(64)}, fields: [{name: 'value', path: ['value'], type: 'string'}], initialization: {kind: 'genesis'}} as const;
const plan = () => ({schemaVersion: 1, source: {directory: 'source', receiptSha256: 'c'.repeat(64), endBlock: 4,
    status: {path: 'status.bin', bytes: 1, sha256: 'd'.repeat(64)}, getInfo: {path: 'get-info.json', bytes: 2, sha256: 'e'.repeat(64)}},
    definitions: [definition], oracleFiles: [{path: 'official-oracle.json', bytes: 2, sha256: 'f'.repeat(64)}],
    expectationOrigin: 'Independent original physical rows and official clio conversion receipts.',
    barriers: [{through: 2, rows: {rows: [{key: 'a', value: {value: 'before'}}, {key: 'b', value: {value: 'delete'}}]}},
        {through: 4, rows: {rows: [{key: 'a', value: {value: 'after'}}]}}]});

describe('portable actual-source harness guards', () => {
    it('adds only a distinct invalid mapping and preserves every healthy definition and oracle', () => {
        const input = validatePortableWorkerPlan(plan()), before = structuredClone(input), invalid = portableWorkerFaultDefinition(input);
        expect(input).toEqual(before); expect(invalid.id).not.toBe(input.definitions[0].id);
        expect(invalid.mappingRevision).not.toBe(input.definitions[0].mappingRevision); expect(invalid.source).toEqual(input.definitions[0].source);
        expect(validateProjectionDefinition(invalid).valid).toBe(true); const projected = projectTableValue(invalid, {value: 'real-original-value'});
        expect(projected.valid).toBe(false); if (!projected.valid) expect(projected.errors[0].message).toBe('Required source field is missing');
    });
    it('requires a durable exact pending predecessor and distinguishes write failures from contract failures', () => {
        const binding: any = Object.assign(Object.create(null), {projectionId: 'rows'}), previous = {blockNum: 1, blockId: '1'.repeat(64)}, block = {blockNum: 2, blockId: '2'.repeat(64)};
        const recovery: any = {binding: JSON.parse(JSON.stringify(binding)), checkpoint: previous, initialized: true, gap: null,
            pending: {block: {...block, previousBlockId: previous.blockId}, digest: 'f'.repeat(64),
                reason: 'Canonical projection source admitted; durable application is pending'}};
        expect(() => assertPortablePending(recovery, binding, previous, block, false)).not.toThrow();
        expect(() => assertPortablePending({...recovery, pending: {...recovery.pending, reason: null}}, binding, previous, block, false)).toThrow();
        expect(() => assertPortablePending({...recovery, pending: {...recovery.pending, reason: 'unrelated failure'}}, binding, previous, block, false)).toThrow();
        expect(() => assertPortablePending({...recovery, checkpoint: block}, binding, previous, block, false)).toThrow();
        expect(() => assertPortablePending({...recovery, pending: {...recovery.pending, block: {...block, previousBlockId: '0'.repeat(64)}}}, binding, previous, block, false)).toThrow();
        expect(() => assertPortablePending({...recovery, gap: recovery.pending}, binding, previous, block, false)).toThrow();
        expect(() => assertPortablePending(recovery, binding, previous, block, true)).toThrow();
        expect(() => assertPortablePending({...recovery, pending: {...recovery.pending, digest: null, reason: 'Required source field is missing'}}, binding, previous, block, true)).not.toThrow();
    });
    it('requires retryable unavailable responses without a stale success body or served-state headers', () => {
        const response = {status: 503, headers: new Headers({'retry-after': '1'}), body: {retryable: true}};
        expect(() => assertPortableUnavailable(response)).not.toThrow();
        expect(() => assertPortableUnavailable({...response, body: {...response.body, rows: []}})).toThrow();
        expect(() => assertPortableUnavailable({...response, headers: new Headers({'retry-after': '1', 'hyperion-state-last-valid': 'false'})})).toThrow();
        expect(() => assertPortableUnavailable({...response, status: 200})).toThrow();
    });
    it('preserves bounded nested causes and aggregate members without cycling', () => {
        const cause = new Error('actual primary-readiness condition'), outer = new Error('owned readiness deadline', {cause});
        const error = new AggregateError([outer], 'qualification failed'); error.cause = error;
        expect(describePortableWorkerError(error)).toContain('actual primary-readiness condition');
        expect(describePortableWorkerError(error)).toContain('owned readiness deadline');
        expect(describePortableWorkerError(new Error('x'.repeat(100000))).length).toBeLessThanOrEqual(16384);
    });
    it('holds every source message until explicitly released; status requests grant no credits', () => {
        const flow = new PortableSourceFlow(4);
        expect(flow.receive(['get_status_request_v0', {}])).toEqual({status: true, blocks: []});
        expect(flow.releaseThrough(2)).toEqual([]); expect(flow.receive(request(4))).toEqual({status: false, blocks: [1, 2]});
        expect(flow.receive(ack(2))).toEqual({status: false, blocks: []});
        expect(flow.releaseThrough(4)).toEqual([3, 4]); expect(flow.receive(ack(2))).toEqual({status: false, blocks: []});
        expect(flow.sent).toEqual([1, 2, 3, 4]); expect(flow.acknowledged).toEqual(flow.sent); expect(flow.outstanding).toBe(0);
    });
    it('caps source in-flight work independently of a larger requested credit window', () => {
        const flow = new PortableSourceFlow(100); flow.releaseThrough(100); flow.receive(request(100, 1000));
        expect(flow.sent).toHaveLength(portableSourceLimits.window); expect(flow.outstanding).toBe(portableSourceLimits.window);
        expect(flow.receive(ack(8)).blocks).toHaveLength(8); expect(flow.outstanding).toBe(portableSourceLimits.window);
    });
    it('refuses source skips, fake resume ancestry, missing fetch flags and unknown request fields', () => {
        for (const edit of [(body: any) => {body.start_block_num = 2;}, (body: any) => {body.have_positions = [{block_num: 1}];},
            (body: any) => {body.fetch_traces = false;}, (body: any) => {body.unqualified = true;}]) {
            const flow = new PortableSourceFlow(4), value = request(4); edit(value[1]); expect(() => flow.receive(value)).toThrow();
        }
        const flow = new PortableSourceFlow(4); expect(() => flow.receive(ack(1))).toThrow();
        flow.releaseThrough(1); flow.receive(request(4)); expect(() => flow.receive(ack(2))).toThrow();
        expect(() => flow.releaseThrough(0)).toThrow(); expect(() => flow.releaseThrough(5)).toThrow();
    });
    it('does not accept an unbranded source object as replay authority', async () => {
        await expect(servePortableWorkerSource({endBlock: 4} as any, [])).rejects.toThrow();
    });
    it('independently reads full uint64 contracts, table0 and every raw key byte', () => {
        const bytes = Buffer.alloc(19); bytes[0] = 0; bytes.writeBigUInt64LE(18446744073709551615n, 1);
        bytes.writeBigUInt64LE(1n, 9); bytes.writeUInt16LE(0, 17);
        const raw = Buffer.concat([bytes, Buffer.from([3, 0, 255, 1, 2, 42, 43])]);
        expect(independentWirePrimaryRow(raw.toString('hex'))).toEqual({contract: '18446744073709551615', tableId: 0,
            primaryKeyHex: '00ff01', valueHex: '2a2b'});
        expect(() => independentWirePrimaryRow(raw.subarray(0, -1).toString('hex'))).toThrow();
        expect(() => independentWirePrimaryRow(Buffer.concat([raw, Buffer.from([0])]).toString('hex'))).toThrow();
        expect(() => independentWirePrimaryRow(Buffer.concat([bytes, Buffer.from([0x80, 0, 0])]).toString('hex'))).toThrow();
    });
    it('requires independently specified insert, replacement and deletion across ordered complete prefixes', () => {
        expect(validatePortableWorkerPlan(plan()).barriers).toHaveLength(2);
        const unchanged = plan(); unchanged.barriers[1].rows.rows = structuredClone(unchanged.barriers[0].rows.rows);
        expect(() => validatePortableWorkerPlan(unchanged)).toThrow();
        const noOracle = plan(); noOracle.oracleFiles = []; expect(() => validatePortableWorkerPlan(noOracle)).toThrow();
        const skipped = plan(); skipped.barriers[1].through = 5; expect(() => validatePortableWorkerPlan(skipped)).toThrow();
        const duplicate = plan(); duplicate.barriers[0].rows.rows[1].key = 'a'; expect(() => validatePortableWorkerPlan(duplicate)).toThrow();
    });
    it('keeps native worker configuration on the portable path and strips inherited preload/fault/worker controls', () => {
        const config = portableWorkerConfig('hyp-p191-123456abcdef', 'h45_p191_123456abcdef', [definition], 43210, 'http://127.0.0.1:43211');
        expect(config.features.contract_state).toEqual({enabled: false, contracts: {}}); expect(config.indexer.start_on).toBe(1);
        expect(config.features.portable_state.projections).toEqual([definition]); expect(config.api.server_addr).toBe('127.0.0.1');
        expect(() => portableWorkerConfig('production', 'prod', [definition], 43210, 'http://127.0.0.1:1')).toThrow();
        const environment = portableWorkerEnvironment({NODE_OPTIONS: '--import unsafe', worker_role: 'foreign', ES198_FAULT: '1', PATH: 'kept'}, '/output', '/config', 'chain');
        expect(environment.NODE_OPTIONS).toBe(''); expect(environment.worker_role).toBeUndefined(); expect(environment.ES198_FAULT).toBeUndefined(); expect(environment.PATH).toBe('kept');
    });
    it('requires exact HTTP checkpoint, binding, rows/count and shared completeness headers', () => {
        // SDK validation uses null-prototype records; HTTP JSON and adapter snapshots use ordinary records.
        const binding = Object.assign(Object.create(null), {projectionId: 'rows'}), block = {blockNum: 4, blockId: '4'.repeat(64)}, rows = [{key: 'a', value: {value: 'after'}}];
        const result = JSON.parse(JSON.stringify({view: {binding, checkpoint: block}, rows, count: {value: 1, exact: true}}));
        const headers = new Headers({'hyperion-state-block-num': '4', 'hyperion-state-block-id': block.blockId,
            'hyperion-state-last-valid': 'false', 'cache-control': 'no-store'});
        expect(() => assertPortableApiResult(result, headers, binding, block, rows)).not.toThrow();
        expect(() => assertPortableApiResult({...result, view: {...result.view, checkpoint: {...block, blockNum: 3}}}, headers, binding, block, rows)).toThrow();
        const incomplete = new Headers(headers); incomplete.delete('hyperion-state-block-num'); expect(() => assertPortableApiResult(result, incomplete, binding, block, rows)).toThrow();
    });
});
