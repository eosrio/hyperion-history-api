import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {connect, type Channel, type ChannelModel, type ConfirmChannel, type GetMessage, type Message} from 'amqplib';
import {assertDurableBulkAcknowledged, assertNativePressureRejection} from './es955-pressure.ts';

type Document = {id: string; source: {global_sequence: number | string; block_num: number; payload: string}; sha256: string};
type Options = {client: any; index: string; chain: string; brokerUrl: string; assertOwned: () => Promise<void>};
type Settlement = {case: string; channel: string; method: string; id?: string; deliveryTag?: number; multiple?: boolean; requeue?: boolean};
type Receipt = {case: string; requestId: string; ids: string[]; requestBytes: number; elapsedMs: number;
    statusCode: number; body: any; headers: any};
const requestTimeoutMs = 15_000;
const pressureCount = 640;
const retryChunkSize = 8;
const maxRequestBytes = 3 * 1024 * 1024;
const maxTotalRequestBytes = 8 * 1024 * 1024;

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} exceeded ${requestTimeoutMs} ms`)), requestTimeoutMs);
        })]);
    } finally { if (timer) clearTimeout(timer); }
}

function makeDocument(sequence: number | string, payload: string): Document {
    const source = {global_sequence: sequence, block_num: 1, payload};
    return {id: String(sequence), source, sha256: createHash('sha256').update(JSON.stringify(source)).digest('hex')};
}

function delivery(message: GetMessage) {
    return {id: message.properties.messageId, deliveryTag: message.fields.deliveryTag,
        redelivered: message.fields.redelivered, contentSha256: createHash('sha256').update(message.content).digest('hex')};
}

/** Exercise the built ingestion route against real ES receipts and real AMQP delivery tags. */
export async function runBrokerQualification(options: Options) {
    const {client, index, chain, brokerUrl, assertOwned} = options;
    assert.match(chain, /^hyp-es955-[a-z0-9]{8,32}$/i, 'isolated fixture chain namespace required');
    assert.equal(index, `${chain}-action-v1-000001`, 'broker probe must target its exact owned action partition');
    const address = new URL(brokerUrl);
    assert.equal(address.protocol, 'amqp:', 'the dedicated loopback broker is required');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname), 'refusing a non-loopback broker');
    await assertOwned();
    const settingsResponse = await client.indices.getSettings({index, flat_settings: true, include_defaults: true});
    const settings = {...settingsResponse[index]?.defaults, ...settingsResponse[index]?.settings};
    assert.equal(settings['index.translog.durability'], 'request', 'broker successful receipts require request durability');
    assert.equal(String(settings['index.number_of_replicas']), '1', 'exactly one replica is required');
    const runtimePath = new URL('../../build/indexer/helpers/elastic-routes.js', import.meta.url);
    const {ElasticRoutes} = await import(runtimePath.href);
    const originalBulk = client.bulk;
    const receipts: Receipt[] = [];
    const expectedDocs: Document[] = [];
    const settlementObservations: any[] = [];
    const queueObservations: any[] = [];
    const settlements: Settlement[] = [];
    const publisherConfirms: any[] = [];
    const queueCleanup: any[] = [];
    const queues: string[] = [];
    const openChannels = new Set<Channel>();
    const channelErrors: any[] = [];
    let connection: ChannelModel | undefined;
    let admin: Channel | undefined;
    let publisher: ConfirmChannel | undefined;
    let currentCase = 'initialization';
    let totalRequestBytes = 0;
    let failure: unknown;

    // Preserve the actual client object used by ElasticRoutes; this wrapper only records
    // the original method's real network response and returns its unchanged JSON body.
    client.bulk = async (request: any, suppliedOptions: any = {}) => {
        await assertOwned();
        const operations = request.operations;
        assert.ok(Array.isArray(operations) && operations.length > 0);
        const ids = operations.filter((_: any, position: number) => position % 2 === 0).map((operation: any) => {
            assert.equal(operation.index?._index, index, 'route attempted a write outside its owned index');
            return String(operation.index._id);
        });
        const requestBytes = Buffer.byteLength(operations.map((line: any) => JSON.stringify(line)).join('\n') + '\n');
        assert.ok(requestBytes <= maxRequestBytes, 'broker route request exceeded its byte bound');
        totalRequestBytes += requestBytes;
        assert.ok(totalRequestBytes <= maxTotalRequestBytes, 'broker route exceeded its total write budget');
        const requestId = `${chain}-broker-${receipts.length}`;
        const started = performance.now();
        try {
            const result = await originalBulk.call(client, request, {...suppliedOptions, meta: true, maxRetries: 0,
                requestTimeout: requestTimeoutMs, headers: {...suppliedOptions.headers, 'x-opaque-id': requestId}});
            receipts.push({case: currentCase, requestId, ids, requestBytes, elapsedMs: performance.now() - started,
                statusCode: result.statusCode, body: result.body, headers: result.headers});
            return result.body;
        } catch (error: any) {
            receipts.push({case: currentCase, requestId, ids, requestBytes, elapsedMs: performance.now() - started,
                statusCode: error.meta?.statusCode ?? 0, body: error.meta?.body ?? null, headers: error.meta?.headers ?? {}});
            throw error;
        }
    };

    let routes: any;

    function instrument(channel: Channel, name: string): Channel {
        openChannels.add(channel);
        channel.once('close', () => openChannels.delete(channel));
        channel.on('error', error => channelErrors.push({case: currentCase, channel: name, message: error.message}));
        const ack = channel.ack.bind(channel); const nack = channel.nack.bind(channel);
        const ackAll = channel.ackAll.bind(channel); const nackAll = channel.nackAll.bind(channel);
        channel.ack = (message: Message, multiple = false) => {
            settlements.push({case: currentCase, channel: name, method: 'ack', id: message.properties.messageId,
                deliveryTag: message.fields.deliveryTag, multiple});
            ack(message, multiple);
        };
        channel.nack = (message: Message, multiple = false, requeue = true) => {
            settlements.push({case: currentCase, channel: name, method: 'nack', id: message.properties.messageId,
                deliveryTag: message.fields.deliveryTag, multiple, requeue});
            nack(message, multiple, requeue);
        };
        channel.ackAll = () => { settlements.push({case: currentCase, channel: name, method: 'ackAll'}); ackAll(); };
        channel.nackAll = (requeue = true) => {
            settlements.push({case: currentCase, channel: name, method: 'nackAll', requeue}); nackAll(requeue);
        };
        return channel;
    }

    async function channel(name: string) {
        return instrument(await bounded(connection!.createChannel(), `create ${name} channel`), name);
    }
    async function createQueue(suffix: string) {
        await assertOwned();
        const queue = `${chain}.broker.${suffix}`;
        const response = await bounded(admin!.assertQueue(queue, {durable: true, autoDelete: false,
            arguments: {'x-queue-type': 'classic'}}), 'declare owned qualification queue');
        queues.push(queue);
        assert.equal(response.messageCount, 0, 'owned queue unexpectedly contains earlier messages');
        assert.equal(response.consumerCount, 0, 'owned queue has an unexpected consumer');
        return queue;
    }
    async function publish(queue: string, docs: Document[], sentinelId: string) {
        for (const document of docs) {
            const accepted = publisher!.sendToQueue(queue, Buffer.from(JSON.stringify(document.source)), {
                persistent: true, messageId: document.id, contentType: 'application/json'});
            if (!accepted) await bounded(once(publisher!, 'drain'), 'publisher drain');
        }
        publisher!.sendToQueue(queue, Buffer.from(JSON.stringify({sentinel: sentinelId})), {
            persistent: true, messageId: sentinelId, contentType: 'application/json'});
        await bounded(publisher!.waitForConfirms(), 'persistent publisher confirms');
        publisherConfirms.push({case: currentCase, queue, documents: docs.length, sentinelId,
            totalConfirmed: docs.length + 1, deliveryMode: 2, durableQueue: true});
    }
    async function get(channel: Channel, queue: string, expectedId?: string): Promise<GetMessage> {
        const message = await bounded(channel.get(queue, {noAck: false}), 'get manual-ack delivery');
        assert.ok(message, 'expected a broker delivery');
        if (expectedId !== undefined) assert.equal(message.properties.messageId, expectedId, 'unexpected broker delivery order');
        return message;
    }
    async function ready(channel: Channel, queue: string, count: number) {
        // BasicAck/BasicNack have no reply. Even on this delivery channel, the
        // queue process may apply a requeue after the channel handles QueueDeclare.
        // Observe convergence without changing the required count or IDs.
        const started = performance.now();
        const deadline = started + 5_000;
        const observation = {case: currentCase, queue, expectedCount: count, samples: [] as any[], matched: false};
        queueObservations.push(observation);
        let consecutive = 0;
        while (performance.now() < deadline) {
            const status = await bounded(channel.checkQueue(queue), 'broker settlement barrier');
            observation.samples.push({elapsedMs: performance.now() - started, messageCount: status.messageCount,
                consumerCount: status.consumerCount});
            assert.ok(performance.now() <= deadline, 'broker settlement sample completed after the five-second deadline');
            assert.equal(status.consumerCount, 0, 'unexpected consumer stole a qualification delivery');
            assert.ok(status.messageCount <= count, 'unrelated or settled deliveries unexpectedly became ready');
            consecutive = status.messageCount === count ? consecutive + 1 : 0;
            if (consecutive === 2) { observation.matched = true; return status; }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.fail(`broker ready count did not converge to exactly ${count} within five seconds`);
    }
    async function action(messages: GetMessage[], channel: Channel) {
        const before = receipts.length;
        const count = await bounded(new Promise<number>(resolve => routes.routes.action(messages, channel, resolve)), 'actual action route');
        assert.equal(receipts.length, before + 1, 'each route call must produce one real Elasticsearch bulk receipt');
        return {indexed: count, receipt: receipts[before]};
    }
    async function verifyDocuments(documents: Document[]) {
        for (let offset = 0; offset < documents.length; offset += 64) {
            const batch = documents.slice(offset, offset + 64);
            const result = await client.mget({index, ids: batch.map(doc => doc.id), realtime: true});
            assert.equal(result.docs.length, batch.length);
            result.docs.forEach((result: any, position: number) => {
                assert.equal(result._id, batch[position].id); assert.equal(result._index, index);
                assert.equal(result.found, true, 'acknowledged broker document missing');
                assert.deepEqual(result._source, batch[position].source, 'broker replay changed the submitted document');
            });
        }
    }
    async function onlySentinelAfterClose(queue: string, held: GetMessage, original: Channel, name: string) {
        await bounded(original.close(), 'close channel retaining the unrelated sentinel');
        const probe = await channel(name);
        await ready(probe, queue, 1);
        const redelivered = await get(probe, queue, held.properties.messageId);
        assert.equal(redelivered.fields.redelivered, true, 'unrelated held delivery was not returned by channel close');
        assert.deepEqual(redelivered.content, held.content);
        probe.ack(redelivered);
        await ready(probe, queue, 0);
        await bounded(probe.close(), 'close sentinel verification channel');
        return delivery(redelivered);
    }

    try {
        routes = new ElasticRoutes({chain, ingestClients: [client], config: {
            settings: {index_version: 'v1', index_partition_size: 10_000_000}, scaling: {indexing_queues: 1}
        }});
        connection = await bounded(connect(brokerUrl, {timeout: requestTimeoutMs}), 'connect dedicated broker') as ChannelModel;
        connection.on('error', error => channelErrors.push({case: currentCase, channel: 'connection', message: error.message}));
        admin = await channel('admin');
        publisher = instrument(await bounded(connection.createConfirmChannel(), 'create confirm publisher'), 'publisher') as ConfirmChannel;

        currentCase = 'healthy-single-delivery';
        const healthy = makeDocument(9_000_001, 'broker healthy action');
        const healthyQueue = await createQueue('single');
        await publish(healthyQueue, [healthy], 'broker-sentinel-single');
        const healthyChannel = await channel('healthy');
        const healthyDelivery = await get(healthyChannel, healthyQueue, healthy.id);
        const healthySentinel = await get(healthyChannel, healthyQueue, 'broker-sentinel-single');
        const healthyResult = await action([healthyDelivery], healthyChannel);
        assert.equal(healthyResult.indexed, 1);
        assertDurableBulkAcknowledged(healthyResult.receipt.body, [{index, id: healthy.id}]);
        await ready(healthyChannel, healthyQueue, 0);
        const healthyReturned = await onlySentinelAfterClose(healthyQueue, healthySentinel, healthyChannel, 'healthy-probe');
        expectedDocs.push(healthy);
        settlementObservations.push({case: currentCase, indexed: healthyResult.indexed, acknowledgedId: healthy.id,
            heldSentinel: delivery(healthySentinel), returnedAfterClose: [healthyReturned]});

        currentCase = 'mixed-item-mapping-failure';
        const good = makeDocument(9_000_002, 'broker mixed valid action');
        const poison = makeDocument('broker-invalid-sequence', 'controlled malformed long mapping input; remains unacknowledged');
        const mixedQueue = await createQueue('mixed');
        await publish(mixedQueue, [good, poison], 'broker-sentinel-mixed');
        const mixedChannel = await channel('mixed');
        const mixedDeliveries = [await get(mixedChannel, mixedQueue, good.id), await get(mixedChannel, mixedQueue, poison.id)];
        const mixedSentinel = await get(mixedChannel, mixedQueue, 'broker-sentinel-mixed');
        const mixedResult = await action(mixedDeliveries, mixedChannel);
        assert.equal(mixedResult.indexed, 1, 'only the valid item may count as indexed');
        assert.equal(mixedResult.receipt.body.errors, true);
        assertDurableBulkAcknowledged({errors: false, items: [mixedResult.receipt.body.items[0]]}, [{index, id: good.id}]);
        const failedItem = mixedResult.receipt.body.items[1]?.index;
        assert.equal(failedItem?._id, poison.id); assert.equal(failedItem?._index, index);
        assert.equal(failedItem?.status, 400, 'controlled malformed mapping input must actually fail in Elasticsearch');
        assert.ok(failedItem.error, 'mapping failure cause missing');
        await ready(mixedChannel, mixedQueue, 1);
        await bounded(mixedChannel.close(), 'close mixed channel retaining sentinel');
        const mixedProbe = await channel('mixed-probe');
        await ready(mixedProbe, mixedQueue, 2);
        const returnedMixed = [await get(mixedProbe, mixedQueue), await get(mixedProbe, mixedQueue)];
        assert.deepEqual(returnedMixed.map(message => message.properties.messageId).sort(), [poison.id, 'broker-sentinel-mixed'].sort());
        for (const message of returnedMixed) {
            assert.equal(message.fields.redelivered, true);
            if (message.properties.messageId === poison.id) {
                assert.equal(createHash('sha256').update(message.content).digest('hex'), poison.sha256);
                mixedProbe.nack(message, false, true);
            } else { assert.deepEqual(message.content, mixedSentinel.content); mixedProbe.ack(message); }
        }
        await ready(mixedProbe, mixedQueue, 1);
        await bounded(mixedProbe.close(), 'close mixed verification channel');
        const poisonResult = await client.mget({index, ids: [poison.id], realtime: true});
        assert.equal(poisonResult.docs[0]?.found, false, 'malformed input must not appear as a durable success');
        expectedDocs.push(good);
        settlementObservations.push({case: currentCase, indexed: mixedResult.indexed, acknowledgedId: good.id,
            failedDocument: poison, failedItem, returnedAfterClose: returnedMixed.map(delivery),
            pendingBeforeFixtureCleanup: 1, disposition: 'Malformed original input remains failed and requeued; no correction or durable-ack claim.'});

        currentCase = 'native-bulk-pressure';
        const pressureDocs = Array.from({length: pressureCount}, (_, position) =>
            makeDocument(9_100_000 + position, `${position.toString().padStart(6, '0')}:` + 'b'.repeat(3065)));
        const pressureQueue = await createQueue('pressure');
        await publish(pressureQueue, pressureDocs, 'broker-sentinel-pressure');
        const pressureChannel = await channel('pressure');
        const pressureDeliveries: GetMessage[] = [];
        for (const doc of pressureDocs) pressureDeliveries.push(await get(pressureChannel, pressureQueue, doc.id));
        const pressureSentinel = await get(pressureChannel, pressureQueue, 'broker-sentinel-pressure');
        const pressureResult = await action(pressureDeliveries, pressureChannel);
        assert.equal(pressureResult.indexed, 0, 'whole-request pressure rejection may not count indexed work');
        const stage = assertNativePressureRejection(pressureResult.receipt.body?.error, pressureResult.receipt.statusCode);
        await ready(pressureChannel, pressureQueue, pressureDocs.length);
        const beforeRetry: any[] = [];
        for (let offset = 0; offset < pressureDocs.length; offset += 64) {
            const batch = pressureDocs.slice(offset, offset + 64);
            const observed = await client.mget({index, ids: batch.map(doc => doc.id), realtime: true});
            assert.equal(observed.docs.length, batch.length);
            observed.docs.forEach((result: any, position: number) => {
                assert.equal(result._id, batch[position].id); assert.equal(result._index, index);
                assert.ok(!result.error, 'pre-retry presence measurement failed');
                if (result.found) assert.deepEqual(result._source, batch[position].source);
                beforeRetry.push({id: result._id, found: result.found === true});
            });
        }
        const replay = await channel('pressure-replay');
        const expectedById = new Map(pressureDocs.map(document => [document.id, document]));
        const acknowledged = new Set<string>();
        for (let offset = 0; offset < pressureDocs.length; offset += retryChunkSize) {
            const batch: GetMessage[] = [];
            for (let position = 0; position < Math.min(retryChunkSize, pressureDocs.length - offset); position++) {
                const message = await get(replay, pressureQueue);
                assert.equal(message.fields.redelivered, true, 'rejected original delivery must be redelivered');
                const original = expectedById.get(message.properties.messageId!);
                assert.ok(original && !acknowledged.has(original.id), 'unexpected or already acknowledged replay ID');
                assert.equal(createHash('sha256').update(message.content).digest('hex'), original.sha256,
                    'replay must preserve the exact original JSON bytes');
                batch.push(message);
            }
            const replayResult = await action(batch, replay);
            assert.equal(replayResult.indexed, batch.length, 'bounded replay left work unacknowledged');
            assertDurableBulkAcknowledged(replayResult.receipt.body, batch.map(message => ({index, id: message.properties.messageId!})));
            batch.forEach(message => acknowledged.add(message.properties.messageId!));
        }
        assert.equal(acknowledged.size, pressureDocs.length);
        await ready(replay, pressureQueue, 0);
        await bounded(replay.close(), 'close bounded replay channel');
        const pressureReturned = await onlySentinelAfterClose(pressureQueue, pressureSentinel, pressureChannel, 'pressure-probe');
        expectedDocs.push(...pressureDocs);
        settlementObservations.push({case: currentCase, indexedBeforeRetry: pressureResult.indexed, nativeRejectionStage: stage,
            requeuedBatchCount: pressureDocs.length, preRetryPresence: beforeRetry,
            acknowledgedReplayIds: [...acknowledged], heldSentinel: delivery(pressureSentinel),
            returnedAfterClose: [pressureReturned], retryChunkSize});

        await verifyDocuments(expectedDocs);
        assert.equal(channelErrors.length, 0, 'broker channel emitted an error');
    } catch (error) { failure = error; }
    finally {
        client.bulk = originalBulk;
        for (const channel of [...openChannels]) {
            if (channel === admin || channel === publisher) continue;
            try { await bounded(channel.close(), 'close owned delivery channel'); }
            catch (error: any) { queueCleanup.push({channelCloseError: error.message}); failure ??= error; }
        }
        if (admin) {
            for (const queue of queues) {
                try {
                    await assertOwned();
                    assert.ok(queue.startsWith(`${chain}.broker.`), 'refusing cleanup outside exact owned queue namespace');
                    const pending: Awaited<ReturnType<Channel['checkQueue']>> =
                        await bounded(admin.checkQueue(queue), 'inspect exact owned queue before cleanup');
                    assert.equal(pending.consumerCount, 0, 'refusing deletion with an unexpected consumer');
                    const result = await bounded(admin.deleteQueue(queue, {ifUnused: true, ifEmpty: false}), 'delete exact owned queue');
                    queueCleanup.push({queue, readyBeforeDelete: pending.messageCount, deletedMessageCount: result.messageCount,
                        deleted: true, scope: 'Explicit fixture cleanup; pending malformed input is not acknowledged.'});
                } catch (error: any) { queueCleanup.push({queue, deleted: false, error: error.message}); failure ??= error; }
            }
        }
        for (const channel of [publisher, admin]) {
            if (channel && openChannels.has(channel)) {
                try { await bounded(channel.close(), 'close owned administration channel'); }
                catch (error) { failure ??= error; }
            }
        }
        if (connection) { try { await bounded(connection.close(), 'close owned broker connection'); } catch (error) { failure ??= error; } }
    }
    const report = {receipts, expectedDocs, settlementObservations, queueObservations, settlements, publisherConfirms, queueCleanup, channelErrors,
        broker: connection?.connection.serverProperties,
        totalRequestBytes, bounds: {pressureCount, retryChunkSize, maxRequestBytes, maxTotalRequestBytes, requestTimeoutMs},
        scope: 'Built ElasticRoutes and actual AMQP manual delivery settlement only; no full worker, master, shared-reader backpressure, broker restart, or power-loss qualification.'};
    if (failure) {
        const error = failure instanceof Error ? failure : new Error(String(failure));
        Object.assign(error, {qualificationEvidence: report});
        throw error;
    }
    assert.equal(queueCleanup.filter(item => item.deleted).length, queues.length, 'owned queue cleanup incomplete');
    return report;
}
