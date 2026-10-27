/** Immutable original Wire inputs with explicitly constructed reversible SHiP envelopes. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function prepareReversibleWorkerInputs(directory) {
    const capture = fileURLToPath(new URL('../fixtures/portable-state-worker/', import.meta.url));
    assert.equal(hash(readFileSync(join(capture, 'source-1-1480-20261020.tar.gz'))),
        '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
    const prepared = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
        [join(capture, 'prepare.py'), join(directory, 'capture')], {encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024});
    assert.equal(prepared.status, 0, prepared.stderr);
    const result = JSON.parse(prepared.stdout);
    assert.equal(result.files, 1488); assert.equal(result.bytes, 27982958); assert.equal(result.selectedBlocks, 1480);
    assert.equal(hash(readFileSync(result.plan)), result.planSha256);
    const source = join(directory, 'capture/source'), schemaJson = readFileSync(join(source, 'schema.json'), 'utf8');
    assert.equal(hash(schemaJson), '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9');
    const receipt = JSON.parse(readFileSync(join(source, 'receipt.json'))), index = new Map(receipt.frames.map(row => [row.blockNum, row]));
    const wire = await import('@eosrio/hyperion-wire-plugin');
    const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
    const codec = wire.createWireValueCodec(JSON.parse(schemaJson), wire.resolveCodecProfile(profileId));
    const frames = [], positions = new Map();
    for (let number = 1; number <= 34; number++) {
        const bytes = readFileSync(join(source, 'block-' + String(number).padStart(6, '0') + '.bin'));
        assert.equal(bytes.length, index.get(number).bytes); assert.equal(hash(bytes), index.get(number).sha256);
        const [kind, value] = codec.decode('result', bytes), current = value.this_block;
        assert.equal(Number(current.block_num), number);
        const originalPayload = Object.fromEntries(['block', 'traces', 'deltas'].map(key => [key, value[key]]));
        const replacement = {...value, head: current, last_irreversible: {block_num: 0, block_id: '0'.repeat(64)}};
        const frame = Buffer.from(codec.encode('result', [kind, replacement]));
        const decoded = codec.decode('result', frame)[1];
        assert.deepEqual(Object.fromEntries(['block', 'traces', 'deltas'].map(key => [key, decoded[key]])), originalPayload,
            'Only the controlled reversible envelope may differ from original captured source payload');
        const position = {chainId: receipt.chainId, blockNum: number, blockId: String(current.block_id).toLowerCase(),
            previousBlockId: number === 1 ? null : String(value.prev_block.block_id).toLowerCase()};
        assert.equal(position.blockId, index.get(number).blockId);
        positions.set(number, position);
        frames.push({number, originalSha256: hash(bytes), controlledFrameSha256: hash(frame), frameHex: frame.toString('hex'),
            position, capturedReceipt: index.get(number)});
    }
    const wireRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
    const oracleDirectory = join(wireRoot, 'fixtures/codec/native-onblock-6508-20261022');
    const oracleManifest = JSON.parse(readFileSync(join(oracleDirectory, 'manifest.json')));
    for (const member of oracleManifest.members) {
        const bytes = readFileSync(join(oracleDirectory, member.path)); assert.equal(bytes.length, member.bytes); assert.equal(hash(bytes), member.sha256);
    }
    const expected = new Map(JSON.parse(readFileSync(join(oracleDirectory, 'expected.json'))).map(value => [value.blockNum, value]));
    // The installed oracle covers 33/122/397. Block 34's native payload is the independently
    // captured block-33 RPC header, with trace identities specified as literal source expectations.
    const rpcBytes = readFileSync(new URL('../fixtures/wire-rpc-block-33.json', import.meta.url));
    assert.equal(hash(rpcBytes), '2fbe2a135ad825e5105843dfc0c31bbd8017c15e6b1d2ca9c973be90fd7ecc95');
    const rpc = JSON.parse(rpcBytes); assert.equal(rpc.id, positions.get(33).blockId);
    const expected34 = {blockNum: 34, blockId: index.get(34).blockId,
        transactionId: 'a2f01a1982ed38f7dea3690358f54441e9e01be330de3caef5e8280efc88f2e3',
        globalSequence: '42', nativeKind: 'wire.sysio.onblock.v1',
        rawHex: 'e6c1c3060000000000eab0c700000020e9099dd5340b7533da31d92e988303b76869a085633d1fec0a6177e60000000000000000000000000000000000000000000000000000000000000000faeeae338f8bcd5cff016c9f2a10b53c29047d350a30d5dde96d619f21ecedfd2000000001000000',
        expectedValue: {header: {timestamp: rpc.timestamp, producer: rpc.producer, previous: rpc.previous,
            transaction_mroot: rpc.transaction_mroot, finality_mroot: rpc.finality_mroot,
            qc_claim: {block_num: 32, is_strong_qc: 1}, new_finalizer_policy_diff: null, new_proposer_policy_diff: null, header_extensions: []}}};
    assert.deepEqual(rpc.qc_claim, {block_num: 32, is_strong_qc: true});
    const source34 = codec.decode('result', Buffer.from(frames[33].frameHex, 'hex'))[1];
    const transaction34 = codec.decode('transaction_trace[]', Buffer.from(source34.traces, 'hex'))[0][1];
    const action34 = transaction34.action_traces[0][1];
    assert.equal(transaction34.id, expected34.transactionId); assert.equal(action34.act.data, expected34.rawHex);
    assert.equal(action34.receipt[1].global_sequence, expected34.globalSequence);
    expected.set(34, expected34);
    return {schemaJson, chainId: receipt.chainId, profileId, codec, frames, positions, expected, sourcePayloadUnchanged: true,
        sourceArchiveSha256: result.archiveSha256, planSha256: result.planSha256,
        statusHex: Buffer.from(codec.encode('result', ['get_status_result_v0', {head: codec.decode('result', Buffer.from(frames[33].frameHex, 'hex'))[1].head,
            last_irreversible: {block_num: 0, block_id: '0'.repeat(64)}, trace_begin_block: 1, trace_end_block: 1481,
            chain_state_begin_block: 1, chain_state_end_block: 1481, chain_id: receipt.chainId}])).toString('hex')};
}
