// Pure plan/admission/trace checks; no database, process, network or service operations.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const PLAN = Object.freeze({schemaVersion: 1, scope: 'synthetic-native-operator-lists',
    profile: 'operator-list-mongodb-root741-native429-47d5c2c-linux-gitlf-engineering', rootSDK: '7412889a14c84342551fd864ea3ebfcf28849385',
    sdk: '429a1bf1d3bddb746fa662de9529480890b7368f', driver: '7.2.0', server: '8.0.34',
    operationMS: 5000, snapshotMS: 60000, readMS: 10000, publicationMS: 120000,
    read: {names: 8, items: 2048, bytes: 2 * 1024 * 1024, attempts: 256},
    publication: {names: 128, items: 40000, bytes: 32 * 1024 * 1024, attempts: 8192},
    cache: {names: 128, items: 40000, bytes: 8 * 1024 * 1024}, pageSize: 64, batchDocuments: 64,
    cases: ['partitioned-publication-over-16MiB', 'actual-attempts-and-exhaustion', 'ordinary-revision-cache',
        'empty-missing-and-unavailable', 'whole-read-budgets', 'missing-index-native-failure', 'partial-storage-refusal',
        'concurrent-publication-and-losing-CAS', 'cleanup-attempt-reserve', 'late-cancel-and-retirement', 'blocked-find-deadline', 'original-session-client-cleanup'],
    acceptance: {nativeMongoDB: 'pending-until-run', requestHost: 'pending', finalOnSend: 'pending', AtomicParity: 'pending', WireReplay: 'separate'}});
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function argumentsFor(argv, environment) {
    assert.equal(argv.length, 10, 'Use --run --allow-failpoints --database NAME --output NEW_DIR --source COMMIT --compiled-sha256 SHA');
    assert.equal(argv[0], '--run'); assert.equal(argv[1], '--allow-failpoints');
    assert.equal(argv[2], '--database'); assert.match(argv[3], /^h45_lists_[a-f0-9]{12}$/);
    assert.equal(argv[4], '--output'); assert.ok(typeof argv[5] === 'string' && argv[5]);
    assert.equal(argv[6], '--source'); assert.match(argv[7], /^[a-f0-9]{40}$/);
    assert.equal(argv[8], '--compiled-sha256'); assert.match(argv[9], /^[a-f0-9]{64}$/);
    const uri = environment.HYPERION_OPERATOR_LIST_MONGO_URI, parsed = new URL(uri);
    assert.equal(parsed.protocol, 'mongodb:'); assert.equal(parsed.hostname, '127.0.0.1');
    assert.equal(parsed.username + parsed.password + parsed.hash, ''); assert.ok(parsed.pathname === '' || parsed.pathname === '/');
    const port = Number(parsed.port); assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 27017);
    assert.deepEqual([...parsed.searchParams.keys()].sort(), ['directConnection', 'replicaSet']);
    assert.equal(parsed.searchParams.get('directConnection'), 'true');
    const replicaSet = parsed.searchParams.get('replicaSet'); assert.match(replicaSet, /^(?:h45_[a-z0-9_]{1,40}|h45rs_[a-f0-9]{32})$/);
    return {uri, database: argv[3], output: argv[5], source: argv[7], compiledSha256: argv[9], replicaSet,
        member: replicaSet.startsWith('h45rs_') ? 'hyp-projection-' + replicaSet.slice(6) + '-replica:27017' : '127.0.0.1:' + port};
}
export function verifyReadTrace(trace, phase, {attempts, maximum, success = false, pageSize = PLAN.pageSize} = {}) {
    const data = trace.filter(row => row.phase === phase && row.event === 'started' && row.tagged && ['find', 'aggregate', 'getMore', 'killCursors'].includes(row.command));
    assert.ok(data.length <= maximum, 'Actual read attempt allowance exceeded');
    if (attempts !== undefined) assert.equal(data.length, attempts, 'Reported native attempts differ from actual commands');
    for (const row of data) {
        assert.equal(row.transactional, false); assert.ok(row.lsid && row.txn === null && row.traceId);
        const start = trace.find(item => item.event === 'started' && item.traceId === row.traceId);
        assert.ok(start && start.seq <= row.seq && start.readConcern === 'snapshot' && start.lsid === row.lsid, 'No actual snapshot start for native read');
        if (row.seq !== start.seq) {
            const established = trace.find(item => item.event === 'succeeded' && item.client === start.client && item.requestId === start.requestId);
            assert.ok(established?.snapshotTime && row.atClusterTime === established.snapshotTime && row.readConcern === 'snapshot', 'Native snapshot time changed or was not carried forward');
        }
        if (row.command !== 'killCursors') assert.equal(row.batchSize, pageSize);
        if (row.command === 'getMore' || row.command === 'killCursors') assert.equal(row.maxTimeMS, null, 'Non-tailable cursor control cannot have maxTimeMS');
        else assert.ok(row.maxTimeMS > 0 && row.maxTimeMS <= PLAN.operationMS);
        const reply = trace.find(item => item.event === 'succeeded' && item.requestId === row.requestId && item.client === row.client);
        if (success) assert.ok(reply, 'Missing successful original command response');
        if (reply?.cursor !== undefined) assert.ok(reply.batch <= pageSize);
        if (success && reply && reply.cursor !== '0') {
            assert.ok(data.some(next => next.seq > row.seq && next.command === 'getMore' && next.cursor === reply.cursor), 'Successful read hid an unexhausted cursor');
        }
    }
    assert.equal(trace.filter(row => row.phase === phase && row.event === 'started' && ['commitTransaction', 'abortTransaction'].includes(row.command)).length, 0,
        'Snapshot list reads must not hide transaction completion/retry commands');
    if (success && data.length) {
        const final = data.at(-1), response = trace.find(row => row.event === 'succeeded' && row.requestId === final.requestId && row.client === final.client);
        assert.equal(response?.cursor, '0', 'Complete result lacks native exhaustion');
    }
    return {attempts: data.length, replyBsonBytes: trace.filter(row => row.phase === phase && row.event === 'succeeded').reduce((n, row) => n + row.replyBsonBytes, 0)};
}
export function failure(error, depth = 0) {
    return {name: String(error?.name ?? 'Error').slice(0, 64), code: typeof error?.code === 'string' || Number.isSafeInteger(error?.code) ? error.code : null,
        message: String(error?.message ?? 'Unknown fixture failure').slice(0, 512),
        ...(error?.cause && depth < 2 ? {cause: failure(error.cause, depth + 1)} : {}),
        ...(Array.isArray(error?.suppressed) && depth < 2 ? {suppressed: error.suppressed.slice(0, 4).map(item => failure(item, depth + 1))} : {})};
}
export function assertOriginalTerminal(terminal) {
    assert.equal(terminal.timedOut, false, 'Timeout/grace cannot become a native pass');
    assert.equal(terminal.code, 0); assert.equal(terminal.signal, null); assert.equal(terminal.terminal, true); assert.equal(terminal.streamsClosed, true);
}
/** Pure readiness fence; a recorded interruption cannot authorize the next effect. */
export async function afterReadiness(check, ready, continueWork) {
    check(); await ready(); check(); return continueWork();
}
/** Pure CI verdict check; artifact collection/cleanup cannot replace the original child result. */
export function assertNativeCompletion(terminal, native, compiledSha256) {
    assertOriginalTerminal(terminal);
    assert.equal(native.status, 'passed-native-only'); assert.equal(native.source.profile, PLAN.profile); assert.equal(native.source.compiledSha256, compiledSha256);
    assert.deepEqual(native.cases.map(row => row.name).sort(), PLAN.cases.filter(name => name !== 'original-session-client-cleanup').sort());
    assert.ok(native.cases.every(row => row.status === 'passed'));
    for (const key of ['ownedDatabaseDropped', 'failpointDisabled', 'sessionsEnded', 'boundedClosed', 'adminClosed', 'noHiddenTransactionControls'])
        assert.equal(native.cleanup[key], true, 'Original native cleanup is incomplete: ' + key);
}
