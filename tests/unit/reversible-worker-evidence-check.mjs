/** Read-only verification of a saved native component observation. Never executes evidence content. */
import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ActionSourceAdmissionStore} from '../../build/indexer/history/action-source-admission.js';
import {ActionHistorySourceJournal} from '../../build/indexer/history/action-source-journal.js';
import {ImmutableProtocolBundleStore} from '../../build/indexer/protocol/immutable-bundle-store.js';
import {ProtocolSourceBindingStore} from '../../build/indexer/protocol/source-bindings.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export async function checkReversibleWorkerEvidence(path) {
    assert(statSync(path).size <= 64 * 1024 * 1024);
    const bytes = readFileSync(path), envelope = JSON.parse(bytes);
    assert.equal(envelope.schemaVersion, 2); assert.equal(envelope.encoding, 'interned-json-strings-v1');
    const texts = new Map(), usedTexts = new Set(), paths = new Set();
    for (const entry of envelope.strings) {
        assert.match(entry.id, /^[0-9a-f]{64}$/); assert(!texts.has(entry.id));
        assert.equal(Buffer.byteLength(entry.value), entry.bytes); assert.equal(hash(entry.value), entry.id);
        texts.set(entry.id, entry.value);
    }
    function location(path) {
        assert(Array.isArray(path) && path.length > 0 && path.length <= 64);
        let parent = envelope.data;
        for (const key of path.slice(0, -1)) {assert(parent && Object.hasOwn(parent, key)); parent = parent[key];}
        const key = path.at(-1); assert(parent && Object.hasOwn(parent, key)); return {parent, key};
    }
    for (const reference of envelope.references) {
        const encodedPath = JSON.stringify(reference.path); assert(!paths.has(encodedPath)); paths.add(encodedPath);
        assert(texts.has(reference.id)); usedTexts.add(reference.id);
        const {parent, key} = location(reference.path); assert.equal(parent[key], null);
    }
    assert.equal(usedTexts.size, texts.size);
    const stringsAt = new Map(envelope.references.map(r => [JSON.stringify(r.path), texts.get(r.id)]));
    const value = path => {
        const {parent, key} = location(path);
        return stringsAt.get(JSON.stringify(path)) ?? parent[key];
    };
    // Restore only stored records; the repeated full IPC transcript remains referenced, within its original budget.
    for (const reference of envelope.references.filter(r => r.path[0] === 'stores')) {
        const {parent, key} = location(reference.path);
        Object.defineProperty(parent, key, {value: texts.get(reference.id), enumerable: true, writable: true, configurable: true});
    }
    const data = envelope.data, report = data.report;
    assert.equal(data.failure, undefined); assert.equal(report.passed, true);
    assert.equal(report.capacityAuthority, false); assert.equal(report.releaseQualified, false);
    assert.equal(data.inputs.frames.length, 34);
    for (let i = 0; i < 34; i++) {
        const frame = data.inputs.frames[i], raw = Buffer.from(value(['inputs', 'frames', i, 'frameHex']), 'hex');
        assert.equal(hash(raw), frame.controlledFrameSha256); assert.equal(frame.originalSha256, frame.capturedReceipt.sha256);
        assert.equal(frame.position.blockId, frame.capturedReceipt.blockId);
    }
    assert.equal(data.processes.length, 4); assert.equal(new Set(data.processes.map(p => p.pid)).size, 4);
    const requests = new Map(), replies = new Map(), acceptedEnds = [];
    for (const process of data.processes) {
        assert.equal(process.exited, true); assert.equal(process.exitCode, 0); assert.equal(process.forcedKill, false);
        assert.equal(process.stderr, '');
        for (const message of process.received) if (message.event === 'qualification_service_request') {
            assert(!requests.has(message.id)); requests.set(message.id, process.name);
        }
        for (const message of process.sent) {
            if (message.event === 'qualification_service_reply') {
                assert(!replies.has(message.id)); replies.set(message.id, process.name);
            }
            if (message.event === 'worker_attempt_reply' && message.result?.ok && message.result.end) acceptedEnds.push(message.result.end);
        }
    }
    assert.equal(requests.size, replies.size); assert.equal(requests.size, data.storageRequests.length);
    for (const [id, owner] of requests) assert.equal(replies.get(id), owner);
    assert.equal(acceptedEnds.length, data.ends.length);
    for (const end of data.ends) assert(acceptedEnds.some(e => e.incarnation === end.incarnation && e.attemptId === end.attemptId
        && JSON.stringify(e) === JSON.stringify(end)), 'End description lacks its exact original native parent reply');
    const memory = frontierMemoryClient(1);
    for (const field of ['documents', 'mappings', 'settings', 'sequences']) for (const [id, value] of data.stores[field]) memory[field].set(id, value);
    memory.client.indices.exists = async ({index}) => memory.settings.has(index);
    const noWrite = async () => {assert.fail('Cold inspection attempted a write');};
    memory.client.create = noWrite; memory.client.index = noWrite; memory.client.indices.create = noWrite;
    const store = new ActionSourceAdmissionStore(memory.client, 'reversible-worker-original', 1);
    // Admission's constructor has no read-only option. Its existing lower-level readers do;
    // use those capabilities only for cold inspection, retaining every typed-record validator.
    store.bundles = new ImmutableProtocolBundleStore(memory.client, 'reversible-worker-original', 1,
        'action-source-admission', 'history-source-admission-v1', undefined, {readOnly: true});
    store.journal = new ActionHistorySourceJournal(memory.client, 'reversible-worker-original', 1, {readOnly: true});
    const recovered = report.revoked?.recoveredOriginalDelivery;
    if (report.revoked) assert(recovered, 'Revocation evidence lacks recovery of its original delivery');
    const associations = [report.associationId, ...(report.revoked ? [recovered.associationId, report.revoked.redelivery.associationId] : [])];
    assert.equal(new Set(associations).size, associations.length);
    for (const id of associations) {
        const observed = (await store.readAttemptAssociation(id)).observation;
        assert.equal(observed.sourceChecked, true); assert.equal(observed.brokerSettlement, 'unknown');
        const originalEnd = acceptedEnds.find(e => e.incarnation === observed.end.incarnation && e.attemptId === observed.end.attemptId);
        assert(originalEnd, 'Retained association lacks its original native end reply');
        assert.deepEqual(observed.end, originalEnd, 'Retained association end differs from its exact original native reply');
        assert.equal(observed.results.length, 1);
    }
    if (report.revoked) {
        assert(report.revoked.pendingAtFence >= 1);
        assert.equal(report.revoked.oldEnd.rootResult, 'threw'); assert.equal(report.revoked.oldEnd.acknowledgementAttempted, false);
        const old = report.revoked.oldEnd, admission = await store.resolve(old.binding.admissionId);
        const transaction = admission.inventory.transactions.find(t => t.traceOrdinal === old.binding.traceOrdinal);
        const retained = await store.readConfirmedHandoff(admission.id, old.binding.traceOrdinal, Buffer.from(transaction.dispatch.canonicalJson));
        assert.equal(retained.id, old.freshWrites[0].id);
        assert.equal(recovered.end.binding.blockNum, old.binding.blockNum);
        assert.equal(recovered.end.binding.blockId, old.binding.blockId);
        assert.notEqual(recovered.end.incarnation, old.incarnation); assert.notEqual(recovered.end.attemptId, old.attemptId);
        assert.equal(recovered.end.rootResult, 'returned'); assert.equal(recovered.end.acknowledgementAttempted, true);
        assert.equal(recovered.end.binding.selectionId, recovered.currentSourceSelectionId);
        assert.notEqual(recovered.currentSourceSelectionId, recovered.originalSourceSelectionId);
        const sources = new ProtocolSourceBindingStore(memory.client, 'reversible-worker-original', 1, {readOnly: true});
        const originalSelection = (await sources.readSelection(recovered.originalSourceSelectionId)).selection;
        const currentSelection = (await sources.readSelection(recovered.currentSourceSelectionId)).selection;
        assert.deepEqual(currentSelection.source, originalSelection.source);
        assert.equal(currentSelection.captureSha256, originalSelection.captureSha256);
        assert.equal(currentSelection.readerSessionId, report.revoked.replacement.readerSessionId);
        assert.notEqual(currentSelection.readerSessionId, originalSelection.readerSessionId);
        const recoveredAdmission = await store.resolve(recovered.end.binding.admissionId);
        assert.equal(recoveredAdmission.source.schemaVersion, 2);
        assert.equal((await store.journal.readPlan(recoveredAdmission.planId)).plan.source.retainedSourceId, recoveredAdmission.sourceId);
        assert.notEqual(recoveredAdmission.planId, admission.planId);
        assert.equal(recoveredAdmission.source.captureSha256, admission.source.captureSha256);
        const recoveredTransaction = recoveredAdmission.inventory.transactions.find(t => t.traceOrdinal === recovered.end.binding.traceOrdinal);
        const recoveredHandoff = await store.readConfirmedHandoff(recoveredAdmission.id, recovered.end.binding.traceOrdinal,
            Buffer.from(recoveredTransaction.dispatch.canonicalJson));
        assert.equal(recoveredHandoff.id, recovered.end.freshWrites[0].id);
        for (const id of associations) {
            const observed = (await store.readAttemptAssociation(id)).observation;
            assert.notEqual(observed.end.attemptId, old.attemptId);
        }
    }
    const readerIndex = data.processes.findIndex(p => p.role === 'continuous_reader'); assert(readerIndex >= 0);
    const originalFrames = new Map(data.inputs.frames.map(frame => [frame.controlledFrameSha256, frame.number]));
    const observedFrames = [], requestedStarts = [];
    for (const [messageIndex, message] of data.processes[readerIndex].sent.entries()) {
        if (message.event !== 'qualification_command' || message.input.operation !== 'frame') continue;
        const frame = Buffer.from(value(['processes', readerIndex, 'sent', messageIndex, 'input', 'frameHex']), 'hex');
        const number = originalFrames.get(hash(frame)); assert(number !== undefined); observedFrames.push(number);
    }
    for (const message of data.processes[readerIndex].received) if (message.event === 'qualification_ship_request'
        && message.request[0] === 'get_blocks_request_v0') requestedStarts.push(message.request[1].start_block_num);
    const prefix = Array.from({length: 33}, (_, index) => index + 1);
    assert.deepEqual(observedFrames, data.mode === 'baseline' ? prefix : [...prefix, ...prefix, 34]);
    assert.deepEqual(requestedStarts, data.mode === 'baseline' ? [1] : [1, 1]);
    return {passed: true, mode: data.mode, bytes: bytes.length, sha256: hash(bytes),
        strings: texts.size, references: paths.size, originalFrames: 34, nativeProcesses: 4,
        originalServiceRequestsAndReplies: requests.size, authenticEndReplies: acceptedEnds.length,
        typedAssociationsRead: associations.length, originalDeliveryRecovered: !!recovered,
        originalFrameDeliveries: observedFrames.length, requestedStarts, coldWrites: 0, capacityAuthority: false, releaseQualified: false};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await checkReversibleWorkerEvidence(process.argv[2])));
