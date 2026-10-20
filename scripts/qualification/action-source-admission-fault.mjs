/** Qualification-only process fault control and evidence. Never imports production workers. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
    realpathSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';

export const actionSourceCrashStages = Object.freeze(['before-fragment', 'after-fragment', 'before-ack']);
export const actionSourceCrashExitCode = 86;
export const actionSourceCrashLimits = Object.freeze({payloadBytes: 1024 * 1024, markerBytes: 2 * 1024 * 1024,
    controlBytes: 16384, ackFiles: 32, ackFileBytes: 1024 * 1024, ackRecords: 2048});
const sha = value => createHash('sha256').update(value).digest('hex');
const hex = /^[0-9a-f]{64}$/;
const clone = value => JSON.parse(JSON.stringify(value));

export function assertActionSourceCrashStage(stage) {
    assert.ok(actionSourceCrashStages.includes(stage), 'invalid action source crash stage');
    return stage;
}
function readBounded(file, limit) {
    const stat = lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit, 'invalid bounded fault evidence file');
    return readFileSync(file);
}
function durableNewJson(file, record) {
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    assert.ok(bytes.length <= actionSourceCrashLimits.markerBytes, 'fault evidence exceeds bound');
    const fd = openSync(file, 'wx');
    try {writeFileSync(fd, bytes); fsyncSync(fd);} finally {closeSync(fd);}
    // Windows does not expose a portable directory fsync. File fsync is mandatory on every host.
    if (process.platform !== 'win32') {
        const directory = openSync(dirname(file), 'r');
        try {fsyncSync(directory);} finally {closeSync(directory);}
    }
}
export function createActionSourceCrashControl({output, configFile, chain, sourceChainId, fixtureSha256, stateSha256, stage}) {
    assertActionSourceCrashStage(stage);
    assert.ok(isAbsolute(output) && realpathSync(output) === resolve(output), 'fault output must be an existing real absolute directory');
    assert.equal(resolve(configFile), join(output, 'config', 'chain.json'));
    assert.ok(typeof chain === 'string' && /^hyp-replay-[a-z0-9-]+$/.test(chain));
    for (const hash of [sourceChainId, fixtureSha256, stateSha256]) assert.match(hash, hex);
    const directory = join(output, 'admission-fault'); mkdirSync(directory);
    const control = {schemaVersion: 1, runId: randomUUID(), stage, chain, sourceChainId, fixtureSha256, stateSha256,
        output, configFile, configSha256: sha(readBounded(configFile, 1024 * 1024)),
        observerDirectory: join(output, 'observer'), exitCode: actionSourceCrashExitCode};
    const file = join(directory, 'control.json'); durableNewJson(file, control);
    return {file, control};
}
export function readActionSourceCrashControl(file, {observerDirectory, chain, configFile}) {
    assert.ok(isAbsolute(file) && isAbsolute(observerDirectory), 'fault control paths must be absolute');
    const observer = realpathSync(observerDirectory), output = dirname(observer);
    assert.equal(observer, join(output, 'observer'));
    assert.equal(resolve(file), join(output, 'admission-fault', 'control.json'));
    assert.equal(realpathSync(dirname(file)), dirname(file), 'fault directory must not be a symlink');
    const control = JSON.parse(readBounded(file, actionSourceCrashLimits.controlBytes).toString());
    assert.equal(control.schemaVersion, 1); assertActionSourceCrashStage(control.stage);
    assert.equal(control.exitCode, actionSourceCrashExitCode); assert.match(control.runId, /^[a-f0-9-]{36}$/);
    assert.equal(control.output, output); assert.equal(control.observerDirectory, observer);
    assert.equal(control.chain, chain); assert.equal(control.configFile, resolve(configFile));
    assert.equal(control.configFile, join(output, 'config', 'chain.json'));
    assert.equal(sha(readBounded(configFile, 1024 * 1024)), control.configSha256, 'fault configuration changed');
    for (const hash of [control.sourceChainId, control.fixtureSha256, control.stateSha256]) assert.match(hash, hex);
    return control;
}

/** Capture the actual active DS admission, original broker delivery and source-derived group identities. */
export function actionSourceCrashSnapshot(worker, message, fragmentId = worker.activeActionAdmission?.fragmentId ?? null) {
    const scope = worker.activeActionAdmission;
    assert.ok(scope && scope.owner.current(), 'fault hook lost its actual admission owner');
    const admission = scope.admission, transaction = admission.inventory?.transactions.find(row => row.traceOrdinal === scope.traceOrdinal);
    assert.ok(transaction?.dispatch && admission.planId && admission.incomplete === null, 'fault hook requires complete admitted dispatch');
    assert.equal(message.properties?.headers?.['hyperion-action-admission-v1'], admission.id);
    assert.equal(message.properties?.headers?.action_trace_ordinal, scope.traceOrdinal);
    const payload = Buffer.from(message.content);
    assert.ok(payload.length > 0 && payload.length <= actionSourceCrashLimits.payloadBytes, 'fault payload exceeds bound');
    assert.ok(payload.equals(scope.payload), 'fault message differs from active DS bytes');
    assert.equal(sha(payload), transaction.dispatch.bodySha256);
    const source = admission.inventory.source;
    assert.equal(admission.source.inventoryInput.profileId, 'antelope-default-v1', 'crash fixture is Antelope only');
    assert.ok(Number.isSafeInteger(message.fields?.deliveryTag) && message.fields.deliveryTag > 0);
    assert.equal(typeof message.fields?.redelivered, 'boolean');
    const roots = transaction.groups.map(group => group.metadata.global_sequence);
    assert.ok(roots.every(root => typeof root === 'string' && /^(0|[1-9][0-9]*)$/.test(root)));
    return {schemaVersion: 1, pid: process.pid, parentPid: process.ppid, role: process.env.worker_role,
        workerId: process.env.worker_id, chain: worker.chain, admissionId: admission.id, sourceId: admission.sourceId,
        planId: admission.planId, traceOrdinal: scope.traceOrdinal, transactionId: transaction.transactionId,
        traceSha256: transaction.traceSha256, payloadSha256: sha(payload), payloadBytes: payload.length,
        payloadBase64: payload.toString('base64'), source: clone(source), captureSha256: admission.source.captureSha256,
        originalFrameSha256: sha(Buffer.from(admission.source.frameHex, 'hex')), producer: clone(admission.source.producer),
        executableSha256: admission.source.executableSha256, target: clone(admission.target), roots,
        fragmentId, deliveryTag: message.fields.deliveryTag, redelivered: message.fields.redelivered};
}
export function deliberatelyExitActionSource(control, stage, snapshot) {
    assertActionSourceCrashStage(stage);
    if (stage !== control.stage || snapshot.roots.length === 0) return false;
    assert.equal(snapshot.role, 'ds_pool_worker'); assert.equal(snapshot.chain, control.chain);
    assert.equal(snapshot.source.chainId, control.sourceChainId);
    assert.ok(typeof snapshot.workerId === 'string' && snapshot.workerId.length > 0);
    if (stage === 'before-fragment') assert.equal(snapshot.fragmentId, null);
    else assert.match(snapshot.fragmentId, /^h45actionfragment1:[0-9a-f]{64}$/);
    const marker = {...snapshot, runId: control.runId, stage, exitCode: actionSourceCrashExitCode,
        at: Date.now(), controlSha256: sha(Buffer.from(JSON.stringify(control))),
        durability: {fileFsyncBeforeExit: true, directoryFsync: process.platform === 'win32' ? 'unsupported-on-win32' : 'required-before-exit'}};
    try {durableNewJson(join(control.output, 'admission-fault', 'fault.json'), marker);}
    catch (error) {if (error?.code === 'EEXIST') return false; throw error;}
    // No ACK, mocked exception, requeue or synthetic output. Existing master supervision owns recovery.
    process.exit(actionSourceCrashExitCode);
}
export function createActionSourceAckRecorder(control) {
    let bytes = 0, sequence = 0, descriptor;
    return (kind, snapshot) => {
        assert.ok(['ack-intent', 'ack-sent'].includes(kind));
        assert.equal(snapshot.chain, control.chain); assert.equal(snapshot.source.chainId, control.sourceChainId);
        const {payloadBase64, ...binding} = snapshot;
        const line = JSON.stringify({...binding, kind, runId: control.runId, sequence: ++sequence, at: Date.now()}) + '\n';
        bytes += Buffer.byteLength(line);
        assert.ok(sequence <= actionSourceCrashLimits.ackRecords && bytes <= actionSourceCrashLimits.ackFileBytes, 'ACK evidence exceeds bound');
        descriptor ??= openSync(join(control.output, 'admission-fault', `acks-${process.pid}.jsonl`), 'wx');
        writeFileSync(descriptor, line); fsyncSync(descriptor);
    };
}
export function readActionSourceCrashEvidence(control) {
    const directory = join(control.output, 'admission-fault');
    const marker = JSON.parse(readBounded(join(directory, 'fault.json'), actionSourceCrashLimits.markerBytes).toString());
    const files = readdirSync(directory);
    assert.ok(files.every(file => ['control.json', 'fault.json'].includes(file) || /^acks-[1-9][0-9]*\.jsonl$/.test(file)), 'unexpected fault evidence file');
    const ackFiles = files.filter(file => file.startsWith('acks-'));
    assert.ok(ackFiles.length > 0 && ackFiles.length <= actionSourceCrashLimits.ackFiles, 'invalid ACK evidence file count');
    const acks = [];
    for (const file of ackFiles) {
        const text = readBounded(join(directory, file), actionSourceCrashLimits.ackFileBytes).toString();
        assert.ok(text.endsWith('\n'), 'truncated ACK evidence');
        const rows = text.trimEnd().split('\n').map(line => JSON.parse(line));
        assert.ok(rows.length <= actionSourceCrashLimits.ackRecords && acks.length + rows.length <= actionSourceCrashLimits.ackRecords,
            'total ACK evidence exceeds record bound');
        for (const [index, row] of rows.entries()) {
            assert.equal(row.pid, Number(file.slice(5, -6))); assert.equal(row.sequence, index + 1);
            assert.equal(row.runId, control.runId); assert.ok(['ack-intent', 'ack-sent'].includes(row.kind));
            acks.push(row);
        }
    }
    return {marker, acks};
}

/** Accept precisely one proven deliberate process death. Raw observer outcomes remain unchanged in the report. */
export function verifyActionSourceCrashRecovery({control, marker, acks, rows, masterPid, masterExit, membership, finalActions}) {
    assert.equal(marker.schemaVersion, 1); assert.equal(marker.runId, control.runId);
    assert.equal(marker.controlSha256, sha(Buffer.from(JSON.stringify(control))));
    assert.equal(marker.stage, control.stage); assert.equal(marker.exitCode, actionSourceCrashExitCode);
    assert.equal(marker.role, 'ds_pool_worker'); assert.equal(marker.chain, control.chain);
    assert.equal(marker.parentPid, masterPid); assert.ok(Number.isSafeInteger(marker.pid) && marker.pid !== masterPid);
    assert.equal(marker.source.chainId, control.sourceChainId); assert.equal(marker.durability?.fileFsyncBeforeExit, true);
    assert.ok(['unsupported-on-win32', 'required-before-exit'].includes(marker.durability.directoryFsync));
    const body = Buffer.from(marker.payloadBase64, 'base64');
    assert.ok(body.length > 0 && body.length <= actionSourceCrashLimits.payloadBytes);
    assert.equal(body.length, marker.payloadBytes); assert.equal(body.toString('base64'), marker.payloadBase64);
    assert.equal(sha(body), marker.payloadSha256);
    if (control.stage === 'before-fragment') assert.equal(marker.fragmentId, null);
    else assert.match(marker.fragmentId, /^h45actionfragment1:[0-9a-f]{64}$/);
    assert.ok(marker.roots.length > 0 && new Set(marker.roots).size === marker.roots.length);
    const sameDelivery = row => row.admissionId === marker.admissionId && row.sourceId === marker.sourceId &&
        row.planId === marker.planId && row.traceOrdinal === marker.traceOrdinal && row.transactionId === marker.transactionId &&
        row.payloadSha256 === marker.payloadSha256 && row.payloadBytes === marker.payloadBytes;
    for (const ack of acks) {
        assert.equal(ack.runId, control.runId); assert.equal(ack.chain, control.chain); assert.equal(ack.role, 'ds_pool_worker');
        assert.ok(['ack-intent', 'ack-sent'].includes(ack.kind));
        const partner = acks.filter(row => row.pid === ack.pid && row.sequence === ack.sequence + (ack.kind === 'ack-intent' ? 1 : -1));
        assert.equal(partner.length, 1, 'ACK evidence pair is missing');
        assert.equal(partner[0].kind, ack.kind === 'ack-intent' ? 'ack-sent' : 'ack-intent');
        assert.equal(partner[0].admissionId, ack.admissionId); assert.equal(partner[0].payloadSha256, ack.payloadSha256);
        assert.equal(partner[0].deliveryTag, ack.deliveryTag);
    }
    assert.equal(acks.filter(row => row.pid === marker.pid && sameDelivery(row)).length, 0, 'original fault delivery attempted an ACK');
    const redelivery = acks.filter(row => row.kind === 'ack-sent' && row.pid !== marker.pid && row.role === marker.role &&
        row.workerId === marker.workerId && row.redelivered === true && sameDelivery(row));
    assert.equal(redelivery.length, 1, 'exact original body/admission needs one ACK from a distinct replacement redelivery');
    const recovered = redelivery[0];
    assert.deepEqual(recovered.source, marker.source); assert.deepEqual(recovered.target, marker.target);
    assert.deepEqual(recovered.roots, marker.roots); assert.equal(recovered.traceSha256, marker.traceSha256);
    assert.equal(recovered.captureSha256, marker.captureSha256); assert.equal(recovered.originalFrameSha256, marker.originalFrameSha256);
    assert.ok(acks.some(row => row.kind === 'ack-intent' && row.pid === recovered.pid && row.deliveryTag === recovered.deliveryTag &&
        row.sequence === recovered.sequence - 1 && sameDelivery(row)), 'replacement ACK lacks preceding durable intent');
    assert.equal(membership?.source, 'audited-retained-native-capture');
    const plans = membership.plans.filter(plan => plan.admissionId === marker.admissionId);
    assert.equal(plans.length, 1, 'original source manifest missing'); const plan = plans[0];
    for (const key of ['sourceId', 'planId', 'captureSha256', 'originalFrameSha256', 'executableSha256']) assert.equal(plan[key], marker[key]);
    assert.equal(plan.blockNum, marker.source.blockNum); assert.equal(plan.blockId, marker.source.blockId);
    assert.deepEqual(plan.target, marker.target); assert.deepEqual(plan.producer, marker.producer);
    const actual = finalActions.filter(hit => hit._source?.trx_id === marker.transactionId);
    assert.deepEqual(actual.map(hit => hit._source.global_sequence).sort(), [...marker.roots].sort(), 'original transaction outputs differ');
    assert.ok(actual.every(hit => hit._source.block_id === marker.source.blockId && hit._source.block_num === marker.source.blockNum));

    assert.deepEqual(masterExit, {code: 1, signal: null}, 'intentional child failure must retain the actual master failure outcome');
    assert.equal(rows.filter(row => row.kind === 'observer_error').length, 0, 'observer failure cannot be normalized');
    assert.equal(rows.filter(row => ['shutdown_force_child', 'shutdown_late_child'].includes(row.kind)).length, 0);
    for (const flush of rows.filter(row => row.kind === 'flush')) {
        assert.equal(flush.success, true); assert.equal(flush.error, null); assert.equal(flush.droppedRecords, 0);
    }
    const starts = rows.filter(row => row.kind === 'start');
    assert.equal(new Set(starts.map(row => row.pid)).size, starts.length, 'duplicate process start');
    const ownExits = rows.filter(row => row.kind === 'exit');
    assert.equal(ownExits.length, starts.length, 'untracked or missing process exit');
    assert.ok(ownExits.every(exit => starts.some(start => start.pid === exit.pid)), 'untracked process exit');
    const original = starts.filter(row => row.pid === marker.pid), replacement = starts.filter(row => row.pid === recovered.pid);
    for (const [start, pid] of [[original, marker.pid], [replacement, recovered.pid]]) {
        assert.equal(start.length, 1, 'fault/replacement start evidence missing');
        assert.equal(start[0].role, marker.role); assert.equal(start[0].workerId, marker.workerId);
        assert.equal(start[0].parentPid, masterPid); assert.equal(start[0].chain, control.chain);
        assert.equal(rows.filter(row => row.kind === 'worker_fork' && row.pid === masterPid && row.childPid === pid).length, 1);
    }
    assert.ok(replacement[0].at >= marker.at, 'replacement predates fault');
    const shutdowns = rows.filter(row => row.kind === 'shutdown' && row.pid === masterPid);
    assert.equal(shutdowns.length, 1); const shutdown = shutdowns[0];
    assert.equal(shutdown.success, false); assert.deepEqual(shutdown.forced, []); assert.deepEqual(shutdown.unresolved, []);
    assert.equal(shutdown.children, shutdown.exited);
    assert.equal(shutdown.failedChildren.length, 1);
    const failed = shutdown.failedChildren[0]; assert.equal(failed.pid, marker.pid);
    assert.equal(failed.code, actionSourceCrashExitCode); assert.equal(failed.signal, null);
    assert.equal(shutdown.childExits.filter(row => row.pid === marker.pid).length, 1);
    for (const exit of shutdown.childExits) {
        assert.equal(exit.code, exit.pid === marker.pid ? actionSourceCrashExitCode : 0); assert.equal(exit.signal, null);
    }
    for (const start of starts) {
        const exits = rows.filter(row => row.kind === 'exit' && row.pid === start.pid); assert.equal(exits.length, 1);
        assert.equal(exits[0].code, start.pid === marker.pid ? actionSourceCrashExitCode : start.pid === masterPid ? 1 : 0);
        assert.equal(exits[0].droppedRecords, 0); assert.notEqual(exits[0].profileState, 'failed');
        if (start.pid !== marker.pid) {
            assert.equal(exits[0].flushed, true, 'unrelated process did not flush');
            const flushes = rows.filter(row => row.kind === 'flush' && row.pid === start.pid); assert.ok(flushes.length > 0);
            for (const flush of flushes) {assert.equal(flush.success, true); assert.equal(flush.error, null); assert.equal(flush.droppedRecords, 0);}
        }
    }
    const parentExits = rows.filter(row => row.kind === 'worker_exit');
    assert.equal(parentExits.filter(row => row.childPid === marker.pid).length, 1);
    for (const exit of parentExits) {assert.equal(exit.code, exit.childPid === marker.pid ? actionSourceCrashExitCode : 0); assert.equal(exit.signal, null);}
    // Feed a detached, precisely normalized view to the existing strict shutdown verifier.
    // Never overwrite raw master/child outcomes in report.json or observer files.
    const verificationRows = clone(rows);
    for (const row of verificationRows) {
        if (row.kind === 'exit' && [marker.pid, masterPid].includes(row.pid)) row.code = 0;
        if (row.kind === 'worker_exit' && row.childPid === marker.pid) row.code = 0;
        if (row.kind === 'shutdown' && row.pid === masterPid) {
            row.success = true; row.failedChildren = [];
            row.childExits.find(exit => exit.pid === marker.pid).code = 0;
        }
    }
    return {verificationRows, evidence: {schemaVersion: 1, outcome: 'intentional-process-exit-and-recovery',
        marker, replacement: recovered, originalAckAttempts: 0, rawMasterExit: clone(masterExit), rawShutdown: clone(shutdown),
        recoveredPlan: clone(plan), exactOutputRoots: [...marker.roots],
        limits: ['Observed process death and broker redelivery; no host/power-loss durability or master-failover claim.',
            'Source membership and final fixture outputs remain distinct from canonical fork/query-ready authority.']}};
}
