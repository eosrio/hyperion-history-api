// Pure verifier regression using verbatim selected records from actual failed Linux CI.
// No database, controller, child process, native module or service is imported.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {verifyReadTrace, sha} from './contract.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/cleanup-trace-f0.json', import.meta.url)));
const commands = rows => rows.filter(row => row.event === 'started');

test('the previous verifier source is retained exactly as non-executable evidence', () => {
    const manifest = JSON.parse(readFileSync(new URL('./fixtures/contract-f0-manifest.json', import.meta.url)));
    const bytes = readFileSync(new URL('./fixtures/' + manifest.snapshot, import.meta.url));
    assert.equal(manifest.executable, false); assert.equal(bytes.length, manifest.bytes); assert.equal(sha(bytes), manifest.sha256);
});

for (const captured of fixture.cases) {
    test('actual Node' + captured.node + ' read/cleanup trace keeps snapshot data and successful original-cursor closure', () => {
        const rows = captured.events, starts = commands(rows), kill = starts.at(-1), reply = rows.at(-1);
        assert.equal(kill.command, 'killCursors'); assert.equal(reply.event, 'succeeded'); assert.equal(reply.requestId, kill.requestId);
        assert.equal(kill.readConcern, null); assert.equal(kill.atClusterTime, null); assert.equal(kill.maxTimeMS, null);
        assert.equal(reply.cursorClosure.cursorsKilled.length, 1);
        const result = verifyReadTrace(rows, fixture.phase, {maximum: starts.length, attempts: starts.length});
        assert.equal(result.attempts, 14, 'The real cleanup consumes the unchanged native attempt allowance');
        assert.throws(() => verifyReadTrace(rows, fixture.phase, {maximum: starts.length - 1}));
        assert.throws(() => verifyReadTrace(rows, fixture.phase, {maximum: starts.length, attempts: starts.length - 1}));
        assert.throws(() => verifyReadTrace(rows, fixture.phase, {maximum: starts.length, success: true}),
            'A failed/incomplete read cannot turn into a complete result because cleanup succeeds');
        const notFound = structuredClone(rows), closure = notFound.at(-1).cursorClosure;
        closure.cursorsNotFound = closure.cursorsKilled; closure.cursorsKilled = [];
        assert.equal(verifyReadTrace(notFound, fixture.phase, {maximum: starts.length}).attempts, starts.length);
    });

    test('Node' + captured.node + ' read stamp, cleanup identity and cursor faults remain refused', () => {
        const mutations = [
            rows => {rows[1].snapshotTime = null;},
            rows => {commands(rows)[1].atClusterTime = null;},
            rows => {commands(rows)[1].atClusterTime = 'different';},
            rows => {commands(rows)[1].readConcern = 'majority';},
            rows => {commands(rows).find(row => row.command === 'getMore').cursor = 'foreign';},
            rows => {commands(rows).at(-1).lsid = 'foreign';},
            rows => {commands(rows).at(-1).traceId = 'foreign';},
            rows => {commands(rows).at(-1).client = 'foreign';},
            rows => {commands(rows).at(-1).collection = 'foreign';},
            rows => {commands(rows).at(-1).readConcern = 'snapshot';},
            rows => {commands(rows).at(-1).atClusterTime = 'timestamp';},
            rows => {commands(rows).at(-1).maxTimeMS = 1;},
            rows => {rows.at(-1).cursorClosure.cursorsKilled = ['foreign'];},
            rows => {rows.at(-1).cursorClosure.cursorsKilled = [];},
            rows => {rows.at(-1).cursorClosure.cursorsKilled.push(rows.at(-1).cursorClosure.cursorsKilled[0]);},
            rows => {rows.at(-1).cursorClosure.cursorsAlive = ['live'];},
            rows => {rows.at(-1).cursorClosure.cursorsUnknown = ['unknown'];},
            rows => {rows.at(-1).event = 'failed'; delete rows.at(-1).cursorClosure;},
            rows => {rows.pop();},
        ];
        for (const mutate of mutations) {
            const rows = structuredClone(captured.events); mutate(rows);
            assert.throws(() => verifyReadTrace(rows, fixture.phase, {maximum: commands(captured.events).length}));
        }
    });
}
