import {describe, expect, test} from 'bun:test';
import {mkdtemp, mkdir, readFile, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {ABI, P2P, PrivateKey, Serializer} from '@wharfkit/antelope';
import {actionAbi, auditFixture, contractAccount, contractWasm, decodeBlock, decodeExact, digest, encodeRecord, genesisChainId, parseShard,
    validateManifest, type ContractFixture} from '../../scripts/qualification/contract-fixture.ts';
import {assertActionOutputs, assertBlockOutputs, assertContractAbsent, assertEmptyProjection, assertOwnedServices, assertResourceIsolation} from '../../scripts/qualification/contract-replay.ts';

const zero = '0'.repeat(64);
const abiHex = (revision: 1 | 2) => Buffer.from(Serializer.encode({object: ABI.from(actionAbi(revision))}).array).toString('hex');
function manifest(): ContractFixture {
    return {schemaVersion: 1, origin: 'known-genesis', complete: true, chainId: zero, genesisSha256: zero, range: {start: 1, end: 6},
        flags: {fetch_block: true, fetch_traces: true, fetch_deltas: true}, blocks: 6, shards: ['shards/frames-00000.bin.gz'],
        inputs: ['protocol.abi.json', 'status.bin', 'genesis.json', 'expected.json', 'abi-history.json', 'shards/frames-00000.bin.gz'].map(file => ({file, bytes: 1, sha256: zero})),
        abiHistory: [1, 2].map(revision => ({account: contractAccount, revision, block: revision * 2, trxId: String(revision).repeat(64),
            abiHex: abiHex(revision as 1 | 2), sha256: digest(Buffer.from(abiHex(revision as 1 | 2), 'hex'))})),
        expected: [1, 2, 3, 4].map(sequence => ({revision: sequence <= 2 ? 1 : 2, block: sequence <= 2 ? 3 : 5,
            trxId: String(sequence + 2).repeat(64), data: {sequence, ...(sequence > 2 ? {revision: 2} : {}), memo: 'payload-' + sequence}}))};
}

// Unit-only protocol: deliberately small but actual ABI binary encoding, P2P header hashing,
// account variants, transaction/action variants and record framing all traverse the real auditor.
const fields = (entries: Record<string, string>) => Object.entries(entries).map(([name, type]) => ({name, type}));
const struct = (name: string, entries: Record<string, string>) => ({name, base: '', fields: fields(entries)});
const protocol: any = {version: 'eosio::abi/1.1', structs: [
    struct('position', {block_num: 'uint32', block_id: 'checksum256'}),
    struct('get_status_result_v0', {chain_id: 'checksum256', head: 'position', last_irreversible: 'position', trace_begin_block: 'uint32', trace_end_block: 'uint32', chain_state_begin_block: 'uint32', chain_state_end_block: 'uint32'}),
    struct('get_blocks_result_v0', {head: 'position', last_irreversible: 'position', this_block: 'position?', prev_block: 'position?', block: 'bytes?', traces: 'bytes?', deltas: 'bytes?'}),
    struct('delta_row', {present: 'bool', data: 'bytes'}), struct('table_delta_v0', {name: 'string', rows: 'delta_row[]'}),
    struct('account_v0', {name: 'name', abi: 'bytes'}), struct('permission', {actor: 'name', permission: 'name'}),
    struct('act', {account: 'name', name: 'name', authorization: 'permission[]', data: 'bytes'}),
    struct('receipt_v0', {global_sequence: 'uint64'}),
    struct('action_trace_v0', {receiver: 'name', act: 'act', except: 'string?', receipt: 'receipt?'}),
    struct('transaction_trace_v0', {id: 'checksum256', status: 'uint8', action_traces: 'action_trace[]'})],
    variants: [{name: 'result', types: ['get_status_result_v0', 'get_blocks_result_v0']}, {name: 'account', types: ['account_v0']},
        {name: 'table_delta', types: ['table_delta_v0']}, {name: 'receipt', types: ['receipt_v0']},
        {name: 'action_trace', types: ['action_trace_v0']}, {name: 'transaction_trace', types: ['transaction_trace_v0']}]};
async function writeFixture(root: string, nullGenesisPrevious = false) {
    const m = manifest(); const genesis = await readFile(new URL('../e2e/nodeos/genesis.json', import.meta.url));
    m.chainId = genesisChainId(genesis); m.genesisSha256 = digest(genesis);
    await mkdir(join(root, 'shards')); let previous = zero; const records: Buffer[] = [];
    const encode = (type: string, object: any) => Buffer.from(Serializer.encode({type, object, abi: protocol}).array);
    for (let block = 1; block <= 6; block++) {
        const header = P2P.BlockHeader.from({timeSlot: block, producer: 'eosio', confirmed: 0, previous, transaction_mroot: zero,
            action_mroot: zero, schedule_version: 0, new_producers: undefined, header_extensions: []});
        const id = header.id.toString(); const entry = m.abiHistory.find(entry => entry.block === block);
        const deltas = entry ? [['table_delta_v0', {name: 'account', rows: [{present: true, data: encode('account', ['account_v0', {name: contractAccount, abi: entry.abiHex}])}]}]] : [];
        const traces = m.expected.filter(entry => entry.block === block).map(entry => ['transaction_trace_v0', {id: entry.trxId, status: 0,
            action_traces: [['action_trace_v0', {receiver: contractAccount, act: {account: contractAccount, name: 'record', authorization: [{actor: contractAccount, permission: 'active'}],
                data: Serializer.encode({object: entry.data, type: 'record', abi: actionAbi(entry.revision)}).array}, except: null,
                receipt: ['receipt_v0', {global_sequence: entry.data.sequence + 100}]}]]}]);
        const signed = P2P.SignedBlock.from({...Serializer.objectify(header),
            producer_signature: PrivateKey.from('5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3').signDigest(header.id), transactions: [], block_extensions: []});
        const frame = encode('result', ['get_blocks_result_v0', {head: {block_num: 6, block_id: zero}, last_irreversible: {block_num: 6, block_id: zero},
            this_block: {block_num: block, block_id: id}, prev_block: block === 1 && nullGenesisPrevious ? null : {block_num: block - 1, block_id: previous},
            block: Serializer.encode({object: signed}).array, traces: block === 1 && nullGenesisPrevious ? null : encode('transaction_trace[]', traces), deltas: encode('table_delta[]', deltas)}]);
        records.push(encodeRecord(block, frame)); previous = id;
    }
    const files: Record<string, Buffer> = {'genesis.json': genesis, 'protocol.abi.json': Buffer.from(JSON.stringify(protocol)),
        'expected.json': Buffer.from(JSON.stringify(m.expected)), 'abi-history.json': Buffer.from(JSON.stringify(m.abiHistory)),
        'shards/frames-00000.bin.gz': gzipSync(Buffer.concat(records)),
        'status.bin': encode('result', ['get_status_result_v0', {chain_id: m.chainId, head: {block_num: 6, block_id: zero},
            last_irreversible: {block_num: 6, block_id: zero}, trace_begin_block: 1, trace_end_block: 7, chain_state_begin_block: 1, chain_state_end_block: 7}])};
    m.inputs = []; for (const [file, bytes] of Object.entries(files)) { await writeFile(join(root, file), bytes); m.inputs.push({file, bytes: bytes.length, sha256: digest(bytes)}); }
    await writeFile(join(root, 'manifest.json'), JSON.stringify(m)); return {m, records};
}
async function temporary(run: (directory: string) => Promise<void>) {
    const path = await mkdtemp(join(tmpdir(), 'hyperion-replay-unit-'));
    try { await run(path); } finally { await rm(path, {recursive: true, force: true}); }
}
describe('guarded contract replay input', () => {
    test('no-op WASM is valid and genesis chain ID is independently serialized', async () => {
        expect(WebAssembly.validate(contractWasm)).toBe(true);
        const module = new WebAssembly.Module(contractWasm); expect(WebAssembly.Module.imports(module)).toEqual([]);
        expect(WebAssembly.Module.exports(module)).toEqual([{name: 'memory', kind: 'memory'}, {name: 'apply', kind: 'function'}]);
        (new WebAssembly.Instance(module).exports.apply as Function)(0n, 0n, 0n);
        const bytes = await readFile(new URL('../e2e/nodeos/genesis.json', import.meta.url));
        expect(genesisChainId(bytes)).toBe('d8b73ada6b0ff982b5bafed1cde4d7612cc778ff82206c3b67d31a134f95be6c');
        expect(genesisChainId(Buffer.from(JSON.stringify(JSON.parse(bytes.toString()), null, 4)))).toBe(genesisChainId(bytes));
    });
    test('strict framing rejects every partial header/body, empty and oversized records', () => {
        const valid = encodeRecord(7, Buffer.from('frame')); expect(parseShard(valid)[0].blockNum).toBe(7);
        for (let length = 1; length < valid.length; length++) expect(() => parseShard(valid.subarray(0, length))).toThrow();
        expect(() => parseShard(Buffer.alloc(0))).toThrow(); expect(() => parseShard(Buffer.alloc(8))).toThrow();
        const oversized = Buffer.alloc(8); oversized.writeUInt32LE(16 * 1024 * 1024 + 1); oversized.writeUInt32LE(1, 4);
        expect(() => parseShard(oversized)).toThrow(); expect(() => encodeRecord(0, Buffer.from('x'))).toThrow();
    });
    test('trailing ABI bytes cannot pass a digest-correct payload', () => {
        const bytes = Buffer.from(Serializer.encode({object: {sequence: 1, memo: 'valid'}, type: 'record', abi: actionAbi(1)}).array);
        expect(decodeExact(bytes, 'record', actionAbi(1))).toBeDefined();
        expect(() => decodeExact(Buffer.concat([bytes, Buffer.from([0])]), 'record', actionAbi(1))).toThrow('trailing bytes');
    });
    test('manifest refuses partial historical ABI seed and unsafe input references', () => {
        validateManifest(manifest());
        const cases = [
            (m: any) => { m.complete = false; }, (m: any) => { m.range.start = 2; }, (m: any) => { m.blocks--; },
            (m: any) => { m.abiHistory.pop(); }, (m: any) => { m.abiHistory[0].abiHex = abiHex(2); },
            (m: any) => { m.expected[0].block = 4; }, (m: any) => { m.expected[2].revision = 1; },
            (m: any) => { m.expected[1].trxId = m.expected[0].trxId; }, (m: any) => { m.flags.fetch_traces = false; },
            (m: any) => { m.inputs[0].file = '../unowned'; }, (m: any) => { m.inputs.push(m.inputs[0]); },
            (m: any) => { m.shards.push('shards/frames-00002.bin.gz'); }, (m: any) => { m.inputs[0].sha256 = 'garbage'; }];
        for (const mutate of cases) { const value = manifest(); mutate(value); expect(() => validateManifest(value)).toThrow(); }
    });
    test('actual binary fixture audit proves block hashes, ABI epochs and all action data', async () => temporary(async root => {
        await writeFixture(root); const audited = await auditFixture(root); expect(audited.records.length).toBe(6); expect(audited.actions.length).toBe(4);
        expect(audited.actions.map(action => action.globalSequence)).toEqual([101, 102, 103, 104]);
        expect(audited.manifest.abiHistory.map(entry => entry.block)).toEqual([2, 4]);
    }));
    test('only the zero-anchored genesis block may omit its previous position', async () => temporary(async root => {
        const {m, records} = await writeFixture(root, true); expect((await auditFixture(root)).records.length).toBe(6);
        const record = parseShard(records[1])[0]; const value: any = Serializer.objectify(Serializer.decode({data: record.frame, type: 'result', abi: protocol}));
        value[1].prev_block = null; records[1] = encodeRecord(2, Buffer.from(Serializer.encode({object: value, type: 'result', abi: protocol}).array));
        const bytes = gzipSync(Buffer.concat(records)); const input = m.inputs.find(input => input.file.startsWith('shards/'))!;
        input.bytes = bytes.length; input.sha256 = digest(bytes); await writeFile(join(root, input.file), bytes); await writeFile(join(root, 'manifest.json'), JSON.stringify(m));
        await expect(auditFixture(root)).rejects.toThrow('missing previous position outside genesis');
    }));
    test('actual pinned Spring genesis permits null traces with an empty signed block', async () => {
        const protocolBytes = await readFile(new URL('./fixtures/ship-genesis/protocol.json', import.meta.url));
        const frame = await readFile(new URL('./fixtures/ship-genesis/frame.bin', import.meta.url));
        expect(digest(protocolBytes)).toBe('f17a3bc91db1baa017c78ed31ed82eb52a4f4f12b661d59d15815bc9fab0e12e');
        expect(digest(frame)).toBe('85d8a6d8fb004c0c5ff8031522d449b0ff226a382d974b469de8279021e61653');
        const value = decodeBlock(frame, ABI.from(protocolBytes.toString()));
        expect(value.number).toBe(1); expect(value.previous).toBe(zero);
        expect(value.id).toBe('000000014f6c4bbe621c19e0028a671ab0093936ec07ef31365e58a119852628');
        expect(value.block.traces).toBeNull();
    });
    test('trace history can start at 2 only across the exact empty genesis block', async () => temporary(async root => {
        const {m} = await writeFixture(root, true); const bytes = await readFile(join(root, 'status.bin'));
        const value: any = Serializer.objectify(Serializer.decode({data: bytes, type: 'result', abi: protocol}));
        for (const begin of [2, 3]) {
            value[1].trace_begin_block = begin; const replacement = Buffer.from(Serializer.encode({object: value, type: 'result', abi: protocol}).array);
            const input = m.inputs.find(input => input.file === 'status.bin')!; input.bytes = replacement.length; input.sha256 = digest(replacement);
            await writeFile(join(root, 'status.bin'), replacement); await writeFile(join(root, 'manifest.json'), JSON.stringify(m));
            if (begin === 2) { const audited = await auditFixture(root); expect(audited.records.length).toBe(6); expect(audited.replayStart).toBe(2);
                expect(audited.records.filter(record => record.blockNum >= audited.replayStart).map(record => record.blockNum)).toEqual([2, 3, 4, 5, 6]);
            } else await expect(auditFixture(root)).rejects.toThrow('missing after genesis');
        }
    }));
    test('tampering, truncation, missing and symlink inputs fail before replay', async () => temporary(async root => {
        const {m} = await writeFixture(root); const path = join(root, 'status.bin'); const original = await readFile(path);
        await writeFile(path, original.subarray(0, -1)); await expect(auditFixture(root)).rejects.toThrow('size mismatch');
        await writeFile(path, Buffer.from(original).fill(1)); await expect(auditFixture(root)).rejects.toThrow('digest mismatch');
        await rm(path); await expect(auditFixture(root)).rejects.toThrow(); await writeFile(path, original);
        await writeFile(join(root, 'expected.json'), '{}'); await expect(auditFixture(root)).rejects.toThrow();
        await writeFile(join(root, 'expected.json'), JSON.stringify(m.expected)); await rm(path);
        // File symlinks may need developer privileges on Windows; only assert when creation succeeds.
        try { await symlink(join(root, 'expected.json'), path); } catch (error: any) { if (process.platform === 'win32' && error.code === 'EPERM') return; throw error; }
        await expect(auditFixture(root)).rejects.toThrow('regular file');
    }));
    test('digest-correct but reordered blocks and missing ABI update still fail decoded audit', async () => temporary(async root => {
        const {m, records} = await writeFixture(root); [records[2], records[3]] = [records[3], records[2]];
        const bytes = gzipSync(Buffer.concat(records)); const file = m.inputs.find(input => input.file.startsWith('shards/'))!;
        file.bytes = bytes.length; file.sha256 = digest(bytes); await writeFile(join(root, file.file), bytes); await writeFile(join(root, 'manifest.json'), JSON.stringify(m));
        await expect(auditFixture(root)).rejects.toThrow('unordered record');
    }));
    test('valid hashes cannot hide missing ABI deployments, transactions or requested payloads', async () => temporary(async root => {
        const changes = [
            {block: 4, mutate: (value: any) => { value.deltas = Buffer.from(Serializer.encode({type: 'table_delta[]', object: [], abi: protocol}).array).toString('hex'); }, error: 'ABI deployment coverage'},
            {block: 3, mutate: (value: any) => { value.traces = Buffer.from(Serializer.encode({type: 'transaction_trace[]', object: [], abi: protocol}).array).toString('hex'); }, error: 'strictly equal'},
            {block: 2, mutate: (value: any) => { value.block = ''; }, error: 'missing requested block payload'}];
        for (const [index, change] of changes.entries()) {
            const directory = join(root, String(index)); await mkdir(directory); const {m, records} = await writeFixture(directory);
            const record = parseShard(records[change.block - 1])[0];
            const value: any = Serializer.objectify(Serializer.decode({data: record.frame, type: 'result', abi: protocol}));
            change.mutate(value[1]); const replaced = Buffer.from(Serializer.encode({object: value, type: 'result', abi: protocol}).array);
            records[change.block - 1] = encodeRecord(change.block, replaced); const bytes = gzipSync(Buffer.concat(records));
            const input = m.inputs.find(input => input.file.startsWith('shards/'))!; input.bytes = bytes.length; input.sha256 = digest(bytes);
            await writeFile(join(directory, input.file), bytes); await writeFile(join(directory, 'manifest.json'), JSON.stringify(m));
            await expect(auditFixture(directory)).rejects.toThrow(change.error);
        }
    }));
});
describe('independent output oracle', () => {
    test('exact action oracle rejects data, identity, count, order and decode failures', () => {
        const expected = manifest().expected.map((entry, index) => ({...entry, blockId: zero, globalSequence: index + 101}));
        const hits = expected.map(entry => ({_id: String(entry.globalSequence), _source: {global_sequence: entry.globalSequence, trx_id: entry.trxId,
            block_num: entry.block, block_id: entry.blockId, act: {account: contractAccount, name: 'record', authorization: [{actor: contractAccount, permission: 'active'}], data: {...entry.data}}}}));
        assertActionOutputs(hits, expected);
        const mutations = [(value: any) => value.pop(), (value: any) => value.reverse(), (value: any) => { value[0]._source.ds_error = true; },
            (value: any) => { value[0]._id = '999'; }, (value: any) => { value[0]._source.act.data.memo = 'wrong'; },
            (value: any) => { value[0]._source.trx_id = zero; }, (value: any) => { value[0]._source.act.data.extra = true; }];
        for (const mutate of mutations) { const value = structuredClone(hits); mutate(value); expect(() => assertActionOutputs(value, expected)).toThrow(); }
    });
    test('block oracle rejects gaps and hash mismatches', () => {
        const expected = [{blockNum: 1, id: '1'.repeat(64), previous: zero}];
        const hits = [{_id: '1', _source: {block_num: 1, block_id: expected[0].id, prev_id: zero}}]; assertBlockOutputs(hits, expected);
        expect(() => assertBlockOutputs([], expected)).toThrow(); hits[0]._source.prev_id = expected[0].id;
        expect(() => assertBlockOutputs(hits, expected)).toThrow();
    });
    test('unowned service manifest is rejected without any Docker or storage mutation', () => {
        expect(() => assertOwnedServices({schemaVersion: 1, status: 'ready', core: {run: 'shared'}}, {})).toThrow();
    });
    test('empty metadata permits fresh target; an actual index or queue refuses reuse', () => {
        assertEmptyProjection({}, []);
        expect(() => assertEmptyProjection({'hyp-replay-owned-action-v1': {aliases: {}}}, [])).toThrow('existing projection');
        expect(() => assertEmptyProjection({}, [{name: 'hyp-replay-owned:blocks:1'}])).toThrow('projection queues');
    });
    test('only the pinned Spring absent-account error permits contract creation', () => {
        const body = {error: {name: 'account_query_exception', code: 3060002, details: [{message: 'unable to retrieve account info (unknown key (boost::tuples::tuple<bool, eosio::chain::name,...>): (0 hyp.replay))'}]}};
        assertContractAbsent(400, body);
        for (const status of [200, 401, 404, 500]) expect(() => assertContractAbsent(status, body)).toThrow();
        for (const field of ['name', 'code', 'details']) { const changed: any = structuredClone(body); delete changed.error[field]; expect(() => assertContractAbsent(400, changed)).toThrow(); }
        for (const message of ['unknown key', 'unable to retrieve account information for other: unknown key', 'unable to retrieve account information for hyp.replay: timeout']) {
            const changed = structuredClone(body); changed.error.details[0].message = message; expect(() => assertContractAbsent(400, changed)).toThrow();
        }
    });
    test('network and data volumes must have only the exact fixture consumers', () => {
        const containers = Array.from({length: 7}, (_entry, index) => ({containerId: String(index + 1).repeat(64), volume: 'volume-' + index}));
        const state: any = {run: 'owned-run', network: 'owned-network', core: {nodes: containers.slice(0, 3), broker: containers[3]}, spring: containers[4], redis: containers[5], mongo: containers[6]};
        const network = {Name: state.network, Labels: {'io.eosrio.run': state.run, 'io.eosrio.qualifier': 'es198-replicas'}, Containers: Object.fromEntries(containers.map(item => [item.containerId, {}]))};
        const volumes = containers.map((item, index) => ({Name: item.volume, Labels: {'io.eosrio.run': state.run, 'io.eosrio.qualifier': index < 4 ? 'es198-replicas' : 'es198-workers'}}));
        const users = Object.fromEntries(containers.map(item => [item.volume, [item.containerId]])); assertResourceIsolation(state, network, volumes, users);
        const sharedNetwork = structuredClone(network); sharedNetwork.Containers['f'.repeat(64)] = {}; expect(() => assertResourceIsolation(state, sharedNetwork, volumes, users)).toThrow('network consumer');
        const sharedVolume = structuredClone(users); sharedVolume[containers[0].volume].push('f'.repeat(64)); expect(() => assertResourceIsolation(state, network, volumes, sharedVolume)).toThrow('volume consumer');
        const unowned = structuredClone(volumes); delete (unowned[0].Labels as any)['io.eosrio.run']; expect(() => assertResourceIsolation(state, network, unowned, users)).toThrow();
    });
});
