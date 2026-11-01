/** Actual emitted source boundary over the existing retained Wire/coordinator fixture; no services. */
import assert from 'node:assert/strict';
import {nativeApiWireSource, STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE} from './protocol-native-api-source.mjs';
import {PortableProjectionSource} from '../../build/indexer/projection/source.js';
import {ProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';
assert.equal(process.versions.bun, undefined); assert.match(process.version, /^v(?:24|26)\./);
const prepared = await nativeApiWireSource({nativeMarker: false, engineeringSourceProfile: STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE});
try {
    await prepared.appendUntil(2);
    const source = new PortableProjectionSource({client: prepared.client, chain: prepared.chain,
        chainId: prepared.chainId, profile: prepared.profile, provider: prepared.provider});
    prepared.memory.calls.length = 0;
    const admitted = [], packet = await source.originalBlock(2, async target => {admitted.push(target);});
    assert.equal(admitted.length, 1); assert.equal(packet.target, admitted[0]);
    assert.equal(packet.target.block.blockId, prepared.retained.get(2).source.blockId);
    assert.equal(packet.target.reference.commitId, packet.proof.commitId);
    assert.equal(packet.target.reference.selectionId, prepared.retained.get(2).selectionId);
    assert.deepEqual(Object.keys(packet.target.reference).sort(), ['commitId', 'observationDigest', 'observationId', 'selectionId']);
    assert.equal(Object.isFrozen(packet.target.reference), true);
    assert.equal(packet.observation.capture.schemaJson, packet.context.schemaJson);
    assert.ok(packet.observation.capture.blockHex); assert.notEqual(packet.observation.capture.tracesHex, null);
    assert.notEqual(packet.observation.capture.deltasHex, null);
    assert.equal(Object.hasOwn(packet, 'view'), false);
    assert.equal(Object.hasOwn(packet, 'ready'), false);
    assert.equal(prepared.memory.calls.some(call => ['createIndex', 'create', 'index'].includes(call.method)), false);

    const unknown = new Error('raw target admission acknowledgement unknown'); let atAdmission;
    await assert.rejects(source.originalBlock(2, async () => {
        atAdmission = prepared.memory.calls.length; throw unknown;
    }), error => error === unknown);
    assert.equal(prepared.memory.calls.length, atAdmission);

    const removed = []; let missingTarget;
    await assert.rejects(source.originalBlock(2, async target => {
        missingTarget = target;
        for (const [key, entry] of prepared.memory.documents) if (entry.document.bundle_id === target.reference.selectionId) {
            removed.push([key, entry]); prepared.memory.documents.delete(key);
        }
    }));
    assert.equal(missingTarget.reference.selectionId, packet.target.reference.selectionId);
    assert.ok(removed.length); assert.equal(Object.hasOwn(missingTarget.reference, 'captureSha256'), false);
    assert.equal(Object.hasOwn(missingTarget.reference, 'frameSha256'), false);
    for (const [key, entry] of removed) prepared.memory.documents.set(key, entry);

    const openingScope = new ProofConsumerScope('raw-target-fenced-before-admission');
    const open = source.open; let forbiddenAdmissions = 0, readsBeforeFence;
    source.open = async function(...args) {
        const proof = await open.apply(this, args); readsBeforeFence = prepared.memory.calls.length;
        openingScope.fence(); return proof;
    };
    try {
        await assert.rejects(openingScope.run(() => source.originalBlock(2, async () => {forbiddenAdmissions++;})),
            error => openingScope.ownsFenceError(error));
        assert.equal(forbiddenAdmissions, 0); assert.equal(prepared.memory.calls.length, readsBeforeFence);
    } finally {source.open = open; await openingScope.closeAndDrain();}

    const admissionScope = new ProofConsumerScope('raw-target-held-admission');
    let releaseAdmission, announceAdmission, drainCompleted = false;
    const heldAdmission = new Promise(resolve => {releaseAdmission = resolve;});
    const enteredAdmission = new Promise(resolve => {announceAdmission = resolve;});
    const heldWork = admissionScope.run(() => source.originalBlock(2, async () => {
        announceAdmission(); await heldAdmission;
    }));
    await enteredAdmission;
    const readsAtHeldAdmission = prepared.memory.calls.length;
    const drain = admissionScope.closeAndDrain().then(() => {drainCompleted = true;});
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(drainCompleted, false); assert.ok(admissionScope.snapshot().pendingOperations > 0);
    } finally {releaseAdmission();}
    await assert.rejects(heldWork, error => admissionScope.ownsFenceError(error));
    await drain; assert.equal(prepared.memory.calls.length, readsAtHeldAdmission);
    assert.equal(admissionScope.snapshot().state, 'drained');

    await assert.rejects(source.originalBlock(2, async () => {
        await prepared.coordinator.revokeSource('native-api-original-reader');
    }), error => error.code === 'projection_source_unavailable');
    console.log(JSON.stringify({passed: true, node: process.version, cases: 6,
        actualEmittedSource: true, originalWireFrames: 2, existingCoordinatorAndJournals: true,
        controlledElasticsearchTransport: true, beforeSelectionAdmission: true, missingSelectionRefused: true,
        unknownAdmissionStopsReads: true, revokedOwnerRefused: true, services: false,
        fencedBeforeAdmissionRefused: true, heldAdmissionPhysicallyDrained: true,
        durableRawAdmission: false, productionCompoundOwner: false, fullParity: false}));
} finally {await prepared.dispose();}
