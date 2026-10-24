import {expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {parsePortableWorkerArguments, validatePortableWorkerOptions} from '../../scripts/qualification/portable-state-worker.ts';
// @ts-ignore Native qualification custody helpers; these do not issue production authority.
import {createWireMasterRestartControl, readWireMasterRestartControl, describeWireMasterCrash, wireMasterSourceSequence}
    from '../../scripts/qualification/portable-state-master-recovery.mjs';

const origin = 'http://127.0.0.1:58271', profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
test('master crash qualification requires explicit source authority and excludes every other fault/profile mode', () => {
    expect(parsePortableWorkerArguments(['state', 'plan', 'new-output', '--native', '--authority-rpc', origin, '--master-recovery']).options)
        .toEqual({native: true, authorityRpc: origin, masterRecovery: true});
    for (const options of [{masterRecovery: true}, {native: true, masterRecovery: true},
        {native: true, authorityRpc: origin, masterRecovery: 'yes'},
        {native: true, authorityRpc: origin, masterRecovery: true, profile: true},
        {native: true, authorityRpc: origin, masterRecovery: true, workerRecovery: true}])
        expect(() => validatePortableWorkerOptions(options)).toThrow();
    expect(() => parsePortableWorkerArguments(['s', 'p', 'o', '--master-recovery'])).toThrow();
});

test('master restart control binds both exact observer epochs and unchanged config/source metadata', () => {
    const output = mkdtempSync(join(realpathSync(tmpdir()), 'hapi-master-recovery-'));
    const chain = 'hyp-p191-123456abcdef', configFile = join(output, 'chain.json');
    const config = {settings: {chain, protocol: {profileId}}};
    try {
        for (const name of ['master', 'master-restarted']) mkdirSync(join(output, 'observer', name), {recursive: true});
        writeFileSync(configFile, JSON.stringify(config));
        const {file, control} = createWireMasterRestartControl({output, configFile, chain, frameSha256: 'a'.repeat(64), source: {
            chainId: '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d', profileId, endBlock: 1480,
            records: Array.from({length: 33}, () => ({blockId: 'b'.repeat(64)}))}});
        for (const phase of ['before', 'after']) {
            const observerDirectory = join(output, 'observer', phase === 'before' ? 'master' : 'master-restarted');
            expect(readWireMasterRestartControl(file, {observerDirectory, configFile, chain, phase})).toEqual(control);
            expect(() => readWireMasterRestartControl(file, {observerDirectory, configFile, chain, phase: phase === 'before' ? 'after' : 'before'})).toThrow();
        }
        const before = readFileSync(configFile);
        writeFileSync(configFile, JSON.stringify({...config, unapprovedChange: true}));
        expect(() => readWireMasterRestartControl(file, {observerDirectory: join(output, 'observer/master'), configFile, chain, phase: 'before'})).toThrow();
        writeFileSync(configFile, before);
        expect(() => describeWireMasterCrash(structuredClone(control))).toThrow('unissued');
        expect(() => wireMasterSourceSequence({schemaVersion: 1, kind: 'wire-master-crash-observed'}, 33)).toThrow('unissued');
        expect(wireMasterSourceSequence(undefined, 4)).toEqual([1, 2, 3, 4]);
        for (const bad of [-1, 1.5, NaN, 4097]) expect(() => wireMasterSourceSequence(undefined, bad)).toThrow();
    } finally {
        const resolved = realpathSync(output);
        expect(dirname(resolved)).toBe(realpathSync(tmpdir())); expect(basename(resolved).startsWith('hapi-master-recovery-')).toBe(true);
        rmSync(resolved, {recursive: true, force: true});
    }
});
