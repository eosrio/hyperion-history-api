import {describe, expect, test} from 'bun:test';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {digest} from '../../scripts/qualification/contract-fixture.ts';
import {assertNewWireReplayOutput, assertWireReaderConfirmations, parseWireWorkerReplayArguments,
    readWireComponentSources, wireBulkPublications, wireReplayAccounts, wireWorkerConfig, wireWorkerEnvironment} from '../../scripts/qualification/wire-worker-replay.ts';
import {wireReplayPins} from '../../scripts/qualification/wire-replay-fixture.ts';

describe('bounded real Wire worker qualification guards', () => {
    async function artifactFixture() {
        const root = await mkdtemp(join(tmpdir(), 'hyp-wire-artifacts-'));
        await mkdir(join(root, 'dist'));
        const packageBytes = Buffer.from('{"name":"@eosrio/hyperion-wire-plugin"}\n');
        await writeFile(join(root, 'package.json'), packageBytes);
        await writeFile(join(root, 'protocol-profile.json'), '{}');
        await writeFile(join(root, 'dist/protocol-provider.json'), '{}');
        await writeFile(join(root, 'dist/provider.js'), 'export const original = true;');
        const selected: {runtime: string; sha256: string}[] = [];
        const manifests: Record<string, any> = {};
        for (const runtime of ['node', 'rust']) {
            const manifest = {schemaVersion: 1, sourceModified: false, sourceRevision: wireReplayPins.packageRevision,
                files: [{path: 'dist/provider.js', sha256: digest('export const original = true;')}]};
            const bytes = Buffer.from(JSON.stringify(manifest)); manifests[runtime] = manifest;
            await writeFile(join(root, `dist/protocol-${runtime}-artifact.json`), bytes);
            selected.push({runtime, sha256: digest(bytes)});
        }
        return {root, selected, manifests, packageBytes};
    }
    async function removeArtifactFixture(root: string) {
        expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
        expect(root.includes('hyp-wire-artifacts-')).toBe(true);
        await rm(root, {recursive: true});
    }
    test('component evidence retains executable members and rejects drift with unchanged package metadata', async () => {
        const fixture = await artifactFixture();
        try {
            const members = await readWireComponentSources(fixture.root, fixture.selected);
            expect(members.get('dist/provider.js')!.toString()).toBe('export const original = true;');
            expect(members.has('dist/protocol-node-artifact.json')).toBe(true);
            expect(members.has('dist/protocol-rust-artifact.json')).toBe(true);
            await writeFile(join(fixture.root, 'dist/provider.js'), 'export const changed = true;');
            expect(await readFile(join(fixture.root, 'package.json'))).toEqual(fixture.packageBytes);
            await expect(readWireComponentSources(fixture.root, fixture.selected)).rejects.toThrow('member changed');
        } finally {await removeArtifactFixture(fixture.root);}
    });
    test('rewritten component manifests cannot replace the selected artifact identity', async () => {
        const fixture = await artifactFixture();
        try {
            const changed = {...fixture.manifests.node, additional: 'changed after selection'};
            await writeFile(join(fixture.root, 'dist/protocol-node-artifact.json'), JSON.stringify(changed));
            await expect(readWireComponentSources(fixture.root, fixture.selected)).rejects.toThrow('manifest changed');
        } finally {await removeArtifactFixture(fixture.root);}
    });
    test('artifact evidence rejects a member outside the selected package', async () => {
        const fixture = await artifactFixture();
        try {
            fixture.manifests.node.files[0].path = '../outside.js';
            const bytes = Buffer.from(JSON.stringify(fixture.manifests.node));
            await writeFile(join(fixture.root, 'dist/protocol-node-artifact.json'), bytes);
            fixture.selected[0].sha256 = digest(bytes);
            await expect(readWireComponentSources(fixture.root, fixture.selected)).rejects.toThrow('member path');
        } finally {await removeArtifactFixture(fixture.root);}
    });
    test('CLI declares only source package, state and fresh output inputs', () => {
        expect(parseWireWorkerReplayArguments(['state.json', 'output'])).toEqual({stateFile: 'state.json', outputDirectory: 'output', packageRoot: undefined});
        expect(parseWireWorkerReplayArguments(['state.json', 'output', '--package-root', 'installed package'])).toEqual({stateFile: 'state.json', outputDirectory: 'output', packageRoot: 'installed package'});
        for (const values of [[], ['state'], ['state', 'out', 'ignored'], ['state', 'out', '--purge', 'yes'],
            ['state', 'out', '--package-root'], ['state', 'out', '--package-root', ''], ['state', ' '], ['--fault', 'out']]) {
            expect(() => parseWireWorkerReplayArguments(values)).toThrow();
        }
    });

    test('actual config uses the live authority path, complete payloads and isolated history tombstones', () => {
        const config = wireWorkerConfig('hyp-wire-012345abcdef');
        expect(config.settings.protocol).toEqual({provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId: 'wire-sysio-7dede884-engineering-v1'});
        expect(config.settings.eosio_alias).toBe('sysio'); expect(config.settings.system_contract).toBe('sysio');
        expect(config.indexer).toMatchObject({start_on: 2, stop_on: 0, live_reader: true, live_only_mode: true,
            fetch_block: true, fetch_traces: true, fetch_deltas: true, process_deltas: true,
            rewrite: false, purge_queues: false, disable_reading: false, disable_indexing: false});
        expect(config.features).toMatchObject({index_deltas: true, index_all_deltas: true, index_deltas_deletions: true,
            contract_state: {enabled: false, contracts: {}}});
        expect(config.whitelists.actions).toEqual(wireReplayAccounts.map(account => account + '::*'));
        expect(config.whitelists.actions).toHaveLength(7); expect(config.whitelists.deltas).toEqual([]);
        expect(JSON.stringify(config)).not.toContain('actionSourceAdmission');
        for (const chain of ['production', 'hyp-wire-ABCDEF012345', 'hyp-wire-012345abcdef-*', 'hyp-wire-012345abcde']) expect(() => wireWorkerConfig(chain)).toThrow();
    });

    test('inherited admission/fault preloads and worker roles cannot silently change the real launcher', () => {
        const input = {PATH: 'preserved', NODE_OPTIONS: '--import action-source-admission-preload.mjs', NODE_PATH: 'another-dependency-tree',
            ES198_ACTION_CRASH_CONTROL: 'fault.json', ES198_OBSERVER_DIR: '/other', ES198_CPU_PROFILE: '1',
            worker_role: 'ds_pool_worker', worker_id: '86', first_block: '500', live_mode: 'true', CONFIG_JSON: '/production', CHAIN_NAME: 'production'};
        const before = {...input}; const result = wireWorkerEnvironment(input, resolve('fresh'), resolve('fresh/config.json'), 'hyp-wire-012345abcdef');
        expect(input).toEqual(before); expect(result.PATH).toBe('preserved'); expect(result.NODE_OPTIONS).toBe('');
        for (const key of ['NODE_PATH', 'ES198_ACTION_CRASH_CONTROL', 'worker_role', 'worker_id', 'first_block', 'live_mode']) expect(result[key]).toBeUndefined();
        expect(result.CONFIG_JSON).toBe(resolve('fresh/config.json')); expect(result.ES198_OBSERVER_DIR).toBe(join(resolve('fresh'), 'observer'));
        expect(result.ES198_CPU_PROFILE).toBe('0');
    });

    const interval = [{blockNum: 2}, {blockNum: 3}, {blockNum: 4}];
    const confirmations = () => ['ipc_send', 'ipc_receive'].flatMap((kind, lane) => interval.map(record => ({kind,
        pid: lane + 100, event: 'read_block', role: 'continuous_reader', message: {block_num: record.blockNum, live: true}})));
    test('completion requires both reader-published and master-observed confirmations in original order', () => {
        expect(assertWireReaderConfirmations(confirmations(), interval)).toMatchObject({blocks: 3, first: 2, last: 4});
    });
    test('missing, duplicate, reordered, substituted and mixed-worker confirmations fail', () => {
        const variants = [
            (rows: any[]) => rows.pop(),
            (rows: any[]) => rows.push({...rows[0]}),
            (rows: any[]) => [rows[0], rows[1]] = [rows[1], rows[0]],
            (rows: any[]) => rows[0].message.live = false,
            (rows: any[]) => rows[0].message.block_num = 5,
            (rows: any[]) => rows[0].pid = 200,
            (rows: any[]) => rows[0].role = 'reader',
        ];
        for (const mutate of variants) {const rows = confirmations(); mutate(rows); expect(() => assertWireReaderConfirmations(rows, interval)).toThrow();}
        expect(() => assertWireReaderConfirmations(confirmations(), [{blockNum: 2}, {blockNum: 4}])).toThrow();
        expect(() => assertWireReaderConfirmations([], [])).toThrow();
    });

    function publication() {
        const source = {global_sequence: '141', act: {data: {id: '18446744073709551615', amount: '9007199254740993'}}};
        const bytes = Buffer.from(JSON.stringify({index: {_index: 'hyp-wire-test-action-v1', _id: 'root141'}}) + '\n' + JSON.stringify(source) + '\n');
        const receipt = {number: 1, path: '/_bulk', request: {bytes: bytes.length, sha256: digest(bytes)},
            operations: [{operation: 'index', index: 'hyp-wire-test-action-v1', id: 'root141'}], response: {items: [{index: {status: 201}}]}};
        return {bytes, receipt, source};
    }
    test('raw publication evidence keeps exact application integers and every attempted publication', () => {
        const {bytes, receipt, source} = publication();
        const result = wireBulkPublications(receipt, bytes);
        expect(result).toEqual([{operation: 'index', index: 'hyp-wire-test-action-v1', id: 'root141', source, receiptNumber: 1, itemStatus: 201}]);
        expect([...result, ...wireBulkPublications({...receipt, number: 2}, bytes)]).toHaveLength(2);
    });
    test('content changes, extra sources and ID mismatches cannot become output evidence', () => {
        const {bytes, receipt} = publication(); expect(() => wireBulkPublications(receipt, Buffer.from(bytes.toString().replace('9007199254740993', '9007199254740992')))).toThrow();
        const extra = Buffer.concat([bytes, Buffer.from('{}\n')]);
        expect(() => wireBulkPublications({...receipt, request: {bytes: extra.length, sha256: digest(extra)}}, extra)).toThrow();
        expect(() => wireBulkPublications({...receipt, operations: [{...receipt.operations[0], id: 'different'}]}, bytes)).toThrow();
        const truncated = bytes.subarray(0, bytes.length - 1);
        expect(() => wireBulkPublications({...receipt, request: {bytes: truncated.length, sha256: digest(truncated)}}, truncated)).toThrow();
    });
    test('delete attempts retain their operation and failed item status without invented source', () => {
        const bytes = Buffer.from('{"delete":{"_id":"removed","_index":"owned-delta"}}\n');
        expect(wireBulkPublications({number: 5, path: '/_bulk', request: {bytes: bytes.length, sha256: digest(bytes)},
            operations: [{operation: 'delete', index: 'owned-delta', id: 'removed'}], response: {items: [{delete: {status: 409, error: {type: 'conflict'}}}]}}, bytes))
            .toEqual([{operation: 'delete', index: 'owned-delta', id: 'removed', receiptNumber: 5, itemStatus: 409, error: {type: 'conflict'}}]);
    });

    test('fresh-output guard leaves existing evidence intact and refuses symlink parents', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hyp-wire-output-guard-'));
        try {
            const existing = join(directory, 'existing'); await mkdir(existing); const evidence = join(existing, 'evidence.txt'); await writeFile(evidence, 'retain');
            await expect(assertNewWireReplayOutput(existing)).rejects.toThrow('new directory');
            await expect(assertNewWireReplayOutput(evidence)).rejects.toThrow('new directory');
            expect(await readFile(evidence, 'utf8')).toBe('retain');
            expect(await assertNewWireReplayOutput(join(directory, 'new-output'))).toBe(resolve(directory, 'new-output'));
            const link = join(directory, 'alias'); await symlink(existing, link, process.platform === 'win32' ? 'junction' : 'dir');
            await expect(assertNewWireReplayOutput(join(link, 'new-output'))).rejects.toThrow('reparse');
        } finally {
            expect(dirname(resolve(directory))).toBe(resolve(tmpdir())); await rm(directory, {recursive: true, force: true});
        }
    });
});
