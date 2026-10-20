/** Offline native-Node check of the installed corpus and bounded replay request path. */
import assert from 'node:assert/strict';
import {createWireShipCodec, resolveCodecProfile} from '@eosrio/hyperion-wire-plugin';
import {auditWireReplayFixture, createWireReplaySession, createWireReplayRpc} from './wire-replay-fixture.ts';
import {readWireComponentSources} from './wire-worker-replay.ts';

assert.ok(/^(22|24)\./.test(process.versions.node) && !process.versions.bun);
const fixture = await auditWireReplayFixture();
const artifacts = await readWireComponentSources(fixture.packageRoot, fixture.lineage.components);
const records = fixture.records;
const originalFirst = Buffer.from(records[0].frame);
records[0].frame.fill(0);
assert.deepEqual(fixture.records[0].frame, originalFirst, 'public frame mutation reached the audited snapshot');
const expectedRecords = fixture.records;
const codec = createWireShipCodec(fixture.schema, resolveCodecProfile(fixture.profileId));
const session = createWireReplaySession(fixture);
const status = session.receive(codec.encodeRequest(['get_status_request_v0', {}]));
assert.equal(status.status, true);
assert.deepEqual(status.messages, [fixture.read('evidence/capture-application-2-120-final/status.bin')]);
let next = 0;
const inspect = result => {
    for (const [index, message] of result.messages.entries()) {
        const expected = expectedRecords[next++];
        assert.equal(result.blocks[index], expected.blockNum);
        assert.deepEqual(message, expected.frame, 'replay changed an original result frame');
    }
};
inspect(session.receive(codec.encodeRequest(['get_blocks_request_v0', {
    start_block_num: 2, end_block_num: 0xffffffff, max_messages_in_flight: 8,
    have_positions: [], irreversible_only: false, fetch_block: true, fetch_traces: true, fetch_deltas: true,
}])));
while (session.flow.inFlight) {
    inspect(session.receive(codec.encodeRequest(['get_blocks_ack_request_v0', {num_messages: session.flow.inFlight}])));
}
assert.equal(next, 119);
assert.deepEqual(session.flow.sentBlocks, Array.from({length: 119}, (_, index) => index + 2));
assert.deepEqual(session.flow.acknowledgedBlocks, session.flow.sentBlocks);
assert.equal(session.flow.idle, true);
const rpc = createWireReplayRpc(fixture);
const firstReply = rpc.reply('POST', '/v1/chain/get_info', {});
firstReply.head_block_num = 999;
assert.equal(rpc.reply('POST', '/v1/chain/get_info', {}).head_block_num, 2);
assert.throws(() => rpc.reply('POST', '/v1/chain/get_abi', {account_name: 'wiremap'}));
console.log(JSON.stringify({status: 'passed-offline-source-and-credit-check', node: process.version,
    packageRevision: fixture.packageRevision, blocks: next, acknowledgedBlocks: session.flow.acknowledgedBlocks.length,
    physicalRows: fixture.audit.physicalDeltaRows, sourceActionReceipts: fixture.audit.actionReceiptCount,
    selectedComponents: fixture.lineage.components, verifiedComponentFiles: artifacts.size,
    originalStatus: fixture.originalStatus, startupBlock: 2,
    fullWorkerAcceptance: false, sourceAuthority: false, selectedTestnetAcceptance: false}));
