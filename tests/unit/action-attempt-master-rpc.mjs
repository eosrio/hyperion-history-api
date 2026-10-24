/** Actual master authority callback with an unchanged source-pinned Wire RPC response. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {APIClient, Checksum256, UInt32} from '@wharfkit/antelope';
import {HyperionMaster} from '../../build/indexer/modules/master.js';
import {WorkerAttemptSupervisor} from '../../build/indexer/protocol/worker-attempt-supervisor.js';

const bytes = readFileSync(new URL('../fixtures/wire-rpc-block-33.json', import.meta.url));
assert.equal(bytes.length, 1031);
assert.equal(createHash('sha256').update(bytes).digest('hex'), '2fbe2a135ad825e5105843dfc0c31bbd8017c15e6b1d2ca9c973be90fd7ecc95');
const original = JSON.parse(bytes.toString());
assert.equal(original.confirmed, undefined, 'the original Wire block is not an Antelope SignedBlock');
const chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d';
let reply = structuredClone(original), status = 200, requests = [], head = 33, lib = 33;
const rpc = new APIClient({provider: {async call(args) {
    requests.push(args); assert.equal(args.path, '/v1/chain/get_block');
    return {status, headers: {}, text: JSON.stringify(reply), json: structuredClone(reply)};
}}});
rpc.v1.chain.get_info = async () => ({head_block_num: UInt32.from(head), last_irreversible_block_num: UInt32.from(lib),
    chain_id: Checksum256.from(chainId)});
const owner = {}, master = Object.assign(Object.create(HyperionMaster.prototype), {rpc,
    chain: 'rpc-identity-fixture', esClient: {}, conf: {settings: {es_replicas: 0}, indexer: {live_reader: true}},
    liveReader: {wref: owner}, actionCanonicalLib: {worker: owner, blockNum: 33, blockId: original.id}});
const supervisor = new WorkerAttemptSupervisor();
const authority = master.attemptAdjudicatorFor(supervisor).current;
try {
    assert.deepEqual(await authority.canonicalBlock(33), {chainId, blockId: original.id,
        previousBlockId: original.previous, irreversible: true});
    assert.equal(requests.length, 2, 'both the physical live-reader LIB and requested block must be checked');
    assert.ok(requests.every(request => request.params.block_num_or_id === 33 && request.responseType === undefined));
    for (const patch of [{block_num: 34}, {block_num: '33'}, {id: 'bad'}, {previous: 'bad'}, {id: null}]) {
        reply = {...original, ...patch}; await assert.rejects(authority.canonicalBlock(33), /block identity/);
    }
    reply = {...original, id: 'f'.repeat(64)};
    await assert.rejects(authority.canonicalBlock(33), /branches differ/);
    reply = {...original, id: original.id.toUpperCase(), previous: original.previous.toUpperCase()};
    assert.deepEqual(await authority.canonicalBlock(33), {chainId, blockId: original.id,
        previousBlockId: original.previous, irreversible: true});
    reply = structuredClone(original);
    master.actionCanonicalLib = undefined; requests = [];
    await assert.rejects(authority.canonicalBlock(33), /anchor is unavailable/); assert.equal(requests.length, 0);
    master.actionCanonicalLib = {worker: {}, blockNum: 33, blockId: original.id};
    await assert.rejects(authority.canonicalBlock(33), /anchor is unavailable/); assert.equal(requests.length, 0);
    master.actionCanonicalLib = {worker: owner, blockNum: 32, blockId: original.previous};
    await assert.rejects(authority.canonicalBlock(33), /anchor is unavailable/);
    master.actionCanonicalLib = {worker: owner, blockNum: 33, blockId: original.id};
    head = 32;
    await assert.rejects(authority.canonicalBlock(33), /node is behind/);
    head = 33; lib = 32; requests = [];
    assert.deepEqual(await authority.canonicalBlock(33), {chainId, blockId: original.id,
        previousBlockId: original.previous, irreversible: false});
    assert.equal(requests.length, 1, 'reversible observations remain subject to the separate selection/fork checks');
    head = 1; lib = 1; reply = {...original, block_num: 1, id: '00000001' + 'a'.repeat(56), previous: '0'.repeat(64)};
    master.actionCanonicalLib = {worker: owner, blockNum: 1, blockId: reply.id};
    assert.deepEqual(await authority.canonicalBlock(1), {chainId, blockId: reply.id, previousBlockId: null, irreversible: true});
    requests = [];
    for (const invalid of [0, -1, NaN, 0x100000000])
        await assert.rejects(master.readCanonicalRpcBlock(invalid), /block number/);
    assert.equal(requests.length, 0);
    head = 33; master.actionCanonicalLib = {worker: owner, blockNum: 33, blockId: original.id};
    lib = 33; status = 503; reply = {error: {what: 'fixture RPC unavailable'}};
    await assert.rejects(authority.canonicalBlock(33));
    console.log(JSON.stringify({passed: true, native: process.version, originalWireBytes: bytes.length,
        actualMasterCallback: true, fullBlockDecoded: false, physicalLibAnchorPreserved: true,
        liveQualification: false}));
} finally {supervisor.stop();}
