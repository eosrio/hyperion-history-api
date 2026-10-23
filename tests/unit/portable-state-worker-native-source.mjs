/** Original-source preflight only. No Docker, database, socket, provider injection or source edit. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditPortableWorkerSource} from '../../scripts/qualification/portable-state-worker-source.ts';
import {portableSourceRpcIdentity} from '../../scripts/qualification/portable-state-worker.ts';
import {portableWorkerAbiAvailability, assertPortableWorkerOracle} from '../../scripts/qualification/portable-state-worker-oracle.ts';
import {auditPortableNativeOracle, createPortableNativeQualification, portableNativeProfile} from '../../scripts/qualification/portable-state-worker-native.ts';
assert.match(process.versions.node, /^(22|24)\./);
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'hapi270-native-source-'));
try {
    const extracted = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
        [join(root, 'tests/fixtures/portable-state-worker/prepare.py'), join(directory, 'capture')], {encoding: 'utf8', timeout: 20000});
    assert.equal(extracted.status, 0, extracted.stderr); const metadata = JSON.parse(extracted.stdout);
    assert.equal(metadata.selectedBlocks, 1480); assert.equal(metadata.files, 1488);
    const plan = JSON.parse(readFileSync(metadata.plan)), source = await auditPortableWorkerSource(plan.source, portableNativeProfile);
    assert.equal(source.records[0].previousBlockId, null); assert.equal(source.records[0].headerPreviousBlockId, '0'.repeat(64));
    for (const block of source.records.slice(1)) assert.equal(block.headerPreviousBlockId, block.previousBlockId);
    assert.equal(source.irreversibleAnchors['196419'],
        '0002ff43f4faf9ca1db4a2d756b1566ebd1fdba0bb7229fe1e32494613042c22');
    assert.equal(portableSourceRpcIdentity(source, 1), source.records[0].blockId);
    assert.equal(portableSourceRpcIdentity(source, 196419), source.irreversibleAnchors['196419']);
    assert.equal(portableSourceRpcIdentity(source, 999999), undefined);
    const rowOracle = plan.oracleFiles.map(item => JSON.parse(readFileSync(item.path))).find(item => item.sourceAbi && Array.isArray(item.rows));
    assertPortableWorkerOracle(source, plan, rowOracle);
    const stateAbiAvailability = portableWorkerAbiAvailability(plan, rowOracle); assert.equal(stateAbiAvailability.fromBlock, 222);
    const oracle = await auditPortableNativeOracle(source);
    const forbidden = async () => {throw new Error('Source preflight attempted a service call');};
    const qualification = await createPortableNativeQualification({source, oracle, client: {}, chain: 'hyp-p191-123456abcdef',
        apiPort: 43210, events: forbidden, http: forbidden, unrelated: forbidden, wait: forbidden, bulk: {directory, receipts: []}});
    assert.equal(qualification.originalNotifications.length, 25);
    assert.equal(new Set(qualification.originalNotifications.map(value => value.blockNum)).size, 17);
    assert(qualification.originalNotifications.every(value => value.decision.kind === 'contract'
        && value.occurrence.input.inputActionOrdinal === value.origin.actionOrdinal));
    console.log(JSON.stringify({status: 'passed', node: process.version, chainId: source.chainId, profileId: source.profileId,
        retainedFrames: source.records.length, nativeOracleBlocks: oracle.rows.map(value => value.blockNum), stateAbiAvailability,
        notificationOccurrences: qualification.originalNotifications.length, notificationBlocks: 17,
        normalInstalledSelection: true, serviceExecution: false, sourceEdited: false, inputHashes: source.inputHashes,
        officialOracleHashes: oracle.hashes}));
} finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert(basename(directory).startsWith('hapi270-native-source-'));
    rmSync(directory, {recursive: true, force: true});
}
