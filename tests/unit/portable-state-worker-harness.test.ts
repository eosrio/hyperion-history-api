import {describe, expect, it} from 'bun:test';
import {PortableSourceFlow, portableSourceLimits, servePortableWorkerSource, type PortableWorkerSource} from '../../scripts/qualification/portable-state-worker-source.ts';
import {independentWirePrimaryRow, portableWorkerAbiAvailability} from '../../scripts/qualification/portable-state-worker-oracle.ts';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {assertPortableApiResult, assertPortablePending, assertPortableUnavailable, assertPortablePredeployment, describePortableWorkerError, portableWorkerConfig,
    portableSourceRpc, portableWorkerEnvironment, portableWorkerFaultDefinition, validatePortableWorkerPlan} from '../../scripts/qualification/portable-state-worker.ts';
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
    it('bounds active SHIP sockets separately from closed status-probe history with the installed Wire provider', async () => {
        const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--experimental-strip-types',
            fileURLToPath(new URL('./portable-state-worker-connections.mjs', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 35000});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stderr: code ? stderr : undefined}).toEqual({code: 0, stderr: undefined});
        const report = JSON.parse(stdout.trim().split('\n').at(-1)!);
        expect(report).toMatchObject({passed: true, sequentialStatusProbes: portableSourceLimits.connections + 4,
            concurrentLimit: portableSourceLimits.connections, sessionHistoryLimit: portableSourceLimits.sessions,
            originalStatusOnly: true, streamedBlocks: 0, copiedMasterRestartRejected: true, copiedReaderRestartRejected: true,
            copiedBrokerRestartRejected: true, fullWorkerQualification: false});
    }, 40000);
    it('declines an exact discovery health probe without creating source authority or poisoning the replay', async () => {
        const errors: string[] = [], source = {endBlock: 1, records: [{blockId: 'a'.repeat(64)}], startupInfo: {chain_id: 'b'.repeat(64)}} as PortableWorkerSource;
        const rpc = await portableSourceRpc(source, errors);
        try {
            const response = await fetch(rpc.url + '/v2/health', {headers: {'user-agent': 'qualification-caller-regression'}});
            expect(response.status).toBe(404);
            expect(await response.json()).toEqual({error: 'source RPC fixture has no Hyperion health route'});
            expect(errors).toEqual([]);
            expect(rpc.requests).toHaveLength(1); expect(rpc.requests[0]).toMatchObject({method: 'GET', path: '/v2/health',
                allowed: false, kind: 'unsupported-health-probe', peer: {address: '127.0.0.1'}, userAgent: 'qualification-caller-regression'});
            expect(rpc.requests[0].peer.port).toBeGreaterThan(0);
            const info = await fetch(rpc.url + '/v1/chain/get_info');
            expect(info.status).toBe(200); expect(await info.json()).toEqual(source.startupInfo); expect(errors).toEqual([]);
        } finally {await rpc.close();}
    });
    it('keeps health lookalikes and every unsupported source RPC request fatal', async () => {
        const errors: string[] = [], source = {records: [{blockId: 'a'.repeat(64)}]} as PortableWorkerSource;
        const rpc = await portableSourceRpc(source, errors);
        try {
            for (const [method, path] of [['POST', '/v2/health'], ['GET', '/v2/health?probe=1'],
                ['GET', '/v1/chain/get_abi'], ['POST', '/v1/chain/get_block']]) {
                const response = await fetch(rpc.url + path, {method});
                expect(response.status).toBe(503); expect(await response.json()).toEqual({error: 'retained RPC input unavailable'});
            }
            expect(errors).toHaveLength(4); expect(errors.every(error => error.includes('RPC fallback is outside the retained startup view'))).toBe(true);
            expect(rpc.requests.every(request => request.allowed === false && !request.kind)).toBe(true);
        } finally {await rpc.close();}
    });
    it('archives only already observed source-checked RPC bytes without another upstream request', async () => {
        const blockId = 'a'.repeat(64), previous = 'b'.repeat(64), chainId = 'c'.repeat(64);
        const bytes = Buffer.from(JSON.stringify({block_num: 1, id: blockId, previous}, null, 2) + '\n');
        let blockRequests = 0;
        const upstream = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
            if (new URL(request.url).pathname === '/v1/chain/get_info') return Response.json({chain_id: chainId, last_irreversible_block_num: 1});
            expect(await request.json()).toEqual({block_num_or_id: 1}); blockRequests++; return new Response(bytes);
        }});
        const source = {chainId, endBlock: 1, records: [{blockId, headerPreviousBlockId: previous}],
            originalStatus: ['get_status_result_v0', {last_irreversible: {block_num: 1}}]} as PortableWorkerSource;
        const errors: string[] = [];
        const rpc = await portableSourceRpc(source, errors, {authorityRpc: upstream.url.origin, replayThrough: () => 1});
        try {
            await expect(rpc.checkedBlockResponse(1)).rejects.toThrow('no original source-checked RPC response');
            expect(blockRequests).toBe(0);
            const response = await fetch(rpc.url + '/v1/chain/get_block', {method: 'POST',
                headers: {'content-type': 'application/json'}, body: JSON.stringify({block_num_or_id: 1})});
            expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
            const archived = await rpc.checkedBlockResponse(1);
            expect(archived).toEqual({blockNum: 1, blockId, bytes}); archived.bytes.fill(0);
            expect((await rpc.checkedBlockResponse(1)).bytes).toEqual(bytes);
            await expect(rpc.checkedBlockResponse(2)).rejects.toThrow('no original source-checked RPC response');
            expect(blockRequests).toBe(1); expect(rpc.requests).toHaveLength(1); expect(errors).toEqual([]);
        } finally {await rpc.close(); await upstream.stop(true);}
    });
    it('cannot archive an upstream block that failed its original source identity check', async () => {
        let blockRequests = 0;
        const chainId = 'c'.repeat(64), upstream = Bun.serve({hostname: '127.0.0.1', port: 0, fetch(request) {
            if (new URL(request.url).pathname === '/v1/chain/get_info') return Response.json({chain_id: chainId, last_irreversible_block_num: 1});
            blockRequests++; return Response.json({block_num: 1, id: 'f'.repeat(64), previous: 'b'.repeat(64)});
        }});
        const source = {chainId, endBlock: 1, records: [{blockId: 'a'.repeat(64), headerPreviousBlockId: 'b'.repeat(64)}],
            originalStatus: ['get_status_result_v0', {last_irreversible: {block_num: 1}}]} as PortableWorkerSource;
        const errors: string[] = [];
        const rpc = await portableSourceRpc(source, errors, {authorityRpc: upstream.url.origin, replayThrough: () => 1});
        try {
            const response = await fetch(rpc.url + '/v1/chain/get_block', {method: 'POST',
                headers: {'content-type': 'application/json'}, body: JSON.stringify({block_num_or_id: 1})});
            expect(response.status).toBe(503);
            await expect(rpc.checkedBlockResponse(1)).rejects.toThrow('no original source-checked RPC response');
            expect(blockRequests).toBe(1); expect(errors).toHaveLength(1); expect(errors[0]).toContain('live RPC block differs from original SHIP source');
        } finally {await rpc.close(); await upstream.stop(true);}
    });
    it('derives the public state boundary from the original ABI deployment independently of durable progress', () => {
        const abiHex = 'aabb', abiSha256 = createHash('sha256').update(Buffer.from(abiHex, 'hex')).digest('hex');
        const blockId = '000000de' + 'a'.repeat(56), sourceAbi = {blockNum: 222, blockId, abiHex, abiSha256};
        const declared = {...definition, source: {...definition.source, abiSha256, abiDeployment: `${blockId}:items:${abiSha256}`}};
        expect(portableWorkerAbiAvailability({definitions: [declared]}, {sourceAbi})).toEqual({fromBlock: 222, blockId, abiSha256});
        expect(() => portableWorkerAbiAvailability({definitions: [declared]}, {sourceAbi: {...sourceAbi, blockNum: 1}})).toThrow();
        expect(() => portableWorkerAbiAvailability({definitions: [{...declared, source: {...declared.source, abiDeployment: 'worker-checkpoint-1'}}]}, {sourceAbi})).toThrow();
        const response = {status: 503, headers: new Headers({'retry-after': '1'}), body: {statusCode: 503, code: 'projection.incomplete', retryable: true}};
        expect(() => assertPortablePredeployment(response)).not.toThrow();
        expect(() => assertPortablePredeployment({...response, status: 200})).toThrow();
        expect(() => assertPortablePredeployment({...response, body: {...response.body, code: 'projection.query-unavailable'}})).toThrow();
        expect(() => assertPortablePredeployment({...response, headers: new Headers({'retry-after': '1', 'hyperion-state-block-num': '1'})})).toThrow();
        expect(() => assertPortablePredeployment({...response, body: {...response.body, rows: []}})).toThrow();
    });
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
    it('resumes from the next original block after the completed coordinator head with bounded ACK accounting', () => {
        const value = request(40, 1000); value[1].start_block_num = 34;
        const flow = new PortableSourceFlow(40, 34);
        expect(flow.releaseThrough(33)).toEqual([]);
        expect(flow.receive(value).blocks).toEqual([]);
        expect(flow.sent).toEqual([]); expect(flow.acknowledged).toEqual([]); expect(flow.outstanding).toBe(0);
        expect(() => flow.receive(ack(1))).toThrow();
        expect(flow.releaseThrough(34)).toEqual([34]);
        expect(flow.sent).toEqual([34]); expect(flow.outstanding).toBe(1);
        expect(flow.receive(ack(1)).blocks).toEqual([]);
        expect(flow.releaseThrough(40)).toEqual([35, 36, 37, 38, 39, 40]);
        expect(flow.outstanding).toBeLessThanOrEqual(portableSourceLimits.window);
        flow.receive(ack(6));
        expect(flow.acknowledged).toEqual([34, 35, 36, 37, 38, 39, 40]);
        expect(flow.outstanding).toBe(0);
        expect(() => new PortableSourceFlow(40).receive(value)).toThrow();
        for (const start of [33, 35]) {
            const wrong = request(40); wrong[1].start_block_num = start;
            expect(() => new PortableSourceFlow(40, 34).receive(wrong)).toThrow();
        }
        for (const first of [0, 41, 1.5, NaN]) expect(() => new PortableSourceFlow(40, first)).toThrow();
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
        expect(config.settings.protocol.profileId).toBe('wire-sysio-6508c9e8-engineering-v1');
        const native = portableWorkerConfig('hyp-p191-123456abcdef', 'h45_p191_123456abcdef', [definition], 43210,
            'http://127.0.0.1:43211', 'wire-sysio-6508c9e8-native-engineering-v1');
        expect(native.settings.protocol.profileId).toBe('wire-sysio-6508c9e8-native-engineering-v1');
        expect(native.settings).not.toHaveProperty('protocol_abi_coordination');
        expect(() => portableWorkerConfig('production', 'prod', [definition], 43210, 'http://127.0.0.1:1')).toThrow();
        const environment = portableWorkerEnvironment({NODE_OPTIONS: '--import unsafe', worker_role: 'foreign', ES198_FAULT: '1',
            HYPERION_PORTABLE_NATIVE_QUALIFICATION: 'foreign', PATH: 'kept'}, '/output', '/config', 'chain');
        expect(environment.NODE_OPTIONS).toBe(''); expect(environment.worker_role).toBeUndefined(); expect(environment.ES198_FAULT).toBeUndefined(); expect(environment.PATH).toBe('kept');
        expect(environment.HYPERION_PORTABLE_NATIVE_QUALIFICATION).toBeUndefined();
    });
    it('enables bounded CPU capture only from the explicit profile option', () => {
        const inherited = {ES198_CPU_PROFILE: '1', ES198_PROFILE_MAX_MS: '1', NODE_OPTIONS: '--import foreign'};
        const control = portableWorkerEnvironment(inherited, '/output', '/config', 'chain');
        expect(control.ES198_CPU_PROFILE).toBe('0'); expect(control.ES198_PROFILE_MAX_MS).toBeUndefined();
        const enabled = portableWorkerEnvironment(inherited, '/output', '/config', 'chain', true);
        expect(enabled.ES198_CPU_PROFILE).toBe('1'); expect(enabled.ES198_PROFILE_MAX_MS).toBe(String(portableSourceLimits.runMs));
        expect(enabled.NODE_OPTIONS).toBe('');
        expect(() => portableWorkerEnvironment(inherited, '/output', '/config', 'chain', 1 as any)).toThrow();
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
