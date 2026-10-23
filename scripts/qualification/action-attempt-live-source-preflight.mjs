/** Bounded read-only SHIP/RPC authority preflight for #288.
 * This verifies a current source endpoint, not worker, broker, or fork recovery.
 * Usage: node action-attempt-live-source-preflight.mjs SHIP_URL RPC_URL CHAIN_ID PROFILE_ID
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';
import {createWireShipCodec, resolveCodecProfile} from '@eosrio/hyperion-wire-plugin';

const hex64 = /^[0-9a-f]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function rpc(rpcUrl, path, body) {
    const response = await fetch(new URL(path, rpcUrl), {method: 'POST',
        headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000)});
    assert.equal(response.status, 200, `${path} returned HTTP ${response.status}`);
    assert.ok(response.body);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
        bytes += chunk.length; assert.ok(bytes <= 2 * 1024 * 1024, `${path} exceeded the response bound`);
        chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString());
}

function currentShipStatus(shipUrl, profile) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(shipUrl, {handshakeTimeout: 8000, maxPayload: 128 * 1024,
            perMessageDeflate: false});
        let codec, schemaSha256, finished = false;
        const timer = setTimeout(() => finish(new Error('SHIP status deadline exceeded')), 12000);
        const finish = (error, result) => {
            if (finished) return;
            finished = true; clearTimeout(timer); socket.terminate();
            if (error) reject(error); else resolve(result);
        };
        socket.on('error', error => finish(error));
        socket.on('close', () => finish(new Error('SHIP closed before status')));
        socket.on('message', (data, binary) => {
            try {
                const bytes = Buffer.from(data);
                if (!codec) {
                    assert.equal(binary, false, 'SHIP schema must be a text frame');
                    assert.ok(bytes.length > 0 && bytes.length <= 64 * 1024);
                    schemaSha256 = hash(bytes);
                    codec = createWireShipCodec(JSON.parse(bytes.toString()), profile);
                    socket.send(codec.encodeRequest(['get_status_request_v0', {}]), {binary: true});
                    return;
                }
                assert.equal(binary, true, 'SHIP status must be binary');
                const [type, value] = codec.decodeResult(bytes);
                assert.match(type, /^get_status_result_v[01]$/);
                finish(null, {type, value, schemaSha256, statusSha256: hash(bytes)});
            } catch (error) {finish(error);}
        });
    });
}

export async function preflight(shipUrl, rpcUrl, expectedChainId, profileId) {
    assert.ok(['ws:', 'wss:'].includes(new URL(shipUrl).protocol));
    assert.ok(['http:', 'https:'].includes(new URL(rpcUrl).protocol));
    assert.match(expectedChainId, hex64);
    const profile = resolveCodecProfile(profileId);
    const infoBefore = await rpc(rpcUrl, '/v1/chain/get_info', {});
    assert.equal(infoBefore.chain_id, expectedChainId);
    const ship = await currentShipStatus(shipUrl, profile);
    assert.equal(ship.value.chain_id, expectedChainId);
    const lib = ship.value.last_irreversible;
    assert.ok(Number.isSafeInteger(Number(lib.block_num)) && Number(lib.block_num) >= 1);
    assert.match(lib.block_id, hex64);
    assert.ok(Number(ship.value.head.block_num) >= Number(lib.block_num), 'SHIP head is below LIB');
    const block = await rpc(rpcUrl, '/v1/chain/get_block', {block_num_or_id: Number(lib.block_num)});
    assert.equal(Number(block.block_num), Number(lib.block_num));
    assert.equal(block.id, lib.block_id, 'RPC and SHIP LIB anchors differ');
    const infoAfter = await rpc(rpcUrl, '/v1/chain/get_info', {});
    assert.equal(infoAfter.chain_id, expectedChainId);
    assert.ok(Number(infoAfter.last_irreversible_block_num) >= Number(lib.block_num),
        'RPC LIB regressed below the SHIP anchor');
    return {schemaVersion: 1, purpose: 'read-only current source preflight',
        releaseQualified: false, workerQualified: false, brokerQualified: false,
        observedAt: new Date().toISOString(), nodeVersion: process.version, chainId: expectedChainId,
        profileId: profile.id, sourceRevision: profile.upstreamRevision,
        shipStatusType: ship.type, schemaSha256: ship.schemaSha256,
        statusSha256: ship.statusSha256, shipHead: ship.value.head,
        shipLib: lib, rpcHeadBefore: {blockNum: infoBefore.head_block_num, blockId: infoBefore.head_block_id},
        rpcLibAfter: {blockNum: infoAfter.last_irreversible_block_num,
            blockId: infoAfter.last_irreversible_block_id}, rpcAnchor: {blockNum: Number(lib.block_num), blockId: block.id}};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert.equal(process.argv.length, 6,
        'usage: node action-attempt-live-source-preflight.mjs SHIP_URL RPC_URL CHAIN_ID PROFILE_ID');
    try {console.log(JSON.stringify(await preflight(...process.argv.slice(2))));}
    catch (error) {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;}
}
