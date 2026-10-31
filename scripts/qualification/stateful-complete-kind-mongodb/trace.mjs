import assert from 'node:assert/strict';
import {BSON} from 'mongodb';

const plain = value => JSON.parse(JSON.stringify(value));
const identity = value => value ? BSON.serialize({value}).toString('hex') : null;
const tagged = command => command.comment?.hyperion === 'stateful-complete-kind-v1';
const collection = command => command.find ?? command.collection ?? command.killCursors ?? null;

/** Actual driver command events, sanitized to this synthetic fixture database only. */
export function monitor(client, database, label, phase, trace) {
    const pending = new Map();
    const started = event => {
        if (event.databaseName !== database) return;
        assert.ok(trace.length < 8192, 'Native trace event bound');
        const command = event.command, scope = phase();
        const row = {seq: trace.length, event: 'started', client: label, phase: scope.name,
            requestId: event.requestId, command: event.commandName, collection: collection(command),
            lsid: identity(command.lsid), txn: command.txnNumber?.toString() ?? null,
            transactional: command.autocommit === false, startsTransaction: command.startTransaction === true,
            readConcern: command.readConcern?.level ?? null, tagged: tagged(command),
            ...(tagged(command) ? {comment: plain(command.comment)} : {}),
            ...(scope.expected ? {expected: plain(scope.expected), owner: plain(scope.owner), ownerClaim: scope.ownerClaim} : {}),
            ...(command.find ? {filter: plain(command.filter ?? {}), hint: command.hint ?? null,
                batchSize: command.batchSize ?? null, limit: command.limit ?? null} : {}),
            ...(command.getMore ? {cursor: command.getMore.toString(), batchSize: command.batchSize ?? null} : {})};
        pending.set(event.requestId, row); trace.push(row);
    };
    const finish = (event, success) => {
        const begin = pending.get(event.requestId); if (!begin) return;
        pending.delete(event.requestId); assert.ok(trace.length < 8192, 'Native trace event bound');
        const reply = event.reply, batch = reply?.cursor?.firstBatch ?? reply?.cursor?.nextBatch;
        trace.push({seq: trace.length, event: success ? 'succeeded' : 'failed', client: label, phase: begin.phase,
            requestId: event.requestId, command: begin.command,
            ...(success ? {replyBsonBytes: BSON.calculateObjectSize(reply),
                ...(reply?.cursor ? {cursor: reply.cursor.id.toString(), batch: batch.length} : {}),
                ...(begin.collection?.endsWith('_stateful_v2_metadata') && batch?.length === 1 ? {metadata: {
                    declarationDigest: batch[0].declarationDigest, revision: batch[0].revision,
                    checkpoint: plain(batch[0].checkpoint), owner: plain(batch[0].owner.identity), ownerClaim: batch[0].owner.claimDigest,
                    initialized: batch[0].initialized, raw: batch[0].raw !== null, pending: batch[0].pending !== null,
                    gap: batch[0].gap !== null, rollback: batch[0].rollback !== null}} : {})}
                : {code: event.failure?.code ?? null, labels: [...(event.failure?.errorLabels ?? [])]})});
    };
    const succeeded = event => finish(event, true), failed = event => finish(event, false);
    client.on('commandStarted', started); client.on('commandSucceeded', succeeded); client.on('commandFailed', failed);
    return () => {client.off('commandStarted', started); client.off('commandSucceeded', succeeded); client.off('commandFailed', failed);};
}

/** Independent evidence check: every projection command belongs to a validated data snapshot. */
export function verifyReadTrace(trace, phase, {attempts, maximum, success = false, operation = 'kind'} = {}) {
    const all = trace.filter(row => row.phase === phase);
    const data = all.filter(row => row.event === 'started' && ['find', 'getMore'].includes(row.command)
        && row.collection?.includes('_stateful_v2_r_'));
    assert.ok(data.length <= maximum, 'Actual projection command count exceeds remaining attempts');
    if (attempts !== undefined) assert.equal(data.length, attempts, 'Reported attempts differ from actual native data commands');
    for (const row of data) {
        assert.equal(row.tagged, true, 'An authority inspection hid a projection data read');
        assert.equal(row.transactional, true); assert.ok(row.lsid && row.txn !== null);
        const start = all.find(item => item.event === 'started' && item.client === row.client && item.lsid === row.lsid
            && item.txn === row.txn && item.startsTransaction);
        assert.ok(start && start.seq < row.seq, 'Missing actual transaction start'); assert.equal(start.readConcern, 'snapshot');
        assert.equal(row.comment.declaration, row.expected.declarationDigest);
        assert.ok(['key', 'kind'].includes(row.comment.operation));
        if (operation !== 'mixed') assert.equal(row.comment.operation, operation);
        if (row.comment.operation === 'kind') assert.equal(row.limit ?? null, null, 'A native kind limit cannot prove exhaustion');
        assert.equal(row.batchSize, 1);
        const inspected = all.findLast(meta => meta.event === 'started' && meta.seq < row.seq
            && meta.command === 'find' && meta.collection?.endsWith('_stateful_v2_metadata')
            && meta.client === row.client && meta.lsid === row.lsid && meta.txn === row.txn && meta.transactional);
        assert.ok(inspected, 'Projection data lacks metadata inspection in its own snapshot');
        const result = all.find(meta => meta.event === 'succeeded' && meta.requestId === inspected.requestId
            && meta.seq < row.seq && meta.client === inspected.client);
        assert.ok(result?.metadata, 'Native same-snapshot metadata inspection did not complete');
        const meta = result.metadata;
        assert.equal(meta.declarationDigest, row.expected.declarationDigest); assert.equal(meta.revision, row.expected.revision);
        assert.deepEqual(meta.checkpoint, row.expected.checkpoint); assert.deepEqual(meta.owner, row.owner);
        assert.match(row.ownerClaim, /^[a-f0-9]{64}$/); assert.equal(meta.ownerClaim, row.ownerClaim);
        assert.equal(meta.initialized, true); assert.equal(meta.pending, false); assert.equal(meta.gap, false); assert.equal(meta.rollback, false);
    }
    if (success) {
        assert.ok(data.length > 0, 'Successful native read requires an actual data command');
        const last = data.at(-1), reply = all.find(row => row.event === 'succeeded' && row.requestId === last.requestId && row.client === last.client);
        assert.equal(reply?.cursor, '0', 'Successful complete read lacks actual native cursor exhaustion');
    }
    return {dataAttempts: data.length, replyBsonBytes: all.filter(row => row.event === 'succeeded')
        .reduce((sum, row) => sum + row.replyBsonBytes, 0)};
}
