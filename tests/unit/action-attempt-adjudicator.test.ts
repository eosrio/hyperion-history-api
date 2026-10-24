import {expect, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {createHash, randomUUID} from 'node:crypto';
import {WorkerAttemptSupervisor, type AcceptedWorkerAttemptEnd} from '../../src/indexer/protocol/worker-attempt-supervisor.js';
import {WorkerAttemptClient} from '../../src/indexer/protocol/worker-attempt-client.js';
import {ActionAttemptAdjudicator} from '../../src/indexer/history/action-attempt-adjudicator.js';
import {issueFreshActionWrite} from '../../src/indexer/history/action-fresh-write.js';
import {actionHistoryImmutableJson} from '../../src/indexer/history/action-history-manifest.js';
import {ImmutableProtocolBundleStore} from '../../src/indexer/protocol/immutable-bundle-store.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

function link(supervisor: WorkerAttemptSupervisor) {
    const physical = new EventEmitter() as any, transport = new EventEmitter() as any;
    physical.isConnected = () => true;
    physical.send = (message: any, callback?: (error: Error | null) => void) => {transport.emit('message', structuredClone(message)); callback?.(null);};
    transport.send = (message: any, callback?: (error: Error | null) => void) => {physical.emit('message', structuredClone(message)); callback?.(null);};
    supervisor.attach(physical, 'deserializer');
    return {physical, client: new WorkerAttemptClient({mode: 'managed', role: 'deserializer', transport, timeoutMs: 100, retries: 0})};
}

test('a redelivery end cannot borrow the prior attempt fresh write for identical semantic work', async () => {
    const end: AcceptedWorkerAttemptEnd[] = [], supervisor = new WorkerAttemptSupervisor({onEnd: value => end.push(value)});
    const first = link(supervisor), redelivery = link(supervisor), blockId = 'b'.repeat(64), chainId = 'c'.repeat(64),
        config = 'd'.repeat(64), target = {name: 'fixture-action-v1-000001', uuid: 'target-uuid'},
        admissionId = 'h45actionadmission1:' + 'a'.repeat(64), sourceId = 'h45actionsource1:' + '1'.repeat(64),
        planId = 'h45actionplan1:' + '2'.repeat(64), ingressId = 'h45actioningress1:' + '3'.repeat(64),
        dispositionId = 'h45actionattempt1:' + '4'.repeat(64);
    const frame = Buffer.from('original-source-frame'), previousBlockId = 'a'.repeat(64),
        captureSha256 = '5'.repeat(64), executableSha256 = '6'.repeat(64), policySha256 = '7'.repeat(64);
    const producer = {protocolId: 'antelope', profileId: 'antelope-default-v1', codeRevision: '0'.repeat(40),
        configurationSha256: config, pluginsSha256: '8'.repeat(64)};
    const work = {stage: 'main-source', admissionId, sourceId, ingressId, planId, target, producer,
        executableSha256, policySha256, sourceSelectionId: null, transaction: null,
        source: {chainId, blockNum: 33, blockId, previousBlockId, captureSha256}};
    const observation = {kind: 'action-attempt-disposition', disposition: 'no-effects', work};
    const admission: any = {id: admissionId, sourceId, planId, target,
        inventory: {sourceSelectionId: null, policySha256, transactions: []},
        source: {ingressId, frameHex: frame.toString('hex'), previousBlockId, captureSha256,
            executableSha256, producer, inventoryInput: {source: {chainId, blockNum: 33, blockId}, policy: {}}}};
    const associations: unknown[] = [];
    let storageUnavailable = false, currentConfig = config, currentTarget = target.uuid;
    let currentBlock = {chainId, blockId, previousBlockId, irreversible: true};
    const store: any = {resolve: async () => admission, readAttemptDisposition: async () => ({id: dispositionId, observation}),
        recordAttemptAssociation: async (_supervisor: unknown, _evidence: unknown, association: unknown) => {
            if (storageUnavailable) throw new Error('controlled association storage unavailable');
            associations.push(association); return {id: 'private-association'};
        }};
    const authority = {configurationSha256: () => currentConfig,
        canonicalBlock: async () => currentBlock,
        targetUuid: async () => currentTarget};
    const adjudicator = new ActionAttemptAdjudicator(supervisor, store, {} as any, authority);
    const bundles = new ImmutableProtocolBundleStore(frontierMemoryClient().client as any, 'adjudication-fixture', 0,
        'action-source-admission', 'history-source-admission-v1');
    const descriptor = () => ({kind: 'source-delivery' as const, receiptId: randomUUID(),
        payloadSha256: createHash('sha256').update(frame).digest('hex'), headersSha256: 'f'.repeat(64), consumerId: randomUUID(),
        publisherId: randomUUID(), queue: 'fixture:source', deliveryTag: 1});
    const binding = {admissionId, planId, ingressId, blockNum: 33, blockId, configurationSha256: config,
        targetName: target.name, targetUuid: target.uuid};
    const a = first.client.capture(descriptor()), b = redelivery.client.capture(descriptor());
    await first.client.run(a, async () => {
        await first.client.bindCurrent(binding);
        const proof = await bundles.prepare(dispositionId, {schemaVersion: 1, payloadJson: actionHistoryImmutableJson(observation)});
        const result = issueFreshActionWrite({id: dispositionId}, 'attempt-disposition', dispositionId, observation, proof, bundles);
        expect(await first.client.observeFreshActionWrite(result)).toBe(true);
        first.client.markAcknowledgementAttempt();
    });
    await redelivery.client.run(b, async () => {
        await redelivery.client.bindCurrent(binding);
        redelivery.client.markAcknowledgementAttempt();
    });
    expect(end).toHaveLength(2);
    expect(await adjudicator.adjudicate(end[1])).toEqual({state: 'unresolved'});
    expect(associations).toHaveLength(0);
    currentConfig = '0'.repeat(64);
    expect(await adjudicator.adjudicate(end[0])).toEqual({state: 'unresolved'});
    currentConfig = config; currentTarget = 'replaced-target';
    expect(await adjudicator.adjudicate(end[0])).toEqual({state: 'unresolved'});
    currentTarget = target.uuid; currentBlock = {...currentBlock, blockId: '0'.repeat(64)};
    expect(await adjudicator.adjudicate(end[0])).toEqual({state: 'unresolved'});
    currentBlock = {chainId, blockId, previousBlockId, irreversible: false};
    expect(await adjudicator.adjudicate(end[0])).toEqual({state: 'unresolved'});
    currentBlock = {chainId, blockId, previousBlockId, irreversible: true};
    expect(associations).toHaveLength(0);
    observation.work.ingressId = 'h45actioningress1:' + '0'.repeat(64);
    expect(await adjudicator.adjudicate(end[0])).toEqual({state: 'unresolved'});
    observation.work.ingressId = ingressId;
    admission.source.frameHex = Buffer.from('different-original-receipt').toString('hex');
    expect(await adjudicator.adjudicate(end[0])).toEqual({state: 'unresolved'});
    admission.source.frameHex = frame.toString('hex');
    storageUnavailable = true;
    await expect(adjudicator.adjudicate(end[0])).rejects.toThrow('controlled association storage unavailable');
    expect(associations).toHaveLength(0);
    storageUnavailable = false;
    expect(await adjudicator.adjudicate(end[0])).toEqual({state: 'associated', id: 'private-association'});
    expect(associations).toHaveLength(1);
    first.client.dispose(); redelivery.client.dispose();
});

test('a reversible Wire attempt needs the current admitted source selection before private association', async () => {
    const ends: AcceptedWorkerAttemptEnd[] = [], supervisor = new WorkerAttemptSupervisor({onEnd: value => ends.push(value)});
    const worker = link(supervisor), chainId = 'c'.repeat(64), blockId = 'b'.repeat(64), previousBlockId = 'a'.repeat(64),
        captureSha256 = '5'.repeat(64), selectionId = 'h45srcsel1:' + '9'.repeat(64), readerSessionId = 'reader-session',
        admissionId = 'h45actionadmission1:' + 'a'.repeat(64), sourceId = 'h45actionsource1:' + '1'.repeat(64),
        ingressId = 'h45actioningress1:' + '3'.repeat(64), planId = 'h45actionplan1:' + '2'.repeat(64),
        dispositionId = 'h45actionattempt1:' + '4'.repeat(64), config = 'd'.repeat(64),
        target = {name: 'fixture-action-v1-000001', uuid: 'target-uuid'}, frame = Buffer.from('original-Wire-frame');
    const producer = {protocolId: '@eosrio/hyperion-wire-plugin', profileId: 'wire-fixture', codeRevision: '0'.repeat(40),
        configurationSha256: config, pluginsSha256: '8'.repeat(64)};
    const source = {chainId, blockNum: 33, blockId, previousBlockId};
    const work = {stage: 'main-source', admissionId, sourceId, ingressId, planId, target, producer,
        executableSha256: '6'.repeat(64), policySha256: '7'.repeat(64), sourceSelectionId: selectionId, transaction: null,
        source: {...source, captureSha256}};
    const observation = {kind: 'action-attempt-disposition', disposition: 'source-unprocessable', reason: 'source-traces-missing',
        work, output: {kind: 'unresolved'}};
    const admission: any = {id: admissionId, sourceId, planId, target,
        inventory: {sourceSelectionId: selectionId, policySha256: work.policySha256, transactions: []},
        source: {ingressId, frameHex: frame.toString('hex'), previousBlockId, captureSha256,
            executableSha256: work.executableSha256, producer,
            inventoryInput: {source: {chainId, blockNum: 33, blockId}, sourceSelectionId: selectionId, policy: {}}}};
    const associations: unknown[] = [], calls: unknown[] = [];
    const store: any = {resolve: async () => admission,
        readAttemptDisposition: async () => ({id: dispositionId, observation}),
        recordAttemptAssociation: async (_supervisor: unknown, _evidence: unknown, association: unknown) => {
            associations.push(association); return {id: 'reversible-association'};
        }};
    const selections: any = {readSelection: async (id: string) => {
        expect(id).toBe(selectionId);
        return {selection: {source, captureSha256, readerSessionId}};
    }};
    let admitted = false;
    const authority = {configurationSha256: () => config, targetUuid: async () => target.uuid,
        canonicalBlock: async () => ({chainId, blockId, previousBlockId, irreversible: false}),
        reversibleSelection: async (id: string, position: typeof source, session: string) => {
            calls.push({id, position, session}); return admitted;
        }};
    const adjudicator = new ActionAttemptAdjudicator(supervisor, store, selections, authority);
    const bundles = new ImmutableProtocolBundleStore(frontierMemoryClient().client as any, 'reversible-fixture', 0,
        'action-source-admission', 'history-source-admission-v1');
    const handle = worker.client.capture({kind: 'source-delivery', receiptId: randomUUID(),
        payloadSha256: createHash('sha256').update(frame).digest('hex'), headersSha256: 'f'.repeat(64),
        consumerId: randomUUID(), publisherId: randomUUID(), queue: 'fixture:source', deliveryTag: 1});
    await worker.client.run(handle, async () => {
        await worker.client.bindCurrent({selectionId, readerSessionId, admissionId, planId, ingressId,
            blockNum: 33, blockId, configurationSha256: config, targetName: target.name, targetUuid: target.uuid});
        const proof = await bundles.prepare(dispositionId, {schemaVersion: 1, payloadJson: actionHistoryImmutableJson(observation)});
        const result = issueFreshActionWrite({id: dispositionId}, 'attempt-disposition', dispositionId, observation, proof, bundles);
        expect(await worker.client.observeFreshActionWrite(result)).toBe(true);
        worker.client.markAcknowledgementAttempt();
    });
    expect(ends).toHaveLength(1);
    expect(await adjudicator.adjudicate(ends[0])).toEqual({state: 'unresolved'});
    expect(associations).toHaveLength(0);
    admitted = true;
    expect(await adjudicator.adjudicate(ends[0])).toEqual({state: 'associated', id: 'reversible-association'});
    expect(calls).toEqual([{id: selectionId, position: source, session: readerSessionId},
        {id: selectionId, position: source, session: readerSessionId}]);
    expect(associations).toHaveLength(1);
    worker.client.dispose();
});
