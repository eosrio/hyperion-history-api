import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runContractReplay, type ActionSourceCrashStage} from './contract-replay.ts';
import {assertActionSourceCrashStage} from './action-source-admission-fault.mjs';

/** Uses the same guarded source/RPC/services/real launcher as contract replay; public query activation remains off. */
export async function runActionSourceAdmissionReplay(stateFile: string, output: string, retainedFixture: string,
    options: {crashAt?: ActionSourceCrashStage} = {}) {
    assert.ok(options && typeof options === 'object' && !Array.isArray(options) && Object.keys(options).every(key => key === 'crashAt'));
    if (Object.hasOwn(options, 'crashAt')) assertActionSourceCrashStage(options.crashAt);
    return runContractReplay(stateFile, output, {retainedFixture, actionSourceAdmission: true,
        ...(options.crashAt === undefined ? {} : {actionSourceCrashAt: options.crashAt})});
}
export function parseActionSourceAdmissionReplayArguments(args: string[]) {
    assert.ok(args.length === 3 || (args.length === 5 && args[3] === '--crash-at'),
        'usage: node action-source-admission-replay.ts OWNED_STATE NEW_OUTPUT AUDITED_RETAINED_FIXTURE [--crash-at before-fragment|after-fragment|before-ack]');
    assert.ok(args.slice(0, 3).every(value => typeof value === 'string' && value.trim().length && !value.startsWith('--')));
    if (args.length === 5) assertActionSourceCrashStage(args[4]);
    return {stateFile: args[0], output: args[1], retainedFixture: args[2], options: args.length === 5 ? {crashAt: args[4] as ActionSourceCrashStage} : {}};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const args = parseActionSourceAdmissionReplayArguments(process.argv.slice(2));
    const report = await runActionSourceAdmissionReplay(args.stateFile, args.output, args.retainedFixture, args.options);
    console.log(JSON.stringify({status: report.status, error: report.error, actionSourceAdmission: report.actionSourceAdmission,
        crashAt: report.actionSourceCrashAt, recovery: report.intentionalRecovery?.outcome, masterExit: report.masterExit}));
    if (report.status !== 'passed') process.exitCode = 1;
}
