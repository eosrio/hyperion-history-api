import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const previousDirectory = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'hyperion-source-probe-'));
try {
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'source-probe'}, indexer: {}}));
    writeFileSync(join(directory, 'config', 'connections.json'), '{}');
    process.chdir(directory);
    process.env.CONFIG_JSON = join(directory, 'chain.json');
    const [{default: StateReader}, {LiveReaderCheckpoint}, {HyperionMaster}] = await Promise.all([
        import('../../build/indexer/workers/state-reader.js'),
        import('../../build/indexer/helpers/reader-progress.js'),
        import('../../build/indexer/modules/master.js')]);
    const reader = Object.create(StateReader.prototype);
    const chainId = '1'.repeat(64), old = 'a'.repeat(64), replacement = 'b'.repeat(64), parent = '9'.repeat(64);
    const position = blockId => ({chainId, blockNum: 10, blockId, previousBlockId: parent});
    const checkpoint = new LiveReaderCheckpoint(10, parent);
    checkpoint.observe({num: 10, id: old, previous: parent}, 9);
    const queued = [], replies = [], originalSend = process.send;
    Object.assign(reader, {chainId, protocol: {profileId: 'wire-fixture'}, isLiveReader: true,
        physicalIngressGeneration: 1, verifiedReaderSessionId: 'live-session',
        coordinatorSource: {readerSessionId: 'live-session', generation: 'generation-1'},
        liveCheckpoint: checkpoint, publications: new Map(), socketGeneration: 0,
        sourceProbes: new Set(),
        blockReadingQueue: {push: async item => {queued.push(item);}},
        shipCreditOwner: () => ({}), returnShipCredits() {},
        onMessage: async () => {reader.liveCheckpoint.observe({num: 10, id: replacement, previous: parent}, 9); return 'block';}});
    process.send = reply => {replies.push(reply); return true;};
    const request = (requestId, source = position(old)) => reader.onIpcMessage({event: 'protocol_source_probe_request',
        data: {requestId, readerSessionId: 'live-session', generation: 'generation-1', source}});
    try {
        request('before-fork');
        await reader.processIncomingBlocks([{kind: 'frame', generation: 1, data: Buffer.from('replacement-fork')}, ...queued.splice(0)]);
        assert.equal(replies.at(-1).event, 'protocol_source_probe_reply');
        assert.deepEqual(replies.at(-1).data, {requestId: 'before-fork', readerSessionId: 'live-session',
            generation: 'generation-1', current: false});
        request('new-branch', position(replacement));
        await reader.processIncomingBlocks(queued.splice(0));
        assert.equal(replies.at(-1).data.current, true);
        reader.physicalIngressGeneration = 2;
        request('old-socket', position(replacement));
        const pending = queued.splice(0);
        reader.physicalIngressGeneration = 3;
        await reader.processIncomingBlocks(pending);
        assert.equal(replies.at(-1).data.current, false);
        reader.sourceProbes = new Set(Array.from({length: 32}, (_, index) => `held-${index}`));
        const queuedBeforeLimit = queued.length;
        request('queue-limited', position(replacement));
        assert.equal(queued.length, queuedBeforeLimit);
        assert.equal(replies.at(-1).data.current, false);
        reader.sourceProbes.clear();
        const master = Object.create(HyperionMaster.prototype);
        master.protocolSourceProbes = new Map();
        master.initHandlerMap();
        const worker = {send(message, callback) {reader.onIpcMessage(message); callback?.(null);}};
        reader.physicalIngressGeneration = 1;
        process.send = reply => {master.handleMessage(worker, reply); return true;};
        const currentProbe = master.probePhysicalReversibleSource(worker, 'live-session', 'generation-1', position(replacement));
        await reader.processIncomingBlocks(queued.splice(0));
        assert.equal(await currentProbe, true);
        const prior = new LiveReaderCheckpoint(10, parent);
        prior.observe({num: 10, id: old, previous: parent}, 9);
        reader.liveCheckpoint = prior;
        const staleProbe = master.probePhysicalReversibleSource(worker, 'live-session', 'generation-1', position(old));
        await reader.processIncomingBlocks([{kind: 'frame', generation: 1, data: Buffer.from('replacement-fork')}, ...queued.splice(0)]);
        assert.equal(await staleProbe, false);
        assert.equal(master.protocolSourceProbes.size, 0);
    } finally {process.send = originalSend;}
    process.stdout.write('physical fork probe passed\n');
} finally {
    process.chdir(previousDirectory);
    rmSync(directory, {recursive: true, force: true});
}
