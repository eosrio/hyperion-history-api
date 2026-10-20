import assert from 'node:assert/strict';
import {BlockTimestamp} from '@wharfkit/antelope';
import {auditFixture, decodeBlock, decodeExact, digest} from './contract-fixture.ts';

export const retainedRpcLimits = Object.freeze({requestBytes: 4096, responseBytes: 4096, requests: 128});

/** A bounded control-plane view, not a captured RPC reply or a source of application events. */
export function createRetainedReplayRpc(fixture: Awaited<ReturnType<typeof auditFixture>>) {
    const tip = fixture.records.at(-1); assert.ok(tip, 'retained fixture has no captured tip');
    assert.equal(tip.blockNum, fixture.manifest.range.end);
    const decoded = decodeBlock(tip.frame, fixture.abi); assert.equal(decoded.id, tip.id);
    const status: any = decodeExact(fixture.files.get('status.bin')!, 'result', fixture.abi);
    assert.equal(status[0], 'get_status_result_v0');
    assert.equal(status[1].chain_id.toString(), fixture.manifest.chainId);
    assert.ok(Number(status[1].last_irreversible.block_num) >= tip.blockNum, 'captured tip is not irreversible');
    const info = Object.freeze({server_version: '00000000', server_version_string: 'hyperion-retained-fixture-v1',
        chain_id: fixture.manifest.chainId, head_block_num: tip.blockNum, last_irreversible_block_num: tip.blockNum,
        head_block_id: tip.id, last_irreversible_block_id: tip.id,
        head_block_time: BlockTimestamp.fromInteger(decoded.header.timeSlot).toString(),
        head_block_producer: decoded.header.producer.toString(), virtual_block_cpu_limit: '0',
        virtual_block_net_limit: '0', block_cpu_limit: '0', block_net_limit: '0'});
    const bytes = Buffer.from(JSON.stringify(info)); assert.ok(bytes.length <= retainedRpcLimits.responseBytes);
    const lineage = Object.freeze({kind: 'derived-audited-capture-view', chainId: fixture.manifest.chainId,
        manifestSha256: digest(fixture.manifestBytes), statusSha256: digest(fixture.files.get('status.bin')!),
        tipFrameSha256: digest(tip.frame), tipBlockNum: tip.blockNum, tipBlockId: tip.id,
        responseSha256: digest(bytes), responseBytes: bytes.length,
        syntheticFields: Object.freeze(['server_version', 'server_version_string', 'virtual_block_cpu_limit',
            'virtual_block_net_limit', 'block_cpu_limit', 'block_net_limit']),
        limits: 'Head and LIB describe the audited irreversible prefix; version/capacity sentinels are fixture metadata, not observed node values.'});
    return {lineage, reply(method: string | undefined, path: string | undefined, body: unknown) {
        assert.ok(method === 'GET' || method === 'POST', 'unsupported retained RPC method');
        assert.equal(path, '/v1/chain/get_info', 'unsupported retained RPC path');
        assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0,
            'retained get_info requires an empty body');
        // Return a detached response; a caller cannot mutate the retained fixture view.
        return JSON.parse(bytes.toString());
    }};
}
