/** Strict successor to the local ship-record/mock-ship prototype. No reset or purge API. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir, lstat} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {gzipSync, gunzipSync, inflateSync} from 'node:zlib';
import {ABI, ABIDecoder, P2P, Serializer, Transaction} from '@wharfkit/antelope';
import {WebSocket, WebSocketServer} from 'ws';

export const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export const canonical = (value: any): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
export const contractAccount = 'hyp.replay';
const maximumFixtureBytes = 256 * 1024 * 1024;
export function decodeExact(data: any, type: string, abi: any): any {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'hex') : Buffer.from(data.array ?? data);
    assert.ok(bytes.length > 0 && bytes.length <= 16 * 1024 * 1024, 'invalid encoded payload size');
    const decoder = new ABIDecoder(bytes); const value = Serializer.decode({data: decoder, type, abi});
    assert.equal(decoder.getPosition(), bytes.length, `trailing bytes in ${type}`); return value;
}
export function genesisChainId(bytes: Buffer) {
    const genesis = JSON.parse(bytes.toString());
    const fields = ['max_block_net_usage', 'target_block_net_usage_pct', 'max_transaction_net_usage', 'base_per_transaction_net_usage',
        'net_usage_leeway', 'context_free_discount_net_usage_num', 'context_free_discount_net_usage_den', 'max_block_cpu_usage',
        'target_block_cpu_usage_pct', 'max_transaction_cpu_usage', 'min_transaction_cpu_usage', 'max_transaction_lifetime',
        'deferred_trx_expiration_window', 'max_transaction_delay', 'max_inline_action_size', 'max_inline_action_depth', 'max_authority_depth'];
    const abi = {version: 'eosio::abi/1.1', structs: [
        {name: 'chain_config', base: '', fields: fields.map((name, index) => ({name, type: index === 0 ? 'uint64' : index >= 15 ? 'uint16' : 'uint32'}))},
        {name: 'genesis_state', base: '', fields: [{name: 'initial_timestamp', type: 'time_point'}, {name: 'initial_key', type: 'public_key'}, {name: 'initial_configuration', type: 'chain_config'}]}]};
    return digest(Serializer.encode({object: genesis, type: 'genesis_state', abi}).array);
}
// (module (memory (export "memory") 1) (func (export "apply") (param i64 i64 i64)))
// Deliberately no contract computation: the qualification exercises real transaction/SHIP/ABI decoding.
export const contractWasm = Buffer.from('0061736d0100000001070160037e7e7e00030201000503010001071202066d656d6f72790200056170706c7900000a040102000b', 'hex');
export function actionAbi(revision: 1 | 2): any {
    return {version: 'eosio::abi/1.2', types: [], structs: [{name: 'record', base: '', fields: [
        {name: 'sequence', type: 'uint64'}, ...(revision === 2 ? [{name: 'revision', type: 'uint32'}] : []), {name: 'memo', type: 'string'}]}],
        actions: [{name: 'record', type: 'record', ricardian_contract: ''}], tables: [], ricardian_clauses: [], error_messages: [], abi_extensions: [], variants: []};
}
export function encodeRecord(blockNum: number, frame: Buffer): Buffer {
    assert.ok(Number.isSafeInteger(blockNum) && blockNum >= 1 && blockNum <= 0xffffffff);
    assert.ok(frame.length > 0 && frame.length <= 16 * 1024 * 1024);
    const header = Buffer.alloc(8); header.writeUInt32LE(frame.length); header.writeUInt32LE(blockNum, 4);
    return Buffer.concat([header, frame]);
}
export function parseShard(bytes: Buffer): {blockNum: number; frame: Buffer}[] {
    const records: {blockNum: number; frame: Buffer}[] = []; let offset = 0;
    while (offset < bytes.length) {
        assert.ok(offset + 8 <= bytes.length, 'truncated record header');
        const length = bytes.readUInt32LE(offset); const blockNum = bytes.readUInt32LE(offset + 4); offset += 8;
        assert.ok(length > 0 && length <= 16 * 1024 * 1024, 'invalid record length');
        assert.ok(offset + length <= bytes.length, 'truncated record body');
        assert.ok(blockNum >= 1, 'invalid block number');
        records.push({blockNum, frame: bytes.subarray(offset, offset + length)}); offset += length;
    }
    assert.ok(records.length, 'empty shard'); return records;
}
export interface FixtureInput {file: string; bytes: number; sha256: string;}
export interface ContractFixture {
    schemaVersion: 1; origin: 'known-genesis'; complete: true; chainId: string; genesisSha256: string;
    range: {start: 1; end: number}; flags: {fetch_block: true; fetch_traces: true; fetch_deltas: true};
    inputs: FixtureInput[]; shards: string[]; blocks: number; expected: any[]; abiHistory: any[];
}
export function validateManifest(manifest: ContractFixture) {
    assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.origin, 'known-genesis'); assert.equal(manifest.complete, true);
    assert.match(manifest.chainId, /^[a-f0-9]{64}$/); assert.match(manifest.genesisSha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.range.start, 1, 'only fully known genesis history is supported');
    assert.ok(Number.isSafeInteger(manifest.range.end) && manifest.range.end >= 2 && manifest.range.end <= 20000);
    assert.equal(manifest.blocks, manifest.range.end);
    assert.deepEqual(manifest.flags, {fetch_block: true, fetch_traces: true, fetch_deltas: true});
    assert.ok(manifest.inputs.length >= 5 && manifest.inputs.length <= 1000);
    assert.equal(new Set(manifest.inputs.map(input => input.file)).size, manifest.inputs.length, 'duplicate input');
    for (const input of manifest.inputs) {
        assert.match(input.file, /^(?:protocol\.abi\.json|status\.bin|genesis\.json|expected\.json|abi-history\.json|shards\/frames-[0-9]{5}\.bin\.gz)$/);
        assert.ok(Number.isSafeInteger(input.bytes) && input.bytes > 0 && input.bytes <= 256 * 1024 * 1024);
        assert.match(input.sha256, /^[a-f0-9]{64}$/);
    }
    for (const required of ['protocol.abi.json', 'status.bin', 'genesis.json', 'expected.json', 'abi-history.json'])
        assert.ok(manifest.inputs.some(input => input.file === required), `missing ${required}`);
    assert.ok(manifest.shards.length > 0 && manifest.shards.length <= 200);
    assert.equal(new Set(manifest.shards).size, manifest.shards.length);
    for (const [index, shard] of manifest.shards.entries()) {
        assert.equal(shard, `shards/frames-${String(index).padStart(5, '0')}.bin.gz`);
        assert.ok(manifest.inputs.some(input => input.file === shard), 'missing shard digest');
    }
    assert.equal(manifest.inputs.length, manifest.shards.length + 5, 'unplanned input');
    assert.ok(manifest.inputs.reduce((sum, input) => sum + input.bytes, 0) <= maximumFixtureBytes, 'fixture input byte budget exceeded');
    assert.equal(manifest.abiHistory.length, 2, 'both ABI deployments required');
    let previous = 0;
    for (const [i, entry] of manifest.abiHistory.entries()) {
        assert.equal(entry.account, contractAccount); assert.equal(entry.revision, i + 1);
        assert.ok(Number.isSafeInteger(entry.block) && entry.block > previous && entry.block <= manifest.range.end);
        assert.match(entry.trxId, /^[a-f0-9]{64}$/); assert.match(entry.abiHex, /^[a-f0-9]+$/);
        assert.equal(entry.abiHex, Buffer.from(Serializer.encode({object: ABI.from(actionAbi((i + 1) as 1 | 2))}).array).toString('hex'));
        assert.equal(entry.sha256, digest(Buffer.from(entry.abiHex, 'hex'))); previous = entry.block;
    }
    assert.ok(manifest.expected.length >= 4 && manifest.expected.length <= 1000);
    const sequences = new Set(); const transactions = new Set(manifest.abiHistory.map(entry => entry.trxId));
    assert.equal(transactions.size, manifest.abiHistory.length, 'duplicate ABI deployment transaction');
    for (const entry of manifest.expected) {
        assert.match(entry.trxId, /^[a-f0-9]{64}$/); assert.ok(!transactions.has(entry.trxId)); transactions.add(entry.trxId);
        assert.ok(Number.isSafeInteger(entry.block) && entry.block > 1 && entry.block <= manifest.range.end);
        assert.ok([1, 2].includes(entry.revision));
        const abi = manifest.abiHistory[entry.revision - 1]; const next = manifest.abiHistory[entry.revision];
        assert.ok(entry.block > abi.block && (!next || entry.block < next.block), 'action outside deployed ABI validity');
        assert.ok(Number.isSafeInteger(entry.data.sequence) && entry.data.sequence > 0 && !sequences.has(entry.data.sequence));
        sequences.add(entry.data.sequence); assert.equal(typeof entry.data.memo, 'string');
        assert.deepEqual(Object.keys(entry.data).sort(), (entry.revision === 1 ? ['memo', 'sequence'] : ['memo', 'revision', 'sequence']));
        if (entry.revision === 2) assert.equal(entry.data.revision, 2);
    }
    assert.ok(manifest.expected.some(entry => entry.revision === 1) && manifest.expected.some(entry => entry.revision === 2));
}
async function readRegular(root: string, file: string) {
    const path = resolve(root, file); assert.ok(path.startsWith(resolve(root) + sep));
    assert.ok(!(await lstat(root)).isSymbolicLink(), 'fixture root must not be a link');
    if (file.includes('/')) assert.ok(!(await lstat(join(root, file.split('/')[0]))).isSymbolicLink(), 'input parent must not be a link');
    const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink(), 'input must be a regular file');
    const maximum = file === 'manifest.json' ? 1024 * 1024 : maximumFixtureBytes;
    assert.ok(info.size > 0 && info.size <= maximum, 'fixture file exceeds byte budget');
    const bytes = await readFile(path); assert.equal(bytes.length, info.size, 'fixture input changed while reading');
    assert.ok(bytes.length <= maximum, 'fixture file exceeds byte budget'); return bytes;
}
export function decodeBlock(frame: Buffer, abi: ABI) {
    const result: any = decodeExact(frame, 'result', abi);
    assert.equal(result[0], 'get_blocks_result_v0'); const block = result[1];
    assert.ok(block.this_block); assert.ok(block.block?.length, 'missing requested block payload');
    const decoder = new ABIDecoder(block.block.array); const header = Serializer.decode({data: decoder, type: P2P.SignedBlock});
    assert.equal(decoder.getPosition(), block.block.length, 'trailing signed block bytes');
    assert.ok(block.traces?.length || header.transactions.length === 0, 'missing transaction traces');
    const number = Number(block.this_block.block_num); const id = block.this_block.block_id.toString();
    assert.equal(Number(header.blockNum), number, 'decoded block number mismatch'); assert.equal(header.id.toString(), id, 'decoded block hash mismatch');
    if (block.prev_block) {
        assert.equal(Number(block.prev_block.block_num), number - 1, 'decoded previous block number mismatch');
        assert.equal(header.previous.toString(), block.prev_block.block_id.toString(), 'decoded previous hash mismatch');
    } else {
        assert.equal(number, 1, 'missing previous position outside genesis');
        assert.equal(header.previous.toString(), '0'.repeat(64), 'genesis previous hash must be zero');
    }
    const receipts = header.transactions.map(receipt => {
        const transaction: any = Serializer.objectify(receipt.trx); let id: string; let actions: any[] | undefined;
        if (transaction[0] === 'packed_transaction') {
            const compression = Number(transaction[1].compression); assert.ok([0, 1].includes(compression), 'unsupported packed transaction compression');
            const packed = Buffer.from(transaction[1].packed_trx, 'hex'); let raw = packed;
            if (compression === 1) {
                try { raw = inflateSync(packed, {maxOutputLength: 1024 * 1024}); }
                catch (error) { throw new Error('packed transaction decompression failed within its byte budget', {cause: error}); }
            }
            assert.ok(raw.length > 0 && raw.length <= 1024 * 1024, 'packed transaction raw byte budget exceeded');
            const decoder = new ABIDecoder(raw); const unpacked = Serializer.decode({data: decoder, type: Transaction});
            assert.equal(decoder.getPosition(), raw.length, 'trailing packed transaction bytes'); id = unpacked.id.toString();
            actions = Serializer.objectify(unpacked.actions);
        }
        else { assert.equal(transaction[0], 'checksum256', 'unsupported signed transaction receipt'); id = String(transaction[1]); }
        assert.match(id, /^[a-f0-9]{64}$/); return {id, status: Number(receipt.status), actions};
    });
    assert.equal(new Set(receipts.map(receipt => receipt.id)).size, receipts.length, 'duplicate signed transaction receipt');
    return {block, header, number, id, previous: header.previous.toString(), receipts};
}
export async function auditFixture(root: string) {
    const manifestBytes = await readRegular(root, 'manifest.json');
    const manifest: ContractFixture = JSON.parse(manifestBytes.toString());
    validateManifest(manifest); const files = new Map<string, Buffer>();
    for (const input of manifest.inputs) {
        const bytes = await readRegular(root, input.file); assert.equal(bytes.length, input.bytes, `size mismatch: ${input.file}`);
        assert.equal(digest(bytes), input.sha256, `digest mismatch: ${input.file}`); files.set(input.file, bytes);
    }
    assert.equal(digest(files.get('genesis.json')!), manifest.genesisSha256);
    assert.equal(genesisChainId(files.get('genesis.json')!), manifest.chainId, 'genesis chain ID differs');
    assert.deepEqual(JSON.parse(files.get('expected.json')!.toString()), manifest.expected);
    assert.deepEqual(JSON.parse(files.get('abi-history.json')!.toString()), manifest.abiHistory);
    const abi = ABI.from(files.get('protocol.abi.json')!.toString());
    const status: any = decodeExact(files.get('status.bin')!, 'result', abi);
    assert.equal(status[0], 'get_status_result_v0'); const state = status[1];
    assert.equal(state.chain_id.toString(), manifest.chainId);
    const traceBegin = Number(state.trace_begin_block); assert.ok([1, 2].includes(traceBegin), 'trace history is missing after genesis');
    assert.equal(Number(state.chain_state_begin_block), 1);
    assert.ok(Number(state.last_irreversible.block_num) >= manifest.range.end); assert.ok(Number(state.trace_end_block) > manifest.range.end);
    assert.ok(Number(state.chain_state_end_block) > manifest.range.end);
    let next = 1; let previous: string | undefined; const records: {blockNum: number; frame: Buffer; id: string; previous: string}[] = [];
    const deployments: any[] = []; const expected = new Map(manifest.expected.map(entry => [entry.trxId, entry])); const found: any[] = []; let uncompressedBytes = 0;
    const expectedReceipts = new Map([...manifest.expected, ...manifest.abiHistory].map(entry => [entry.trxId, entry]));
    const receiptCoverage = new Set<string>();
    for (const shard of manifest.shards) {
        const raw = gunzipSync(files.get(shard)!, {maxOutputLength: 256 * 1024 * 1024});
        uncompressedBytes += raw.length; assert.ok(uncompressedBytes <= maximumFixtureBytes, 'decompressed fixture byte budget exceeded');
        for (const record of parseShard(raw)) {
            assert.equal(record.blockNum, next++, 'missing, duplicated or unordered record');
            const decoded = decodeBlock(record.frame, abi); assert.equal(decoded.number, record.blockNum);
            if (previous) assert.equal(decoded.previous, previous, 'block hash discontinuity'); previous = decoded.id;
            for (const receipt of decoded.receipts) if (expectedReceipts.has(receipt.id)) {
                assert.equal(receipt.status, 0, 'expected transaction receipt was not executed');
                assert.equal(record.blockNum, expectedReceipts.get(receipt.id).block, 'transaction receipt block mismatch');
                assert.ok(!receiptCoverage.has(receipt.id), 'expected transaction receipt duplicated'); receiptCoverage.add(receipt.id);
                const expectedAction = expected.get(receipt.id);
                if (expectedAction) {
                    const data = Buffer.from(Serializer.encode({object: expectedAction.data, type: 'record', abi: actionAbi(expectedAction.revision)}).array).toString('hex');
                    assert.deepEqual(receipt.actions, [{account: contractAccount, name: 'record',
                        authorization: [{actor: contractAccount, permission: 'active'}], data}], 'packed direct action differs from expected action');
                }
            }
            const deltas: any = decoded.block.deltas?.length ? Serializer.objectify(decodeExact(decoded.block.deltas.array, 'table_delta[]', abi)) : [];
            for (const delta of deltas) if (delta[1].name === 'account') for (const row of delta[1].rows) if (Number(row.present)) {
                const account: any = Serializer.objectify(decodeExact(row.data, 'account', abi));
                if (account[1].name === contractAccount && account[1].abi) deployments.push({block: record.blockNum, abiHex: account[1].abi});
            }
            const traces: any = decoded.block.traces?.length ? Serializer.objectify(decodeExact(decoded.block.traces.array, 'transaction_trace[]', abi)) : [];
            for (const variant of traces) {
                const trace = variant[1]; const expectedAction = expected.get(trace.id);
                for (const actionVariant of trace.action_traces ?? []) {
                    const action = actionVariant[1];
                    if (action.act.account !== contractAccount || action.act.name !== 'record') continue;
                    assert.ok(expectedAction, 'unexpected contract transaction in fixture'); assert.equal(Number(trace.status), 0);
                    assert.ok(decoded.receipts.some(receipt => receipt.id === trace.id && receipt.status === 0), 'target trace has no executed signed transaction receipt');
                    assert.equal(action.receiver, contractAccount); assert.equal(action.except, null);
                    assert.deepEqual(action.act.authorization, [{actor: contractAccount, permission: 'active'}], 'target trace authorization differs');
                    assert.equal(action.act.data, decoded.receipts.find(receipt => receipt.id === trace.id)!.actions![0].data, 'packed and trace action bytes differ');
                    assert.equal(record.blockNum, expectedAction.block);
                    const data = Serializer.objectify(decodeExact(action.act.data, 'record', actionAbi(expectedAction.revision)));
                    assert.ok(['string', 'number'].includes(typeof data.sequence));
                    assert.deepEqual({...data, sequence: Number(data.sequence)}, expectedAction.data);
                    const globalSequence = Number(action.receipt[1].global_sequence); assert.ok(Number.isSafeInteger(globalSequence) && globalSequence > 0);
                    found.push({...expectedAction, globalSequence, blockId: decoded.id});
                }
            }
            records.push({...record, id: decoded.id, previous: decoded.previous});
        }
    }
    assert.equal(records.length, manifest.blocks); assert.equal(next - 1, manifest.range.end);
    if (traceBegin === 2) {
        // Spring records genesis state at 1, but its first trace log is at 2.
        // Only the independently hashed empty genesis block can bridge this.
        assert.equal(decodeBlock(records[0].frame, abi).block.traces, null, 'unexpected genesis traces before trace log begins');
    }
    assert.deepEqual(deployments, manifest.abiHistory.map(entry => ({block: entry.block, abiHex: entry.abiHex})), 'captured ABI deployment coverage differs');
    assert.equal(receiptCoverage.size, expectedReceipts.size, 'expected signed transaction receipt coverage differs');
    assert.equal(found.length, expected.size); assert.equal(new Set(found.map(entry => entry.trxId)).size, expected.size);
    let sequence = 0; for (const action of found) { assert.ok(action.globalSequence > sequence); sequence = action.globalSequence; }
    return {manifest, manifestBytes, abi, files, records, actions: found, replayStart: traceBegin};
}
export async function captureFixture(url: string, directory: string, end: number, base: Omit<ContractFixture, 'inputs' | 'shards' | 'blocks'>, genesis: Buffer) {
    await mkdir(directory); await mkdir(join(directory, 'shards')); const frames: Buffer[] = [];
    let abi: ABI | undefined; let protocol: Buffer | undefined; let status: Buffer | undefined; let settled = false; let capturedBytes = 0;
    await new Promise<void>((done, reject) => {
        const socket = new WebSocket(url, {maxPayload: 16 * 1024 * 1024, perMessageDeflate: false});
        const timer = setTimeout(() => fail(new Error('SHIP capture deadline')), 120000);
        const send = (object: any) => socket.send(Serializer.encode({object, type: 'request', abi: abi!}).array);
        const fail = (error: Error) => {
            if (settled) return; settled = true; clearTimeout(timer); socket.terminate();
            try { writeFileSync(join(directory, 'capture-failure.json'), JSON.stringify({complete: false, capturedBlocks: frames.length,
                message: error.message, stack: error.stack}, null, 2) + '\n', {flag: 'wx'}); } catch {}
            reject(error);
        };
        socket.on('error', fail); socket.on('close', () => { if (!settled) fail(new Error('SHIP closed before finite capture completed')); });
        socket.on('message', data => { try {
            const bytes = Buffer.from(data as Buffer);
            if (!abi) { protocol = bytes; writeFileSync(join(directory, 'capture-protocol.abi.json'), bytes, {flag: 'wx'});
                abi = ABI.from(bytes.toString()); send(['get_status_request_v0', {}]); return; }
            // Qualification correctness takes priority over capture I/O speed.
            // Preserve the raw envelope even when the next decoder rejects it.
            writeFileSync(join(directory, 'capture-last-frame.bin'), bytes);
            const message: any = decodeExact(bytes, 'result', abi);
            if (message[0] === 'get_status_result_v0') {
                assert.equal(status, undefined); status = bytes; writeFileSync(join(directory, 'capture-status.bin'), bytes, {flag: 'wx'});
                send(['get_blocks_request_v0', {start_block_num: 1, end_block_num: end + 1, max_messages_in_flight: 8,
                    have_positions: [], irreversible_only: true, ...base.flags}]); return;
            }
            const decoded = decodeBlock(bytes, abi); assert.equal(decoded.number, frames.length + 1);
            capturedBytes += bytes.length + 8; assert.ok(capturedBytes <= maximumFixtureBytes, 'capture byte budget exceeded'); frames.push(encodeRecord(decoded.number, bytes));
            if (decoded.number === end) { settled = true; clearTimeout(timer); socket.close(); done(); }
            else send(['get_blocks_ack_request_v0', {num_messages: 1}]);
        } catch (error) { fail(error as Error); } });
    });
    const inputs: FixtureInput[] = []; const put = async (file: string, bytes: Buffer) => {
        await writeFile(join(directory, file), bytes, {flag: 'wx'}); inputs.push({file, bytes: bytes.length, sha256: digest(bytes)});
    };
    await put('protocol.abi.json', protocol!); await put('status.bin', status!); await put('genesis.json', genesis);
    await put('expected.json', Buffer.from(JSON.stringify(base.expected, null, 2) + '\n'));
    await put('abi-history.json', Buffer.from(JSON.stringify(base.abiHistory, null, 2) + '\n'));
    const shards: string[] = []; for (let offset = 0; offset < frames.length; offset += 100) {
        const file = `shards/frames-${String(shards.length).padStart(5, '0')}.bin.gz`; shards.push(file);
        await put(file, gzipSync(Buffer.concat(frames.slice(offset, offset + 100))));
    }
    const manifest: ContractFixture = {...base, inputs, shards, blocks: frames.length}; validateManifest(manifest);
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
    return auditFixture(directory);
}
export async function serveFixture(fixture: Awaited<ReturnType<typeof auditFixture>>, errors: string[]) {
    const server = new WebSocketServer({host: '127.0.0.1', port: 0, maxPayload: 1024 * 1024});
    await new Promise<void>((done, reject) => { server.once('listening', done); server.once('error', reject); });
    const requests: any[] = [];
    server.on('connection', socket => {
        socket.send(fixture.files.get('protocol.abi.json')!); let next = 0; let end = 0; let budget = 0;
        const pump = () => { while (budget > 0 && next < end) {
            const frame = fixture.records[next].frame; assert.ok(socket.bufferedAmount + frame.length <= 32 * 1024 * 1024, 'replay socket byte budget exceeded');
            socket.send(frame); next++; budget--;
        } };
        socket.on('error', error => errors.push(error.message));
        socket.on('message', data => { try {
            const request: any = Serializer.objectify(decodeExact(data as Buffer, 'request', fixture.abi));
            const [type, value] = request; requests.push({type, value, at: Date.now()});
            if (type === 'get_status_request_v0') { socket.send(fixture.files.get('status.bin')!); return; }
            if (type === 'get_blocks_ack_request_v0') { assert.ok(Number.isSafeInteger(value.num_messages) && value.num_messages > 0 && value.num_messages <= 10000); budget += value.num_messages; pump(); return; }
            assert.equal(type, 'get_blocks_request_v0', 'protocol revision mismatch');
            for (const [key, expected] of Object.entries(fixture.manifest.flags)) assert.equal(value[key], expected, `request flag mismatch: ${key}`);
            next = value.start_block_num - 1; end = value.end_block_num - 1; budget = value.max_messages_in_flight;
            assert.ok(Number.isSafeInteger(next) && next >= 0 && next < fixture.records.length);
            assert.ok(Number.isSafeInteger(end) && end > next && end <= fixture.records.length, 'request outside verified fixture range');
            assert.ok(Number.isSafeInteger(budget) && budget > 0 && budget <= 10000); pump();
        } catch (error) { errors.push(String(error)); socket.close(1008, 'fixture request rejected'); } });
    });
    return {url: `ws://127.0.0.1:${(server.address() as any).port}`, requests,
        close: async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(done => server.close(() => done())); }};
}
