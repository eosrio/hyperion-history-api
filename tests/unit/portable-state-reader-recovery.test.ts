import {expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {parsePortableWorkerArguments, validatePortableWorkerOptions} from '../../scripts/qualification/portable-state-worker.ts';
// @ts-ignore Qualification custody helpers; these do not recreate runtime authority.
import {createWireReaderRecoveryControl, readWireReaderRecoveryControl, describeWireReaderSnapshot, describeWireReaderCrash,
    snapshotWireReader, crashWireReader, releaseWireReaderRpc} from '../../scripts/qualification/portable-state-reader-recovery.mjs';

const origin = 'http://127.0.0.1:58271', profileId = 'wire-sysio-6508c9e8-native-engineering-v1';

test('reader handover requires explicit native authority and excludes CPU capture and other fault modes', () => {
    expect(parsePortableWorkerArguments(['state', 'plan', 'output', '--native', '--authority-rpc', origin, '--reader-recovery']).options)
        .toEqual({native: true, authorityRpc: origin, readerRecovery: true});
    for (const options of [{readerRecovery: true}, {native: true, readerRecovery: true},
        {native: true, authorityRpc: origin, readerRecovery: 'yes'},
        {native: true, authorityRpc: origin, readerRecovery: true, profile: true},
        {native: true, authorityRpc: origin, readerRecovery: true, workerRecovery: true},
        {native: true, authorityRpc: origin, readerRecovery: true, masterRecovery: true}])
        expect(() => validatePortableWorkerOptions(options)).toThrow();
    expect(() => parsePortableWorkerArguments(['s', 'p', 'o', '--reader-recovery'])).toThrow();
    expect(parsePortableWorkerArguments(['s', 'p', 'o']).options).toEqual({});
});

test('constructed reader controls bind unchanged config and source and cannot become a native fault receipt', async () => {
    const output = mkdtempSync(join(realpathSync(tmpdir()), 'hapi-reader-control-'));
    const chain = 'hyp-p191-123456abcdef', configFile = join(output, 'chain.json');
    const config = {settings: {chain, protocol: {profileId}}};
    try {
        mkdirSync(join(output, 'observer/master'), {recursive: true}); writeFileSync(configFile, JSON.stringify(config));
        const {file, control} = createWireReaderRecoveryControl({output, configFile, chain, frameSha256: 'a'.repeat(64),
            resumeFrameSha256: 'c'.repeat(64), source: {chainId: '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d',
                profileId, endBlock: 1480, records: Array.from({length: 34}, (_, i) => ({blockId: (i === 33 ? 'd' : 'b').repeat(64)}))}});
        const observerDirectory = join(output, 'observer/master');
        expect(readWireReaderRecoveryControl(file, {observerDirectory, configFile, chain})).toEqual(control);
        expect(control).toMatchObject({kind: 'wire-reader-handover', blockNum: 33, resumeBlockNum: 34, readerRole: 'continuous_reader'});
        expect(() => describeWireReaderSnapshot(structuredClone(control))).toThrow('unissued');
        expect(() => describeWireReaderCrash(structuredClone(control))).toThrow('unissued');
        await expect(snapshotWireReader({control: structuredClone(control), child: {}, rows: []})).rejects.toThrow('unissued');
        await expect(crashWireReader(structuredClone(control))).rejects.toThrow('unissued');
        await expect(releaseWireReaderRpc(structuredClone(control))).rejects.toThrow('unissued');
        const bytes = readFileSync(configFile); writeFileSync(configFile, JSON.stringify({...config, changed: true}));
        expect(() => readWireReaderRecoveryControl(file, {observerDirectory, configFile, chain})).toThrow();
        writeFileSync(configFile, bytes);
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        for (const change of [{resumeBlockNum: 33}, {readerRole: 'ds_pool_worker'}, {titlePrefix: 'foreign'}, {chain: 'foreign'}]) {
            writeFileSync(file, JSON.stringify({...saved, ...change}));
            expect(() => readWireReaderRecoveryControl(file, {observerDirectory, configFile, chain})).toThrow();
        }
    } finally {
        const resolved = realpathSync(output); expect(dirname(resolved)).toBe(realpathSync(tmpdir()));
        expect(basename(resolved).startsWith('hapi-reader-control-')).toBe(true); rmSync(resolved, {recursive: true, force: true});
    }
});
