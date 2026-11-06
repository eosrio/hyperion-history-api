import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';
// @ts-ignore Native qualification helper; the Linux process scenario runs under actual Node.
import {parseLinuxProcessStat} from '../../scripts/qualification/owned-master-process-group.mjs';

test('Linux birth census handles spaces/parentheses in comm and preserves exact start ticks', () => {
    const fields = ['S', '17', '42', '42', ...Array(15).fill('0'), '9007199254740993', '0'];
    const source = `42 (node worker (fixture)) ${fields.join(' ')}`;
    expect(parseLinuxProcessStat(source, 42)).toEqual({pid: 42, state: 'S', parentPid: 17,
        group: 42, session: 42, startTicks: '9007199254740993'});
    expect(() => parseLinuxProcessStat(source, 43)).toThrow();
    expect(() => parseLinuxProcessStat(source.replace('9007199254740993', '-1'), 42)).toThrow();
    expect(() => parseLinuxProcessStat('42 (node) S 17 42 42', 42)).toThrow();
});

test('the process census can parse kernel threads without mistaking their zero group for the owned group', () => {
    const fields = ['S', '0', '0', '0', ...Array(16).fill('0')];
    expect(parseLinuxProcessStat(`2 (kthreadd) ${fields.join(' ')}`, 2)).toEqual({pid: 2, state: 'S',
        parentPid: 0, group: 0, session: 0, startTicks: '0'});
});

test.skipIf(process.platform !== 'linux')('native Linux refuses changed ownership then fences every original master-group identity', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./owned-master-process-group.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 20000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stdout, stderr}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim())).toMatchObject({passed: true, members: 3, unobservedMemberRejected: true,
        changedGroupRejected: true, copiedCensusRejected: true, configuredTitleVerified: true, allOwnedIdentitiesGone: true,
        copiedExitRejected: true, brokerSettlement: 'unknown', productionMasterQualified: false});
}, 25000);
