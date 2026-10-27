/** Actual emitted MainDS routing and DS consume capture; controlled AMQP/authority, no services. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {EventEmitter} from 'node:events';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const scenario = process.argv[2] ?? 'held';
const enabled = scenario !== 'disabled';
const pause = () => new Promise(yes => setTimeout(yes, 5));
async function until(test, label) {const end = Date.now() + 10000; while (!test()) {assert(Date.now() < end, label); await pause();}}

if (cluster.isPrimary) {
    await (async () => {
    const {WorkerAttemptSupervisor} = await import('../../build/indexer/protocol/worker-attempt-supervisor.js');
    const directory = mkdtempSync(join(tmpdir(), 'hapi-queued-publication-'));
    const children = [], roles = new Map();
    let current = true;
    const generation = randomUUID(), readerSessionId = randomUUID();
    const supervisor = new WorkerAttemptSupervisor({...(enabled ? {queuedPublications: {
        maximumPublications: scenario === 'publication-bound' ? 1 : 64,
        maximumDeliveries: scenario === 'delivery-bound' ? 1 : 128,
        consumerQueue: worker => roles.get(worker) === 'ds_pool_worker' ? 'queued-wire:ds_pool:1' : undefined,
        source: binding => {
            assert.equal(binding.readerSessionId, readerSessionId);
            assert.equal(binding.blockNum, 33);
            return {chainId: '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d',
                generation, readerSessionId, isCurrent: () => current};
        }
    }} : {})});
    try {
        const repo = fileURLToPath(new URL('../../', import.meta.url));
        const archive = join(repo, 'tests/fixtures/portable-state-worker/source-1-1480-20261020.tar.gz');
        assert.equal(hash(readFileSync(archive)), '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
        const prepared = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
            [join(repo, 'tests/fixtures/portable-state-worker/prepare.py'), join(directory, 'source')], {encoding: 'utf8', timeout: 20000});
        assert.equal(prepared.status, 0, prepared.stderr);
        const input = JSON.parse(prepared.stdout);
        const sourceDirectory = join(directory, 'source/source');
        const frame = readFileSync(join(sourceDirectory, 'block-000033.bin'));
        const schema = readFileSync(join(sourceDirectory, 'schema.json'), 'utf8');
        const config = join(directory, 'chain.json'); writeFileSync(config, JSON.stringify({settings: {chain: 'queued-wire', debug: false}, indexer: {}}));
        mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'config/connections.json'), '{}');
        cluster.setupPrimary({exec: fileURLToPath(import.meta.url), args: [scenario], silent: true});
        const events = [];
        let childError = '', heldReply, publicationRequest;
        const spawn = (role, queue = 'queued-wire:ds_pool:1') => {
            const child = cluster.fork({CONFIG_JSON: config, QUEUED_TEST_ROLE: role, worker_queue: queue});
            children.push(child); roles.set(child, role === 'producer' ? 'deserializer' : 'ds_pool_worker');
            const rows = [], replies = []; let exit;
            child.on('message', row => {rows.push(row); if (row.payload?.operation === 'queued-publication') publicationRequest = row;});
            child.on('exit', code => {exit = code;}); child.process.stderr.on('data', bytes => {childError += bytes;});
            const send = child.send.bind(child);
            child.send = (message, ...args) => {
                if (message.event === 'worker_attempt_reply') replies.push(message);
                if (role === 'producer' && message.result?.messageId && !heldReply) {
                    heldReply = {message, release: () => send(message, ...args)}; return true;
                }
                return send(message, ...args);
            };
            supervisor.attach(child, roles.get(child));
            return {child, rows, replies, get exit() {return exit;}};
        };
        const original = spawn('producer'), producer = original.child;
        producer.on('message', message => events.push(message));
        producer.send({event: 'initialize', frame: frame.toString('hex'), schema, readerSessionId});
        if (enabled) {
            await until(() => heldReply || events.some(row => row.event === 'actual_publish') || original.exit !== undefined, 'parent issuance before the held send');
            assert.equal(original.exit, undefined, childError);
            assert(heldReply, 'parent-issued original publication lineage must exist before the actual publisher callback');
            producer.send({event: 'checkpoint'});
            await until(() => events.some(row => row.event === 'checkpoint'), 'child round trip during held authorization');
            assert.equal(events.find(row => row.event === 'checkpoint').sends, 0, 'no physical send before original parent response');
            assert.equal(supervisor.snapshot().queuedPublications.publications.length, 1);
            if (scenario === 'retry') {
                supervisor.handle(producer, publicationRequest);
                assert.equal(supervisor.snapshot().queuedPublications.publications.length, 1, 'same original request retry has one identity');
            }
            if (scenario === 'mutate-payload' || scenario === 'mutate-headers') {
                producer.send({event: scenario});
                await until(() => events.some(row => row.event === 'mutated'), 'original publication bytes mutation');
            }
            if (scenario === 'fence-before-send') {current = false; supervisor.fenceActive();}
            if (scenario === 'replace-before-send') supervisor.retire(producer);
            heldReply.release();
            if (['mutate-payload','mutate-headers','fence-before-send','replace-before-send'].includes(scenario)) {
                await until(() => events.some(row => row.event === 'producer_rejected'), 'original late authorization rejected');
                assert(!events.some(row => row.event === 'actual_publish'), 'no send from changed or fenced original scope');
                assert.equal(supervisor.snapshot().queuedPublications.publications.length, 1);
                producer.send({event: 'finish'}); await until(() => original.exit !== undefined, 'fenced original exit');
                assert.equal(original.exit, 0, childError);
                if (scenario === 'replace-before-send') {
                    const next = spawn('producer');
                    next.child.send({event: 'initialize', frame: frame.toString('hex'), schema, readerSessionId});
                    await until(() => next.rows.some(row => row.event === 'actual_publish'), 'replacement original send');
                    const records = supervisor.snapshot().queuedPublications.publications;
                    assert.equal(records.length, 2);
                    assert.notEqual(records[0].messageId, records[1].messageId);
                    assert.notEqual(records[0].producer.incarnation, records[1].producer.incarnation);
                    next.child.send({event: 'confirm'}); next.child.send({event: 'drain'});
                    await until(() => next.rows.some(row => row.event === 'producer_returned'), 'replacement original return');
                    next.child.send({event: 'finish'}); await until(() => next.exit !== undefined, 'replacement shutdown');
                    assert.equal(next.exit, 0, childError);
                }
                console.log(JSON.stringify({passed: true, scenario, rejectedBeforeOriginalSend: true, retainedUncertainty: true,
                    actualManagedMainDsRoute: true, lineage: supervisor.snapshot().queuedPublications,
                    sourceArchiveSha256: input.archiveSha256, fullCapacityQualification: false})); return;
            }
        }
        await until(() => events.some(row => row.event === 'actual_publish') || original.exit !== undefined, 'original MainDS publish callback');
        assert.equal(original.exit, undefined, childError);
        const publication = events.find(row => row.event === 'actual_publish');
        assert.equal(publication.options.persistent, true); assert.equal(publication.options.mandatory, true);
        const record = supervisor.snapshot().queuedPublications?.publications.find(row => row.messageId === publication.options.messageId);
        if (enabled) {
            assert(record, 'parent-issued original publication lineage must exist before the actual publisher callback');
            assert.equal(record.queue, publication.queue);
            assert.equal(record.payloadSha256, hash(Buffer.from(publication.payload, 'hex')));
            assert.equal(record.source.generation, generation); assert.equal(record.brokerSettlement, 'unknown');
        } else assert.equal(supervisor.snapshot().queuedPublications, undefined, 'normal host has no lineage state');
        const first = spawn('consumer', scenario === 'changed-queue' ? publication.queue + ':foreign' : publication.queue);
        const consumer = first.child, deliveries = first.rows;
        consumer.send({event: 'initialize'});
        await until(() => deliveries.some(row => row.event === 'consumer_ready'), 'original DS consumer callback');
        const delivered = structuredClone(publication);
        if (scenario === 'changed-payload') delivered.payload = 'ff' + delivered.payload.slice(2);
        if (scenario === 'changed-headers') delivered.options.headers.filtered = true;
        if (scenario === 'foreign') delivered.options.messageId = randomUUID();
        if (scenario === 'source-fence') current = false;
        const rejected = ['changed-payload','changed-headers','changed-queue','foreign','source-fence'].includes(scenario);
        consumer.send({event: 'deliver', publication: delivered,
            hold: ['overlap','redelivery','fenced-overlap','delivery-bound','registration-rebind'].includes(scenario)});
        await until(() => deliveries.some(row => row.event === (rejected ? 'delivery_rejected' : 'delivery_validated')), 'parent validates original queued capture');
        if (enabled) {
            const captured = supervisor.snapshot().queuedPublications.publications[0];
            assert.equal(captured.deliveries.length, rejected ? 0 : 1);
            assert.equal(captured.brokerSettlement, 'unknown');
        }
        if (scenario === 'duplicate') {
            consumer.send({event: 'deliver', publication});
            await until(() => deliveries.some(row => row.event === 'delivery_rejected'), 'duplicate physical receipt rejected');
            assert.equal(supervisor.snapshot().queuedPublications.publications[0].deliveries.length, 1);
        }
        if (scenario === 'registration-rebind') {
            const second = spawn('producer');
            second.child.send({event: 'initialize', frame: frame.toString('hex'), schema, readerSessionId});
            await until(() => second.rows.some(row => row.event === 'actual_publish'), 'second original equal-body publication');
            const other = second.rows.find(row => row.event === 'actual_publish');
            const registration = structuredClone(first.rows.find(row => row.payload?.operation === 'register'));
            registration.payload.publication.messageId = other.options.messageId;
            supervisor.handle(consumer, registration);
            assert.equal(first.replies.at(-1).result.ok, false, 'original consumption registration cannot be rebound to an equal-byte publication');
            second.child.send({event: 'confirm'}); second.child.send({event: 'drain'});
            await until(() => second.rows.some(row => row.event === 'producer_returned'), 'second original confirmed return');
            second.child.send({event: 'finish'}); await until(() => second.exit !== undefined, 'second original shutdown');
            assert.equal(supervisor.snapshot().queuedPublications.publications[1].deliveries.length, 0);
        }
        if (['overlap','redelivery','fenced-overlap','delivery-bound'].includes(scenario)) {
            if (scenario !== 'overlap') {
                supervisor.retire(consumer);
                if (scenario !== 'fenced-overlap') {
                    consumer.send({event: 'finish'});
                    await until(() => first.exit !== undefined, 'original physical consumer observed exit');
                }
            }
            const next = spawn('consumer'); next.child.send({event: 'initialize'});
            await until(() => next.rows.some(row => row.event === 'consumer_ready'), 'replacement DS consumer');
            next.child.send({event: 'deliver', publication, redelivered: true});
            const accept = scenario === 'redelivery' || scenario === 'fenced-overlap';
            await until(() => next.rows.some(row => row.event === (accept ? 'delivery_validated' : 'delivery_rejected')), 'overlap or redelivery validation');
            const rows = supervisor.snapshot().queuedPublications.publications[0].deliveries;
            assert.equal(rows.length, accept ? 2 : 1);
            if (scenario === 'redelivery') {assert.equal(rows[0].end, 'process-exited-unresolved'); assert(rows[1].redelivered);}
            if (scenario === 'fenced-overlap') {assert.equal(rows[0].end, null); assert(rows[1].redelivered);}
            next.child.send({event: 'finish'}); await until(() => next.exit !== undefined, 'replacement DS shutdown');
            assert.equal(next.exit, 0, childError);
        }
        if (scenario === 'late-return' || scenario === 'channel-close' || scenario === 'unknown-send') {
            producer.send({event: scenario === 'late-return' ? 'returned' : 'close'});
            if (scenario === 'late-return') {
                producer.send({event: 'confirm'}); producer.send({event: 'drain'});
            }
            await until(() => events.some(row => row.event === 'producer_rejected'), 'original return/channel loss rejected');
            producer.send({event: 'confirm'}); producer.send({event: 'drain'}); producer.send({event: 'returned'});
        } else {
        producer.send({event: 'confirm'}); await pause();
        assert(!events.some(row => row.event === 'producer_returned'), 'confirmation must still wait for original drain');
        producer.send({event: 'drain'});
        await until(() => events.some(row => row.event === 'producer_returned'), 'original confirmation and drain');
        }
        if (scenario === 'publication-bound') {
            const next = spawn('producer');
            next.child.send({event: 'initialize', frame: frame.toString('hex'), schema, readerSessionId});
            await until(() => next.rows.some(row => row.event === 'producer_rejected'), 'bounded lineage fails before second send');
            assert(!next.rows.some(row => row.event === 'actual_publish'));
            assert.match(next.rows.find(row => row.event === 'producer_rejected').error, /lineage window exhausted/);
            next.child.send({event: 'finish'}); await until(() => next.exit !== undefined, 'bounded producer shutdown');
        }
        if (enabled) {
            const retained = supervisor.snapshot().queuedPublications;
            assert.equal(retained.publications.length, scenario === 'registration-rebind' ? 2 : 1, 'producer return cannot erase broker uncertainty');
            assert.equal(retained.publications[0].brokerSettlement, 'unknown'); assert.equal(retained.capacityReleased, false);
        }
        producer.send({event: 'finish'});
        await until(() => original.exit !== undefined, 'original producer shutdown'); assert.equal(original.exit, 0, childError);
        if (first.exit === undefined) consumer.send({event: 'finish'});
        await until(() => first.exit !== undefined, 'original consumer shutdown'); assert.equal(first.exit, 0, childError);
        console.log(JSON.stringify({passed: true, scenario, actualManagedMainDsRoute: true, sourcePinnedWireFrame: 33,
            parentIssueBeforeOriginalPublish: enabled, actualManagedDsCapture: true, brokerSettlement: 'unknown',
            lineage: supervisor.snapshot().queuedPublications,
            fullCapacityQualification: false, sourceArchiveSha256: input.archiveSha256}));
    } finally {
        for (const child of children) if (!child.isDead()) {
            try {child.send({event: 'confirm'}); child.send({event: 'drain'}); child.send({event: 'finish'});} catch {}
            await new Promise(yes => {if (child.isDead()) yes(); else {child.once('exit', yes); setTimeout(() => {child.kill(); yes();}, 1500).unref();}});
        }
        supervisor.stop(); rmSync(directory, {recursive: true, force: true});
    }
    })();
} else {
    const initialization = await new Promise(yes => process.once('message', yes));
    process.chdir(dirname(process.env.CONFIG_JSON));
    const {WorkerAttemptClient} = await import('../../build/indexer/protocol/worker-attempt-client.js');
    if (process.env.QUEUED_TEST_ROLE === 'consumer') {
        const {default: DsPool} = await import('../../build/indexer/workers/ds-pool.js');
        const client = new WorkerAttemptClient({mode: 'managed', role: 'ds_pool_worker', transport: process, queuedPublicationLineage: enabled});
        const channel = Object.assign(new EventEmitter(), {async prefetch() {}, async consume(queue, callback) {this.deliver = callback;}});
        const worker = Object.assign(Object.create(DsPool.prototype), {chain: 'queued-wire', conf: {prefetch: {block: 8}},
            ch: channel, cch: new EventEmitter(), ch_ready: true, cch_ready: true,
            local_queue: process.env.worker_queue, actionAdmissionOwners: new WeakMap()});
        worker.configureWorkerAttemptLifecycle(client);
        worker.consumerQueue = worker.createConsumerQueue(); worker.consumerQueue.pause();
        await worker.initConsumer();
        let finished, release; let tag = 0; const done = new Promise(yes => {finished = yes;});
        process.on('message', message => {
            if (message.event === 'finish') {release?.(); finished();}
            if (message.event !== 'deliver') return;
            const p = message.publication;
            const delivery = {content: Buffer.from(p.payload, 'hex'), properties: {headers: p.options.headers, messageId: p.options.messageId},
                fields: {deliveryTag: ++tag, redelivered: message.redelivered === true}};
            void (async () => {
                channel.deliver(delivery);
                // Await the original pre-cargo registration using its existing lifecycle; no business effect/ACK.
                await worker.runWorkerAttemptDelivery(delivery, async () => {
                    process.send({event: 'delivery_validated', originalAckCount: 0, cargoPaused: worker.consumerQueue.paused});
                    if (message.hold) await new Promise(yes => {release = yes;});
                });
            })().catch(error => process.send({event: 'delivery_rejected', error: error.message}));
        });
        process.send({event: 'consumer_ready'}); await done; worker.consumerQueue.kill(); client.dispose(); process.exit(0);
    }
    const {default: MainDs} = await import('../../build/indexer/workers/deserializer.js');
    const {createWireShipCodec, resolveCodecProfile} = await import('@eosrio/hyperion-wire-plugin');
    const {actionHistoryImmutableJson} = await import('../../build/indexer/history/action-history-manifest.js');
    const codec = createWireShipCodec(JSON.parse(initialization.schema), resolveCodecProfile('wire-sysio-6508c9e8-native-engineering-v1'));
    const frame = Buffer.from(initialization.frame, 'hex'), result = codec.decodeResult(frame)[1];
    const traces = codec.decodeTraces(Buffer.from(result.traces, 'hex'));
    assert.equal(traces.length, 1);
    const trace = traces[0][1], payload = actionHistoryImmutableJson(trace);
    const client = new WorkerAttemptClient({mode: 'managed', role: 'deserializer', transport: process, queuedPublicationLineage: enabled});
    const consumer = Object.assign(new EventEmitter(), {ack() {}});
    let confirm, lastMessageId, sends = 0, originalPayload, originalHeaders;
    const publisher = Object.assign(new EventEmitter(), {sendToQueue(queue, content, options, callback) {
        confirm = callback; sends++; lastMessageId = options.messageId;
        process.send({event: 'actual_publish', queue, payload: Buffer.from(content).toString('hex'), options});
        if (scenario === 'unknown-send') throw new Error('Controlled unknown physical send');
        return false;
    }});
    const worker = Object.assign(Object.create(MainDs.prototype), {chain: 'queued-wire',
        conf: {scaling: {routing_mode: 'round_robin', ds_pool_size: 1}, whitelists: {}},
        filters: {action_blacklist: new Set(), action_whitelist: new Set()},
        ch: consumer, cch: publisher, ch_ready: true, cch_ready: true, lastSelectedWorker: 0,
        actionAdmissionOwners: new WeakMap()});
    worker.configureWorkerAttemptLifecycle(client);
    worker.publishAdmitted = function(owner, queue, content, headers) {
        originalPayload = content; originalHeaders = headers;
        return MainDs.prototype.publishAdmitted.call(this, owner, queue, content, headers);
    };
    const source = {content: frame, properties: {headers: {}}, fields: {deliveryTag: 1}};
    worker.captureActionAdmissionDelivery(source, consumer);
    let finish;
    const finished = new Promise(yes => {finish = yes;});
    process.on('message', message => {
        if (message.event === 'confirm') confirm?.();
        if (message.event === 'drain') publisher.emit('drain');
        if (message.event === 'returned') publisher.emit('return', {properties: {messageId: lastMessageId}});
        if (message.event === 'close') publisher.emit('close');
        if (message.event === 'checkpoint') process.send({event: 'checkpoint', sends});
        if (message.event === 'mutate-payload') {originalPayload[0] ^= 1; process.send({event: 'mutated'});}
        if (message.event === 'mutate-headers') {originalHeaders.filtered = true; process.send({event: 'mutated'});}
        if (message.event === 'finish') finish();
    });
    try {await worker.runWorkerAttemptDelivery(source, async () => {
        await worker.bindWorkerAttempt({selectionId: 'h45srcsel1:' + hash(frame), readerSessionId: initialization.readerSessionId,
            admissionId: 'h45actionadmission1:' + hash(frame), blockNum: 33, blockId: result.this_block.block_id,
            configurationSha256: 'a'.repeat(64), targetName: 'queued-action', targetUuid: 'queued-action-uuid'});
        const headers = {block_num: 33, block_id: result.this_block.block_id, filtered: false,
            inline_count: 1, action_trace_ordinal: 0, 'hyperion-source-selection-v1': 'h45srcsel1:' + hash(frame),
            'hyperion-action-admission-v1': 'h45actionadmission1:' + hash(frame)};
        await worker.routeToPool(trace, headers, worker.actionPublicationOwner(source), payload);
    }); process.send({event: 'producer_returned'});}
    catch (error) {process.send({event: 'producer_rejected', error: error.message});}
    await finished; client.dispose(); process.exit(0);
}
