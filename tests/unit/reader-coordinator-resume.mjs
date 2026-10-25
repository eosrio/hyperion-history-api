/** Minimized original reader resume/publication callbacks; coordinator and broker transport controls only. */
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

const mode = process.argv[2];
assert(['reversible', 'abi-behind', 'anchor', 'current-confirm', 'retired-socket', 'retired-context', 'retired-checkpoint'].includes(mode));
const directory = mkdtempSync(join(tmpdir(), 'hyperion-reader-resume-'));
const originalDirectory = process.cwd(), originalConfig = process.env.CONFIG_JSON, originalSend = process.send;
try {
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'reader-resume'}, indexer: {}}));
    writeFileSync(join(directory, 'config/connections.json'), '{}');
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
    process.send = () => true;
    const [{default: Reader}, {LiveReaderCheckpoint}] = await Promise.all([
        import('../../build/indexer/workers/state-reader.js'), import('../../build/indexer/helpers/reader-progress.js')]);
    const commands = [], payloads = [];
    const checkpoint = new LiveReaderCheckpoint(mode === 'anchor' || mode === 'abi-behind' ? 34 : 1,
        mode === 'anchor' || mode === 'abi-behind' ? 'thirty-three' : '', 256);
    if (mode === 'reversible') for (let number = 1; number <= 33; number++)
        assert.equal(checkpoint.observe({num: number, id: String(number), previous: String(number - 1)}, 0)(), undefined);
    const reader = Object.assign(Object.create(Reader.prototype), {chain: 'reader-resume',
        conf: {settings: {reader_recovery_window_blocks: 256}, indexer: {}},
        protocol: {profileId: 'wire-sysio-6508c9e8-native-engineering-v1'},
        sourceContext: {id: 'controlled-context', readerSessionId: 'new-reader', generation: 1},
        verifiedReaderSessionId: 'new-reader', physicalIngressGeneration: 1, activeIngressGeneration: 1, socketGeneration: 1,
        isLiveReader: true, liveCheckpoint: checkpoint, baseRequest: {}, shipRev: 'v0', ship: {connected: true},
        coordinatorRpc: {open: async () => ({generation: 'controlled-generation', resumeFromBlock: mode === 'abi-behind' ? 11 : 34})},
        profiler: {start: () => () => {}}, send(request) {commands.push(structuredClone(request));},
        reversibleBlockMap: new Map(), forkedBlocks: new Map(), local_lib: 1,
        stageOneDistQueue: {async push(payload) {payloads.push(payload);}}});
    if (['reversible', 'abi-behind', 'anchor'].includes(mode)) {
        await reader.openCoordinatorSource();
        reader.requestBlocks(34);
        const expectedStart = mode === 'reversible' ? 1 : mode === 'abi-behind' ? 11 : 34;
        assert.equal(commands[0][1].start_block_num, expectedStart, 'ABI coverage must not skip confirmed-publication recovery');
        assert.notEqual(reader.liveCheckpoint, checkpoint, 'A reopened source needs its own publication epoch');
        if (mode === 'reversible') {
            assert.equal(reader.liveCheckpoint.observe({num: 33, id: '33', previous: '32'}, 0)(), undefined);
            assert(reader.liveCheckpoint.hasCurrentReversible({num: 33, id: '33', previous: '32'}));
        } else if (mode === 'anchor') {
            const wrong = reader.liveCheckpoint.observe({num: 34, id: 'thirty-four', previous: 'wrong'}, 34);
            assert.throws(wrong, /Unlinked live block/);
        }
    } else {
        const frame = {this_block: {block_num: 1, block_id: 'one'}, prev_block: {block_num: 0, block_id: ''},
            last_irreversible: {block_num: 1, block_id: 'one'}, block: '00', traces: '00', deltas: '00'};
        // Only publication ownership is under test here; source binding is covered by the full native fixture.
        reader.bindProtocolSource = async () => ({});
        assert.equal(await reader.handleBlockResult(frame, Buffer.from('controlled-frame')), 1);
        assert.equal(payloads.length, 1);
        if (mode === 'retired-socket') reader.physicalIngressGeneration++;
        if (mode === 'retired-context') reader.sourceContext = {...reader.sourceContext, readerSessionId: 'replacement-reader'};
        if (mode === 'retired-checkpoint') reader.liveCheckpoint = new LiveReaderCheckpoint(1, '', 256);
        const position = payloads[0].confirmLive();
        assert.deepEqual(position, mode === 'current-confirm' ? {nextBlock: 2, blockId: 'one'} : undefined,
            'Retired publication callbacks must not advance a replacement source');
    }
    console.log(JSON.stringify({passed: true, mode, originalReaderMethods: true, controlledCoordinatorAndPublicationTransport: true,
        capacityAuthority: false, releaseQualified: false}));
} finally {
    process.send = originalSend; process.chdir(originalDirectory);
    if (originalConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = originalConfig;
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, {recursive: true, force: true});
}
