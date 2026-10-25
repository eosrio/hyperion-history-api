/** Native parent IPC for the explicit reader-fault fixture. JSON replies are observations, never runtime grants. */
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {durableRecoveryFile} from './recovery-custody.mjs';
import {captureOwnedReader, describeOwnedReaderCensus, terminateOwnedReader, describeOwnedReaderExit} from './owned-reader-process.mjs';

export function installWireReaderRecoveryHost(control, getHeld, record) {
    assert.equal(process.env.HYPERION_PORTABLE_NATIVE_QUALIFICATION, '1');
    assert.equal(process.env.ES198_CPU_PROFILE, '0'); assert.equal(typeof process.send, 'function');
    let snapshotId, token, census, fault, terminating = false, released = false, requests = 0, replacementPid;
    const original = () => {
        const held = getHeld(); assert.ok(held, 'selected original RPC is not held');
        assert.equal(held.master.shutdownStarted, false);
        return held;
    };
    const status = () => {
        const held = original(), master = held.master, current = master.liveReader?.wref, source = master.protocolAbiSource;
        const lib = master.actionCanonicalLib, coordinator = master.protocolAbiCoordinator;
        const ready = current && current !== held.reader && current.isConnected() && !current.isDead()
            && source?.worker === current && source.readerSessionId !== held.readerSessionId && source.generation
            && source.generation !== held.generation && coordinator === held.coordinator
            && coordinator.retainSourceFence(source.readerSessionId, source.generation)()
            && lib?.worker === current && lib.blockNum >= control.resumeBlockNum;
        const replacement = ready ? {pid: current.process.pid, readerId: current.id,
            readerSessionId: source.readerSessionId, generation: source.generation, libBlockNum: lib.blockNum, libBlockId: lib.blockId} : null;
        if (replacement && replacementPid !== replacement.pid) {replacementPid = replacement.pid; record('replacement-reader', {snapshotId, replacement});}
        return {masterPid: process.pid, oldReaderPid: held.reader.process.pid, held: !released,
            terminated: !!fault, replacement, rejected: held.rejected ?? null};
    };
    process.on('message', async message => {
        if (message?.event !== 'qualifier_reader_request') return;
        const reply = (ok, value) => {
            if (!process.connected) return;
            const envelope = {event: 'qualifier_reader_reply', mId: message.mId, runId: control.runId,
                operation: message.operation, pid: process.pid, parentPid: process.ppid, ok,
                ...(ok ? {value} : {error: value})};
            assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 128 * 1024);
            process.send(envelope, error => {if (error) record('controller-transport-error', {message: error.message.slice(0, 4096)});});
        };
        try {
            assert.ok(++requests <= 1024, 'reader control request budget exceeded');
            assert.match(message.mId, /^[0-9a-f-]{36}$/); assert.equal(message.runId, control.runId);
            assert.ok(['snapshot', 'terminate', 'status', 'release'].includes(message.operation));
            assert.deepEqual(Object.keys(message).sort(), ['event', 'mId', 'runId', 'operation',
                ...(message.operation === 'snapshot' ? [] : ['snapshotId'])].sort());
            const held = original();
            if (message.operation === 'snapshot') {
                assert.equal(snapshotId, undefined, 'original reader snapshot already issued');
                assert.equal(held.master.liveReader?.wref, held.reader);
                assert.equal(held.master.protocolAbiSource, held.source); assert.equal(held.master.protocolAbiCoordinator, held.coordinator);
                assert.equal(held.source.readerSessionId, held.readerSessionId); assert.equal(held.source.generation, held.generation);
                assert.equal(held.source.worker, held.reader); assert.equal(held.master.actionCanonicalLib?.worker, held.reader);
                const title = `${control.titlePrefix}-${control.readerRole}:${held.reader.id}`;
                token = captureOwnedReader(held.reader, control.output, title); census = describeOwnedReaderCensus(token);
                snapshotId = message.mId;
                const value = {kind: 'held-reader-rpc', masterPid: process.pid, readerId: held.reader.id,
                    readerSessionId: held.readerSessionId, generation: held.generation,
                    readBlockNum: held.readBlockNum, response: structuredClone(held.response), end: held.end, census};
                durableRecoveryFile(join(control.output, 'reader-recovery/snapshot.json'), {snapshotId, ...value});
                record('reader-snapshot', {snapshotId, ...value}); reply(true, value); return;
            }
            assert.ok(snapshotId && message.snapshotId === snapshotId, 'foreign reader snapshot');
            if (message.operation === 'terminate') {
                assert.equal(terminating, false, 'reader fault already attempted'); terminating = true;
                const receipt = await terminateOwnedReader(token); fault = describeOwnedReaderExit(receipt);
                assert.deepEqual(fault.reader, census.reader);
                durableRecoveryFile(join(control.output, 'reader-recovery/fault.json'), {schemaVersion: 1,
                    runId: control.runId, snapshotId, masterPid: process.pid, fence: fault});
                record('reader-exited', {snapshotId, fence: fault}); reply(true, fault); return;
            }
            if (message.operation === 'status') {reply(true, status()); return;}
            assert.ok(fault && !released, 'reader fault has not completed or RPC already released');
            assert.ok(status().replacement, 'replacement reader source and LIB are not current');
            released = true; record('rpc-released', {snapshotId, readBlockNum: held.readBlockNum}); held.release();
            reply(true, {released: true});
        } catch (error) {
            const reason = error instanceof Error ? error.message.slice(0, 4096) : 'Reader fault control unavailable';
            record('controller-rejected', {operation: message.operation, reason}); reply(false, reason);
        }
    });
}
