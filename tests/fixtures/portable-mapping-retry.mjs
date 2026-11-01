/** Original retained Wire frames and official ABI/row oracle; source ports remain controlled. */
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {loadChainProtocol} from '../../build/indexer/protocol/selection.js';
import {protocolDeployment} from '../../build/indexer/protocol/deployments.js';
import {createWireShipCodec, resolveCodecProfile} from '@eosrio/hyperion-wire-plugin';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const gate = () => {let release; const promise = new Promise(done => {release = done;}); return {promise, release};};
export const until = async (predicate, diagnostic = () => '') => {
    const end = performance.now() + 10000;
    while (!predicate()) {assert.ok(performance.now() < end, 'controlled callback must reach its asserted boundary: ' + diagnostic()); await delay(1);}
};

export async function originalWireRows() {
    const root = fileURLToPath(new URL('../../', import.meta.url)), fixture = join(root, 'tests/fixtures/portable-state-worker');
    const manifest = JSON.parse(readFileSync(join(fixture, 'manifest.json')));
    assert.equal(hash(readFileSync(join(fixture, manifest.archive.file))), '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
    mkdirSync(join(root, 'out'), {recursive: true});
    const parent = realpathSync(join(root, 'out')), owned = mkdtempSync(join(parent, 'contract-failure-rows-'));
    try {
        const prepared = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3',
            [join(fixture, 'prepare.py'), join(owned, 'capture')], {encoding: 'utf8', timeout: 20000, windowsHide: true}));
        assert.equal(prepared.files, 1488);
        const source = join(owned, 'capture/source'), receipt = JSON.parse(readFileSync(join(source, 'receipt.json')));
        const sourceReads = [], profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
        const selected = await loadChainProtocol({provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId});
        assert(selected.components.every(value => value.sourceRevision === '69a66064c077a405341f5aaf15e84b88b8d86ccb'));
        const schemaJson = readFileSync(join(source, 'schema.json'), 'utf8');
        assert.equal(hash(schemaJson), '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9');
        const codec = createWireShipCodec(JSON.parse(schemaJson), resolveCodecProfile(profileId));
        const row = height => {
            const entry = receipt.frames[height - 1], bytes = readFileSync(join(source, entry.file));
            assert.equal(entry.blockNum, height); assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);
            sourceReads.push(height); return {entry, bytes, bundle: codec.decodeBundle(bytes)};
        };
        const oracle = JSON.parse(readFileSync(join(source, 'official-oracle.json'))), pinned = oracle.sourceAbi;
        assert.equal(oracle.success, true); assert.equal(oracle.abiJsonHashVerified, true);
        assert.match(oracle.clioSha256, /^[0-9a-f]{64}$/);
        const deployment = row(pinned.blockNum);
        assert.equal(deployment.entry.blockId, pinned.blockId); assert.equal(hash(Buffer.from(pinned.abiHex, 'hex')), pinned.abiSha256);
        assert.equal(deployment.bundle.deltaRows.filter(value => value.stream === 'account'
            && value.value[1].name === 'sysio.msgch' && value.value[1].abi === pinned.abiHex).length, 1);
        const position = height => ({blockNum: height, blockId: receipt.frames[height - 1].blockId});
        const views = new WeakSet(); let available = 0, revalidations = 0;
        return {chainId: receipt.chainId, sourceReads, position,
            releaseThrough(height) {assert(height >= available && height <= 1480); available = height;},
            async frame(height, definition, admit) {
                assert.ok(height <= available, 'controlled source availability is explicit');
                const {entry, bytes, bundle} = row(height), previous = receipt.frames[height - 2].blockId;
                assert.equal(bundle.envelope[1].this_block.block_id, entry.blockId); assert.equal(bundle.block.previous, previous);
                const selectedDeployment = protocolDeployment(selected.provider, {account: 'sysio.msgch', block: pinned.blockNum,
                    block_id: pinned.blockId, abi_hex: pinned.abiHex, protocol_profile: profileId}, 'sysio.msgch', height, entry.blockId);
                assert.equal(selectedDeployment.id, definition.source.abiDeployment); assert.equal(pinned.abiSha256, definition.source.abiSha256);
                const changes = [];
                for (const [ordinal, value] of bundle.deltaRows.entries()) {
                    const input = {stream: value.stream, present: value.present === true || value.present === 1,
                        raw: Buffer.from(value.rawHex, 'hex'), value: value.value};
                    const context = {chainId: receipt.chainId, blockNum: height, blockId: entry.blockId, ordinal};
                    let normalized = selected.provider.normalizeDelta(input, context);
                    if (normalized.kind === 'abi-required' && normalized.account === definition.source.contract)
                        normalized = selected.provider.normalizeDelta(input, {...context, abiDeployment: selectedDeployment});
                    if (normalized.kind !== 'record' || normalized.metadata.recordKind !== 'row'
                        || normalized.metadata.code !== definition.source.contract || normalized.tableName !== definition.source.table) continue;
                    assert.equal(normalized.source.abiDeployment, selectedDeployment.id);
                    const expected = oracle.rows.filter(row => row.blockNum === height && row.present === input.present
                        && row.physicalSha256 === hash(input.raw));
                    assert.equal(expected.length, 1, 'selected real row must join the retained original clio oracle');
                    assert.equal(selectedDeployment.abi.tables.find(table => table.name === definition.source.table).type, expected[0].type);
                    changes.push({contract: definition.source.contract, table: definition.source.table, scope: '',
                        primaryKey: normalized.identity, abiDeployment: selectedDeployment.id, abiSha256: pinned.abiSha256,
                        present: input.present, ...(input.present ? {value: normalized.value} : {})});
                }
                const block = {blockNum: height, blockId: entry.blockId, previousBlockId: previous}; await admit?.(block);
                const proof = Object.freeze({controlledPortOnly: true}); views.add(proof);
                return {frame: {chainId: receipt.chainId, block, changes}, proof,
                    evidence: {controlledPortOnly: true, originalFrameSha256: hash(bytes), originalAbiSha256: pinned.abiSha256}};
            },
            async revalidate(proof) {assert(views.has(proof)); revalidations++;},
            get revalidations() {return revalidations;},
            async dispose() {assert.equal(dirname(owned), parent); assert(basename(owned).startsWith('contract-failure-rows-'));
                rmSync(owned, {recursive: true, force: true});},
        };
    } catch (error) {
        assert.equal(dirname(owned), parent); assert(basename(owned).startsWith('contract-failure-rows-'));
        rmSync(owned, {recursive: true, force: true}); throw error;
    }
}
