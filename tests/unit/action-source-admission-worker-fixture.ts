import {controlledAttemptLifecycle} from './worker-attempt-fixture.mjs';
/** Resource-free source prototype probe. The codec, ES transport and AMQP channels are controlled;
 * this is neither a binary SHiP/native-addon fixture nor a live broker/database qualification. */
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {EventEmitter} from 'node:events';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

const oldDirectory = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'hyperion-action-admission-worker-'));
const chain = 'admission-worker', chainId = '1'.repeat(64), blockId = '2'.repeat(64), previousId = '3'.repeat(64);
const transactionId = 'a'.repeat(64), otherId = 'b'.repeat(64), schemaJson = JSON.stringify({version: 'controlled-original', structs: []});
const clone = <T>(value: T): T => structuredClone(value);
function deferred() {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};}
async function ticks() {for (let index = 0; index < 5; index++) await new Promise<void>(resolve => setImmediate(resolve));}
async function until(predicate: () => boolean, label: string) {
    for (let index = 0; index < 500; index++) {if (predicate()) return; await new Promise<void>(resolve => setTimeout(resolve, 2));}
    assert.fail('Controlled probe did not reach ' + label);
}
class ControlledConsumer extends EventEmitter {
    acked: any[] = [];
    streamed: Array<{queue: string; payload: Buffer; options: any}> = [];
    onAck?: (message: any) => void;
    ack(message: any) {this.onAck?.(message); this.acked.push(message);}
    publish(_exchange: string, queue: string, payload: Buffer, options: any) {
        this.streamed.push({queue, payload: Buffer.from(payload), options: clone(options)}); return true;
    }
}
class ControlledPublisher extends EventEmitter {
    sent: Array<{queue: string; payload: Buffer; options: any; confirm: (error?: unknown) => void}> = [];
    writable = true;
    automatic = true;
    beforeSend?: (queue: string, payload: Buffer, options: any) => void;
    sendToQueue(queue: string, payload: Buffer, options: any, confirm: (error?: unknown) => void) {
        this.beforeSend?.(queue, payload, options);
        this.sent.push({queue, payload: Buffer.from(payload), options: clone(options), confirm});
        if (this.automatic) queueMicrotask(() => confirm());
        return this.writable;
    }
}
function rawAction(ordinal: number, creator = 0, receiver = 'token', uppercase = false): any {
    const hex = uppercase ? 'ABCDEF'.repeat(10) + 'ABCD' : 'abcdef'.repeat(10) + 'abcd';
    return ['action_trace_v1', {action_ordinal: ordinal, creator_action_ordinal: creator, receiver,
        receipt: ['action_receipt_v0', {receiver, act_digest: hex, global_sequence: String(9007199254740992n + BigInt(ordinal)),
            recv_sequence: '9223372036854775808', auth_sequence: [{account: 'alice', sequence: '18446744073709551615'}],
            code_sequence: ordinal, abi_sequence: ordinal + 1}],
        act: {account: 'token', name: 'transfer', authorization: [{actor: 'alice', permission: 'active'}], data: uppercase ? 'ABCD' : 'abcd'},
        context_free: false, except: null, error_code: null, elapsed: '0', console: 'source console'}];
}
function rawTransaction(actions: any[], id = transactionId): any {
    return ['transaction_trace_v0', {id, status: 0, scheduled: false, failed_dtrx_trace: null, except: null,
        error_code: null, cpu_usage_us: 15, net_usage_words: 2, action_traces: actions, partial: null}];
}

try {
    const initial = {settings: {chain, eosio_alias: 'eosio', parser: '3.2', debug: false}, indexer: {}, features: {}, scaling: {},
        api: {}, whitelists: {actions: [], deltas: []}};
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(initial));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({chains: {[chain]: {chain_id: chainId}}}));
    process.env.CONFIG_JSON = join(directory, 'chain.json'); process.env.worker_role = 'reader'; process.env.live_mode = 'true';
    process.chdir(directory);
    const [{default: Reader}, {default: Main}, {default: Pool}, {default: Parser}, {HyperionModuleLoader},
        {ActionSourceAdmissionStore, actionSourceIngressHeader, actionSourceAdmissionHeader},
        {deriveActionSourceInventory}, {currentActionPolicy}, {actionHistoryImmutableJson, fingerprintActionHistoryEffect}] = await Promise.all([
        import('../../src/indexer/workers/state-reader.js'), import('../../src/indexer/workers/deserializer.js'),
        import('../../src/indexer/workers/ds-pool.js'), import('../../src/indexer/modules/parsers/3.2-parser.js'),
        import('../../src/indexer/modules/loader.js'), import('../../src/indexer/history/action-source-admission.js'),
        import('../../src/indexer/history/action-source-inventory.js'), import('../../src/indexer/history/action-producer-epoch.js'),
        import('../../src/indexer/history/action-history-manifest.js')]);

    function recordIds(memory: any, prefix: string): string[] {
        return [...memory.documents.values()].map((value: any) => value.document)
            .filter((value: any) => value.kind === 'manifest' && value.bundle_id.startsWith(prefix)).map((value: any) => value.bundle_id);
    }
    function message(sent: ControlledPublisher['sent'][number]) {
        return {content: Buffer.from(sent.payload), properties: {headers: clone(sent.options.headers)}, fields: {deliveryTag: 1}};
    }
    async function harness(traces: any[] = [rawTransaction([rawAction(1), rawAction(2, 1, 'alice'), rawAction(3)])],
                           options: {maxInline?: number; blacklist?: string[]; whitelist?: string[]; rootOnly?: boolean} = {}) {
        const config: any = {settings: {chain, eosio_alias: 'eosio', parser: '3.2', debug: false,
            index_version: 'v1', index_partition_size: 1000, es_replicas: 0},
            indexer: {fetch_block: true, fetch_traces: true, process_deltas: false, disable_indexing: false, max_inline: options.maxInline ?? 0},
            features: {contract_console: false, failed_trx: false, streaming: {traces: true}},
            scaling: {routing_mode: 'round_robin', ds_pool_size: 2, ds_queues: 1, ad_idx_queues: 2, indexing_queues: 1},
            api: {tx_cache_mode: 'batch', disable_tx_cache: false},
            whitelists: {actions: options.whitelist ?? [], deltas: [], root_only: options.rootOnly ?? false},
            blacklists: {actions: options.blacklist ?? [], deltas: []}, plugins: {}};
        const filters = {action_blacklist: new Set(options.blacklist ?? []), action_whitelist: new Set(options.whitelist ?? []),
            delta_blacklist: new Set<string>(), delta_whitelist: new Set<string>()};
        const cm: any = {config, filters};
        const parser: any = new Parser(cm), loader: any = Object.create(HyperionModuleLoader.prototype);
        const control: {hook?: (action: any) => unknown | Promise<unknown>; decoded: any[]} = {decoded: []};
        const hook = async (action: any) => {await control.hook?.(action); action['@controlled_hook'] = {settled: true};};
        loader.handledActions = new Map([['token', new Map([['transfer', hook]])]]); loader.handledDeltas = new Map();
        loader.parser = parser; loader.plugins = [];
        const memory: any = frontierMemoryClient(), store = new ActionSourceAdmissionStore(memory.client, chain);
        const targetName = `${chain}-action-v1-000001`;
        memory.settings.set(targetName, {'index.uuid': 'owned-controlled-target'});
        memory.client.indices.exists = async ({index}: any) => memory.settings.has(index);
        const readerConsumer = new ControlledConsumer(), mainConsumer = new ControlledConsumer(), poolConsumer = new ControlledConsumer();
        const readerPublisher = new ControlledPublisher(), mainPublisher = new ControlledPublisher(), poolPublisher = new ControlledPublisher();
        const block = {timestamp: '2026-10-20T00:00:00.000', producer: 'producer', transactions: [], schedule_version: 1};
        const result: any = {this_block: {block_num: 12, block_id: blockId}, prev_block: {block_num: 11, block_id: previousId},
            head: {block_num: 12, block_id: blockId}, last_irreversible: {block_num: 11, block_id: previousId},
            block: Buffer.from(JSON.stringify(block)), traces: Buffer.from(JSON.stringify(traces)), deltas: Buffer.from('[]')};
        const encoded = ['get_blocks_result_v0', {...result, block: result.block.toString('hex'),
            traces: result.traces.toString('hex'), deltas: result.deltas.toString('hex'), schemaTag: 'controlled-original'}];
        const frame = Buffer.from(JSON.stringify(encoded)), schemas: string[] = [];
        const protocol = {profileId: 'antelope-default-v1', createShipSession(abi: any) {
            return {decodeResult(bytes: Uint8Array) {
                schemas.push(abi.version);
                const [kind, value] = JSON.parse(Buffer.from(bytes).toString());
                if (kind.startsWith('get_blocks')) {
                    assert.equal(abi.version, value.schemaTag, 'queued source must use its original handshake');
                    for (const name of ['block', 'traces', 'deltas']) value[name] = value[name] === null ? null : Buffer.from(value[name], 'hex');
                }
                return [kind, value];
            }, decodeBlock: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()),
            decodeTraces: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()),
            decodeDeltas: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()),
            encodeRequest: (request: unknown) => Buffer.from(JSON.stringify(request)), close() {}};
        }};
        function worker(prototype: any, consumer: ControlledConsumer, publisher: ControlledPublisher): any {
            const value = Object.create(prototype);
            Object.assign(value, {chain, chainId, conf: config, filters, configModule: cm, mLoader: loader, protocol,
                protocolId: 'antelope', protocolComponents: [], protocolReady: Promise.resolve(), client: memory.client,
                ch: consumer, cch: publisher, ch_ready: true, cch_ready: true, profiler: {start: () => () => {}},
                actionAdmissionOwners: new WeakMap(), actionAdmissionStore: store});
            Object.defineProperty(value, 'actionSourceAdmissionEnabled', {value: true, configurable: true});
            return value;
        }
        const reader = worker(Reader.prototype, readerConsumer, readerPublisher), main = worker(Main.prototype, mainConsumer, mainPublisher);
        const pool = worker(Pool.prototype, poolConsumer, poolPublisher), cache: any[] = [], blockWrites: any[] = [];
        Object.assign(reader, {baseRequest: {}, shipRev: 0, socketGeneration: 0, activeIngressGeneration: 0,
            isLiveReader: false, local_block_num: 11, local_distributed_count: 0, receivedFirstBlock: true,
            future_block: 0, currentIdx: 1, range_size: 1, publications: new Map(), send() {}, handleStatusResult() {}});
        reader.stageOneDistQueue = {push: async (payload: any) => new Promise<void>(resolve => reader.distribute([payload], resolve))};
        Object.assign(main, {local_block_count: 0, lastSelectedWorker: 0, dsPoolMap: {}, ds_pool_counters: {},
            enqueueDerivedPublication: async (value: any) => blockWrites.push(clone(value))});
        Object.assign(pool, {poolAbiCache: new Map(), poolTypeCache: new Map(), protocolCacheViews: new Set(),
            temp_ds_counter: 0, actionDsCounter: 0, act_emit_idx: 1, txCacheExpiration: 3600, allowStreaming: true,
            common: {deserializeActionAtBlockNative: async (_worker: any, act: any) => {
                control.decoded.push(act.data); return {ratio: 1.25, originalHex: act.data};
            }, attachActionExtras: Pool.prototype.attachActionExtras},
            pushToActionsQueue() {assert.fail('admitted actions must use the confirmed owner');},
            ioRedisClient: {pipeline() {
                const writes: any[] = [];
                return {hset(key: string, values: Map<string, Buffer>) {writes.push({key, values: new Map([...values].map(([key, value]) => [key, Buffer.from(value)]))}); return this;},
                    expire() {return this;}, async exec() {cache.push(...writes); return [];}};
            }}});
        await reader.initializeProtocolShip(schemaJson);
        // Exercise the actual reader's handshake/session verification without constructing network clients.
        await reader.processFirstABI(Buffer.from(schemaJson));
        await reader.onMessage(Buffer.from(JSON.stringify(['get_status_result_v1', {chain_id: chainId}])));
        await main.initializeProtocolShip(schemaJson);
        const expected = deriveActionSourceInventory({profileId: 'antelope-default-v1',
            source: {chainId, blockNum: 12, blockId, producer: block.producer, timestamp: block.timestamp},
            policy: currentActionPolicy(main), traces: clone(traces), ...(options.rootOnly ? {rootActions: []} : {})});
        readerPublisher.beforeSend = () => assert.equal(recordIds(memory, 'h45actioningress1:').length, 1,
            'retained ingress precedes raw broker publication');
        async function sourceMessage() {
            assert.equal(await reader.onMessage(frame), 'block');
            await ticks(); assert.equal(readerPublisher.sent.length, 1);
            const raw = readerPublisher.sent[0];
            assert.equal(raw.options.persistent, true); assert.equal(raw.options.mandatory, true);
            assert.ok(raw.payload.equals(frame)); assert.ok(raw.options.headers[actionSourceIngressHeader]);
            const incoming = message(raw); (controlledAttemptLifecycle(main, 'deserializer'), main).captureActionAdmissionDelivery(incoming, mainConsumer); return incoming;
        }
        async function admit() {
            const incoming = await sourceMessage(); await parser.parseMessage(main, [incoming]);
            const ids = recordIds(memory, 'h45actionadmission1:'); assert.equal(ids.length, 1);
            const admission = await store.resolve(ids[0]);
            assert.deepEqual(admission.inventory, expected, 'store must derive inventory from untouched original source');
            return {incoming, admission, messages: mainPublisher.sent.map(sent => {
                const incoming = message(sent); (controlledAttemptLifecycle(pool, 'ds_pool_worker'), pool).captureActionAdmissionDelivery(incoming, poolConsumer); return incoming;
            })};
        }
        return {reader, main, pool, parser, loader, control, memory, store, frame, result, schemas, expected,
            readerPublisher, mainPublisher, poolPublisher, mainConsumer, poolConsumer, cache, blockWrites, sourceMessage, admit};
    }

    const checks: string[] = [];
    async function check(name: string, run: () => Promise<void>) {await run(); checks.push(name);}

    async function assertCrossActionCorruptionIsScoped(mutate: (retained: any) => void, contractConsole = false) {
        const h = await harness([rawTransaction([rawAction(1), rawAction(2, 1, 'alice'), rawAction(3)]),
            rawTransaction([rawAction(9)], otherId)]);
        // Pin this feature before the source/producer epoch is admitted; late console metadata still uses hook output.
        h.pool.conf.features.contract_console = contractConsole;
        const {admission, messages} = await h.admit(); let retained: any, corrupted = false;
        h.control.hook = action => {
            if (action.action_ordinal === 1) retained = action;
            if (action.action_ordinal === 2) {
                assert.ok(retained, 'First hook must retain the actual action object');
                assert.equal(retained.except, undefined, 'First action parse has already settled');
                mutate(retained); corrupted = true;
            }
        };
        const entered = deferred(), release = deferred(); let incompleteStarted = false;
        h.memory.faults.beforeWrite = async (request: any) => {
            if (request.document.kind === 'manifest' && request.id.startsWith('h45actionincomplete1:')) {
                incompleteStarted = true; entered.resolve(); await release.promise;
            }
        };
        h.poolConsumer.onAck = receipt => {
            if (receipt === messages[0]) {
                assert.equal(recordIds(h.memory, 'h45actionincomplete1:').length, 1,
                    'Cross-action corruption must be durably scoped before the original ACK');
                assert.equal(recordIds(h.memory, 'h45actionfragment1:').length, 0,
                    'Corrupted transaction must not certify an empty or partial fragment');
                assert.equal(h.poolPublisher.sent.length, 0); assert.equal(h.poolConsumer.streamed.length, 0); assert.equal(h.cache.length, 0);
            }
        };
        const running = h.pool.processMessages(messages); let completed = false;
        running.then(() => {completed = true;}, () => {completed = true;});
        await until(() => incompleteStarted || completed, 'cross-action corruption scoped retention');
        assert.equal(corrupted, true);
        assert.equal(incompleteStarted, true, 'Pure grouping/normalization failures must reach scoped incomplete retention');
        await entered.promise;
        assert.equal(h.poolConsumer.acked.length, 0); assert.equal(h.poolPublisher.sent.length, 0);
        assert.equal(h.poolConsumer.streamed.length, 0); assert.equal(h.cache.length, 0);
        assert.equal(recordIds(h.memory, 'h45actionfragment1:').length, 0);
        release.resolve(); await running;
        assert.equal(h.poolConsumer.acked.length, 2);
        assert.equal(h.poolConsumer.acked[0], messages[0]); assert.equal(h.poolConsumer.acked[1], messages[1]);
        assert.equal(h.poolPublisher.sent.length, 1); assert.equal(h.poolConsumer.streamed.length, 1); assert.equal(h.cache.length, 1);
        const output = JSON.parse(h.poolPublisher.sent[0].payload.toString());
        assert.equal(output.trx_id, otherId); assert.equal(output.global_sequence, String(9007199254740992n + 9n));
        assert.ok(h.cache[0].values.get(output.global_sequence).equals(h.poolPublisher.sent[0].payload));
        assert.equal(recordIds(h.memory, 'h45actionfragment1:').length, 1);
        const failures = recordIds(h.memory, 'h45actionincomplete1:'); assert.equal(failures.length, 1);
        const failure = await (h.store as any).get(failures[0]);
        assert.equal(failure.admissionId, admission.id); assert.equal(failure.traceOrdinal, 0);
        assert.equal(await h.store.trySeal(admission), false);
    }

    // Change both the original Buffer in place and the externally visible Buffer/header references.
    // Production snapshots must win over each mutation; the original message remains the ACK receipt.
    function corruptDelivery(message: any, source: boolean) {
        message.content.fill(0x20);
        message.content = Buffer.from('{"id":"' + otherId + '","action_traces":[]}');
        const headers = message.properties.headers;
        headers[source ? actionSourceIngressHeader : actionSourceAdmissionHeader] = 'changed-after-await';
        Object.assign(headers, {block_num: 999, block_id: 'f'.repeat(64), producer: 'changed', ts: '2099-01-01T00:00:00.000',
            action_trace_ordinal: 999, inline_count: 999, filtered: true, live: 'changed'});
        message.properties.headers = {...headers, externallyReplaced: true};
    }

    async function assertOriginalSourceAndOutputs(h: Awaited<ReturnType<typeof harness>>, incoming: any, ingressId: string) {
        assert.equal(h.mainConsumer.acked.length, 1); assert.equal(h.mainConsumer.acked[0], incoming);
        const ids = recordIds(h.memory, 'h45actionadmission1:'); assert.equal(ids.length, 1);
        const admission = await h.store.resolve(ids[0]);
        assert.equal(admission.source.frameHex, h.frame.toString('hex'), 'Retained source must use validated original frame bytes');
        assert.equal(admission.source.ingressId, ingressId, 'Retained source must keep its original ingress identity');
        assert.deepEqual(admission.inventory, h.expected, 'Original native inventory must not change during source awaits');
        const messages = h.mainPublisher.sent.map(sent => {
            const incoming = message(sent); (controlledAttemptLifecycle(h.pool, 'ds_pool_worker'), h.pool).captureActionAdmissionDelivery(incoming, h.poolConsumer); return incoming;
        });
        assert.equal(messages.length, 1); assert.equal(messages[0].content.toString(), h.expected.transactions[0].dispatch!.canonicalJson);
        await h.pool.processMessages(messages);
        assert.equal(h.poolConsumer.acked[0], messages[0]);
        const docs = h.poolPublisher.sent.map(sent => JSON.parse(sent.payload.toString()));
        assert.deepEqual(docs.map(doc => doc.global_sequence), h.expected.transactions[0].groups.map(group => group.metadata.global_sequence));
        for (const doc of docs) {
            assert.equal(doc.trx_id, transactionId); assert.equal(doc.block_num, 12); assert.equal(doc.block_id, blockId);
            assert.equal(doc.producer, 'producer'); assert.equal(doc.act.data.originalHex, 'abcd');
        }
        const {manifest} = await h.store.journal.readManifest(admission.planId!);
        assert.deepEqual(manifest.fragments[0].effects, docs.map(doc => fingerprintActionHistoryEffect(doc)));
    }

    await check('reader-retention-and-original-schema', async () => {
        const h = await harness(), incoming = await h.sourceMessage();
        const ingress = await h.store.resolveIngress(incoming.properties.headers[actionSourceIngressHeader]);
        assert.equal(ingress.frameHex, h.frame.toString('hex')); assert.equal(ingress.schemaJson, schemaJson);
        await h.main.initializeProtocolShip(JSON.stringify({version: 'newer-current-session', structs: []}));
        await h.parser.parseMessage(h.main, [incoming]);
        assert.equal(h.schemas.at(-1), 'controlled-original'); assert.deepEqual(h.mainConsumer.acked, [incoming]);
        const wrong = {...incoming, content: Buffer.from('tampered')}; (controlledAttemptLifecycle(h.main, 'deserializer'), h.main).captureActionAdmissionDelivery(wrong, h.mainConsumer);
        const before = h.mainPublisher.sent.length;
        await assert.rejects(h.parser.parseMessage(h.main, [wrong]), /retained reader context/);
        assert.equal(h.mainPublisher.sent.length, before); assert.equal(h.mainConsumer.acked.length, 1);
    });

    await check('complete-staging-byte-equality', async () => {
        const h = await harness([rawTransaction([], otherId), rawTransaction([rawAction(1), rawAction(2, 1, 'alice'), rawAction(3)])]);
        const {admission, messages} = await h.admit(); assert.equal(messages.length, 1);
        const dispatch = h.expected.transactions[1].dispatch!;
        assert.equal(messages[0].content.toString(), dispatch.canonicalJson); assert.equal(messages[0].properties.headers.action_trace_ordinal, 1);
        const hookEntered = deferred(), releaseHook = deferred(), secondHook = deferred(), stageEntered = deferred(), releaseStage = deferred();
        let hookCalls = 0, staged = false;
        const retained: any[] = [], settings = h.memory.client.indices.getSettings.bind(h.memory.client.indices);
        h.memory.client.indices.getSettings = async (request: any) => {
            if (request.index === `${chain}-action-v1-000001` && hookCalls === 3 && !staged) {
                staged = true; stageEntered.resolve(); await releaseStage.promise;
            }
            return settings(request);
        };
        h.control.hook = async action => {if (++hookCalls === 1) {hookEntered.resolve(); await releaseHook.promise;}
            retained.push(action); if (hookCalls === 3) secondHook.resolve(); action['@awaited'] = true;};
        const running = h.pool.processMessages(messages);
        await hookEntered.promise;
        assert.equal(h.poolPublisher.sent.length, 0); assert.equal(h.poolConsumer.streamed.length, 0); assert.equal(h.cache.length, 0);
        assert.equal(recordIds(h.memory, 'h45actionfragment1:').length, 1, 'only the explicit empty transaction fragment exists');
        releaseHook.resolve(); await secondHook.promise; await stageEntered.promise;
        assert.equal(h.poolPublisher.sent.length, 0); assert.equal(h.poolConsumer.streamed.length, 0); assert.equal(h.cache.length, 0);
        assert.equal(recordIds(h.memory, 'h45actionfragment1:').length, 1);
        // An executable hook may retain its input. Final bytes must already be detached before target/journal awaits.
        retained[0].global_sequence = '999'; retained[0].act.data.ratio = 99;
        releaseStage.resolve(); await running;
        assert.equal(hookCalls, 3); assert.equal(h.poolPublisher.sent.length, 2);
        assert.equal(h.poolConsumer.streamed.length, 2); assert.equal(h.cache.length, 1);
        const sealed = await h.store.journal.readManifest(admission.planId!);
        assert.deepEqual(sealed.manifest.fragments.map(value => value.effects.length), [0, 2]);
        for (const [index, sent] of h.poolPublisher.sent.entries()) {
            assert.equal(sent.options.persistent, true); assert.equal(sent.options.mandatory, true);
            assert.ok(sent.options.headers.action_fragment_id); assert.equal(sent.options.headers[actionSourceAdmissionHeader], admission.id);
            const doc = JSON.parse(sent.payload.toString());
            assert.equal(doc['@awaited'], true); assert.equal(doc.console, undefined);
            assert.equal(doc.act.data.ratio, 1.25); assert.notEqual(doc.global_sequence, '999');
            assert.equal(sent.payload.toString(), actionHistoryImmutableJson(doc));
            assert.ok(h.poolConsumer.streamed[index].payload.equals(sent.payload));
            assert.ok(h.cache[0].values.get(doc.global_sequence).equals(sent.payload));
            assert.deepEqual(sealed.manifest.fragments[1].effects[index], fingerprintActionHistoryEffect(doc));
        }
        assert.deepEqual(h.poolConsumer.acked, messages);
    });

    await check('confirmed-original-owner-fanout', async () => {
        const h = await harness([rawTransaction([rawAction(1)]), rawTransaction([rawAction(9)], otherId)]);
        const incoming = await h.sourceMessage(); h.mainPublisher.automatic = false; h.mainPublisher.writable = false;
        const running = h.parser.parseMessage(h.main, [incoming]);
        await until(() => h.mainPublisher.sent.length === 1, 'first confirmed fanout');
        const first = h.mainPublisher.sent[0]; first.confirm(); await ticks();
        assert.equal(h.mainConsumer.acked.length, 0); assert.equal(h.mainPublisher.sent.length, 1);
        h.mainPublisher.writable = true; h.mainPublisher.emit('drain');
        await until(() => h.mainPublisher.sent.length === 2, 'second confirmed fanout');
        assert.equal(h.mainConsumer.acked.length, 0); h.mainPublisher.sent[1].confirm(); await running;
        assert.equal(h.mainPublisher.sent.length, 2, 'buffered publication is never resent');
        for (const sent of h.mainPublisher.sent) {assert.equal(sent.options.mandatory, true); assert.equal(sent.options.persistent, true);}
        assert.deepEqual(h.mainConsumer.acked, [incoming]);
        const actions = await harness(), prepared = await actions.admit(); actions.poolPublisher.automatic = false;
        const processing = actions.pool.processMessages(prepared.messages);
        await until(() => actions.poolPublisher.sent.length === 1, 'first action confirmation');
        assert.equal(actions.poolConsumer.streamed.length, 0); assert.equal(actions.cache.length, 0); assert.equal(actions.poolConsumer.acked.length, 0);
        actions.poolPublisher.sent[0].confirm();
        await until(() => actions.poolPublisher.sent.length === 2, 'second action confirmation');
        assert.equal(actions.poolConsumer.streamed.length, 0); assert.equal(actions.cache.length, 0); assert.equal(actions.poolConsumer.acked.length, 0);
        actions.poolPublisher.sent[1].confirm(); await processing;
        assert.equal(actions.poolConsumer.streamed.length, 2); assert.equal(actions.cache.length, 1);
        assert.deepEqual(actions.poolConsumer.acked, prepared.messages);
    });

    await check('empty-and-excluded-membership', async () => {
        for (const [traces, options, expectedCount] of [
            [[], {}, 0], [ [rawTransaction([], otherId)], {}, 1],
            [[rawTransaction([rawAction(1)])], {blacklist: ['token::*']}, 1],
        ] as const) {
            const h = await harness(clone(traces) as any[], options), {admission, messages} = await h.admit();
            assert.equal(messages.length, 0); const sealed = await h.store.journal.readManifest(admission.planId!);
            assert.equal(sealed.manifest.fragments.length, expectedCount);
            assert.ok(sealed.manifest.fragments.every(value => value.effects.length === 0));
            assert.equal(h.poolPublisher.sent.length, 0);
        }
        const h = await harness(undefined, {maxInline: 1}), {messages} = await h.admit();
        assert.deepEqual(h.expected.transactions[0].occurrences.map(value => value.reason), [null, 'max-inline', 'max-inline']);
        assert.deepEqual(JSON.parse(messages[0].content.toString()).action_traces.map((value: any) => value[1].action_ordinal), [1]);
        await h.pool.processMessages(messages); assert.equal(h.poolPublisher.sent.length, 1);
        const roots = await harness(undefined, {rootOnly: true, whitelist: ['token::*']}), rootOnly = await roots.admit();
        assert.equal(rootOnly.messages.length, 0); assert.equal(rootOnly.admission.inventory!.rootAllowed, false);
        assert.equal((rootOnly.admission.source.inventoryInput.traces as any[])[0][1].action_traces.length, 3,
            'root-only exclusion must not erase the original source vector');
        assert.deepEqual(rootOnly.admission.inventory!.transactions[0].occurrences.map(value => value.reason),
            ['root-only', 'root-only', 'root-only']);
        assert.equal((await roots.store.journal.readManifest(rootOnly.admission.planId!)).manifest.fragments[0].effects.length, 0);
    });

    await check('invalid-output-scoped-incomplete', async () => {
        for (const mutation of ['empty', 'drop-group', 'receipt', 'bigint', 'cycle', 'unsafe-counter', 'act-null'] as const) {
            const h = await harness(), {admission, messages} = await h.admit();
            h.control.hook = action => {
                if (mutation === 'empty' || mutation === 'drop-group' && action.action_ordinal === 3) action.except = 'controlled omitted action';
                if (mutation === 'receipt' && action.action_ordinal === 2) action.receipt[1].recv_sequence = '999';
                if (mutation === 'bigint' && action.action_ordinal === 3) action.act.data.invalid = 1n;
                if (mutation === 'cycle' && action.action_ordinal === 3) action.act.data.self = action.act.data;
                if (mutation === 'unsafe-counter' && action.action_ordinal === 3) action.receipt[1].recv_sequence = Number.MAX_SAFE_INTEGER + 1;
                if (mutation === 'act-null' && action.action_ordinal === 1) action.act = null;
            };
            h.poolConsumer.onAck = () => assert.equal(recordIds(h.memory, 'h45actionincomplete1:').length, 1,
                'durable scoped incomplete record precedes original ACK');
            await h.pool.processMessages(messages);
            assert.equal(h.poolPublisher.sent.length, 0); assert.equal(h.poolConsumer.streamed.length, 0); assert.equal(h.cache.length, 0);
            assert.equal(recordIds(h.memory, 'h45actionfragment1:').length, 0);
            assert.equal(await h.store.trySeal(admission), false); assert.deepEqual(h.poolConsumer.acked, messages);
            const failure = await (h.store as any).get(recordIds(h.memory, 'h45actionincomplete1:')[0]);
            assert.equal(failure.admissionId, admission.id); assert.equal(failure.traceOrdinal, 0);
        }
    });

    await check('hook-failure-and-unrelated-progress', async () => {
        for (const reason of [new Error('controlled hook failure'), undefined, null]) {
            const h = await harness([rawTransaction([rawAction(1)]), rawTransaction([rawAction(9)], otherId)]);
            const {admission, messages} = await h.admit();
            h.control.hook = async action => {if (action.action_ordinal === 1) {await Promise.resolve(); return Promise.reject(reason);}};
            const entered = deferred(), release = deferred();
            let incompleteStarted = false;
            h.memory.faults.beforeWrite = async (request: any) => {
                if (request.document.kind === 'manifest' && request.id.startsWith('h45actionincomplete1:')) {
                    incompleteStarted = true; entered.resolve(); await release.promise;
                }
            };
            h.poolConsumer.onAck = message => {
                if (message === messages[0]) {
                    assert.equal(recordIds(h.memory, 'h45actionincomplete1:').length, 1,
                        'Scoped incomplete receipt precedes the original failed transaction ACK');
                    assert.equal(recordIds(h.memory, 'h45actionfragment1:').length, 0, 'Failed hook must not certify empty membership');
                }
            };
            const running = h.pool.processMessages(messages); let completed = false;
            running.then(() => {completed = true;}, () => {completed = true;});
            await until(() => incompleteStarted || completed, 'scoped incomplete hook settlement');
            assert.equal(incompleteStarted, true, 'Every rejected hook, including null/undefined, needs scoped incomplete retention');
            await entered.promise;
            assert.equal(h.poolConsumer.acked.length, 0); assert.equal(h.poolPublisher.sent.length, 0);
            assert.equal(h.poolConsumer.streamed.length, 0); assert.equal(h.cache.length, 0);
            assert.equal(recordIds(h.memory, 'h45actionfragment1:').length, 0);
            release.resolve(); await running;
            assert.deepEqual(h.poolConsumer.acked, messages); assert.equal(h.poolPublisher.sent.length, 1);
            assert.equal(JSON.parse(h.poolPublisher.sent[0].payload.toString()).trx_id, otherId);
            assert.equal(h.poolConsumer.streamed.length, 1); assert.equal(h.cache.length, 1);
            assert.equal(recordIds(h.memory, 'h45actionincomplete1:').length, 1);
            assert.equal(recordIds(h.memory, 'h45actionfragment1:').length, 1);
            const failure = await (h.store as any).get(recordIds(h.memory, 'h45actionincomplete1:')[0]);
            assert.equal(failure.admissionId, admission.id); assert.equal(failure.traceOrdinal, 0);
            assert.equal(await h.store.trySeal(admission), false);
        }
        const failed = await harness(), retry = await failed.admit();
        failed.control.hook = () => {throw new Error('controlled hook failure');};
        failed.memory.faults.beforeWrite = (request: any) => {
            if (request.document.kind === 'manifest' && request.id.startsWith('h45actionincomplete1:')) throw new Error('controlled retention unavailable');
        };
        await assert.rejects(failed.pool.processMessages(retry.messages), /controlled retention unavailable/);
        assert.equal(failed.poolConsumer.acked.length, 0); assert.equal(failed.poolPublisher.sent.length, 0);
    });

    await check('grouping-hook-corruption-and-unrelated-progress', async () => {
        await assertCrossActionCorruptionIsScoped(retained => {retained.receipt = null;});
        await assertCrossActionCorruptionIsScoped(retained => {
            assert.equal(retained.console, 'source console', 'Truthy source console must exercise the enabled metadata path');
            retained.act = null;
        }, true);
    });

    await check('post-hook-normalization-corruption-and-unrelated-progress', async () => {
        await assertCrossActionCorruptionIsScoped(retained => {retained.receipt.recv_sequence = '18446744073709551616';});
        await assertCrossActionCorruptionIsScoped(retained => {retained.global_sequence = '18446744073709551616';});
    });

    await check('main-source-delivery-snapshot-during-awaits', async () => {
        for (const stage of ['resolve-ingress', 'verified-source-context', 'retain-source'] as const) {
            const h = await harness(), incoming = await h.sourceMessage();
            const ingressId = incoming.properties.headers[actionSourceIngressHeader];
            const entered = deferred(), release = deferred();
            if (stage !== 'verified-source-context') {
                const name = stage === 'resolve-ingress' ? 'resolveIngress' : 'retainSource';
                const store: any = h.store, original = store[name]; let held = false;
                store[name] = async function (...args: any[]) {
                    if (!held) {held = true; entered.resolve(); await release.promise;}
                    return original.apply(this, args);
                };
            }
            const running = stage === 'verified-source-context'
                ? h.main.processAdmittedSourceDelivery(incoming, async (result: any) => {
                    entered.resolve(); await release.promise;
                    // Invoke the actual parser callback after a controlled context await, with the original ACK object.
                    await h.parser.processResult(h.main, incoming, result);
                }) : h.parser.parseMessage(h.main, [incoming]);
            running.catch(() => {}); await entered.promise;
            assert.equal(h.mainConsumer.acked.length, 0); assert.equal(h.mainPublisher.sent.length, 0);
            assert.equal(recordIds(h.memory, 'h45actionadmission1:').length, 0);
            corruptDelivery(incoming, true); release.resolve(); await running;
            await assertOriginalSourceAndOutputs(h, incoming, ingressId);
        }
    });

    await check('pool-delivery-snapshot-during-awaits', async () => {
        for (const stage of ['resolve-admission', 'target', 'verified-admission'] as const) {
            const h = await harness(), {admission, messages} = await h.admit();
            const incoming = messages[0], originalHeaders = clone(incoming.properties.headers);
            const entered = deferred(), release = deferred(), parsedHeaders: any[] = [];
            const originalTraces = h.pool.processTraces;
            h.pool.processTraces = async function (value: any, headers: any) {
                parsedHeaders.push(clone(headers)); return originalTraces.call(this, value, headers);
            };
            const object: any = stage === 'resolve-admission' ? h.store : h.pool;
            const name = stage === 'resolve-admission' ? 'resolve' : stage === 'target' ? 'actionTarget' : 'beginActionAdmission';
            const original = object[name]; let held = false;
            object[name] = async function (...args: any[]) {
                if (held) return original.apply(this, args);
                held = true;
                const result = stage === 'verified-admission' ? await original.apply(this, args) : undefined;
                entered.resolve(); await release.promise;
                return stage === 'verified-admission' ? result : original.apply(this, args);
            };
            const running = h.pool.processMessages(messages); running.catch(() => {}); await entered.promise;
            assert.equal(h.poolConsumer.acked.length, 0); assert.equal(h.poolPublisher.sent.length, 0);
            assert.equal(h.poolConsumer.streamed.length, 0); assert.equal(h.cache.length, 0);
            assert.equal(h.control.decoded.length, 0); assert.equal(recordIds(h.memory, 'h45actionfragment1:').length, 0);
            corruptDelivery(incoming, false); release.resolve(); await running;
            assert.equal(h.poolConsumer.acked.length, 1); assert.equal(h.poolConsumer.acked[0], incoming);
            assert.deepEqual(parsedHeaders, [originalHeaders], 'Actual DS must consume detached original headers');
            assert.deepEqual(h.control.decoded, ['abcd', 'abcd', 'abcd'], 'Hooks/decoder must consume original verified action bytes');
            const docs = h.poolPublisher.sent.map(sent => JSON.parse(sent.payload.toString()));
            assert.deepEqual(docs.map(doc => doc.global_sequence), h.expected.transactions[0].groups.map(group => group.metadata.global_sequence));
            for (const doc of docs) {
                assert.equal(doc.trx_id, transactionId); assert.equal(doc.block_num, 12); assert.equal(doc.block_id, blockId);
                assert.equal(doc.producer, 'producer'); assert.equal(doc['@timestamp'], originalHeaders.ts);
                assert.equal(doc.act.data.originalHex, 'abcd');
            }
            const {manifest} = await h.store.journal.readManifest(admission.planId!);
            assert.deepEqual(manifest.fragments[0].effects, docs.map(doc => fingerprintActionHistoryEffect(doc)));
            assert.equal(recordIds(h.memory, 'h45actionincomplete1:').length, 0);
        }
    });

    await check('wrong-body-and-headers-before-effects', async () => {
        const h = await harness(), {messages} = await h.admit();
        for (const mutation of [
            (value: any) => {value.content = Buffer.from('{}');},
            (value: any) => {value.properties.headers.action_trace_ordinal = 7;},
            (value: any) => {value.properties.headers.block_id = '0'.repeat(64);},
            (value: any) => {value.properties.headers.inline_count++;},
            (value: any) => {value.properties.headers.filtered = true;},
            (value: any) => {value.properties.headers[actionSourceAdmissionHeader] = 'h45actionadmission1:' + '0'.repeat(64);},
        ]) {
            const bad = {...messages[0], content: Buffer.from(messages[0].content), properties: clone(messages[0].properties)};
            mutation(bad); (controlledAttemptLifecycle(h.pool, 'ds_pool_worker'), h.pool).captureActionAdmissionDelivery(bad, h.poolConsumer);
            await assert.rejects(h.pool.processMessages([bad]));
            assert.equal(h.control.decoded.length, 0); assert.equal(h.poolPublisher.sent.length, 0);
            assert.equal(h.poolConsumer.acked.length, 0); assert.equal(h.cache.length, 0); assert.equal(h.poolConsumer.streamed.length, 0);
            assert.equal(recordIds(h.memory, 'h45actionfragment1:').length, 0);
        }
    });

    await check('original-channel-and-return-fences', async () => {
        const h = await harness(), incoming = await h.sourceMessage(), replacement = new ControlledConsumer();
        assert.throws(() => (controlledAttemptLifecycle(h.main, 'deserializer'), h.main).captureActionAdmissionDelivery(incoming, replacement), /replace.*consumer/);
        h.main.ch = replacement;
        await assert.rejects(h.parser.parseMessage(h.main, [incoming]), /channels.*unavailable/);
        assert.equal(h.mainPublisher.sent.length, 0); assert.equal(h.mainConsumer.acked.length, 0); assert.equal(replacement.acked.length, 0);
        h.main.ch = h.mainConsumer; h.mainPublisher.automatic = false;
        // A broker redelivery is a new physical receipt, even when its original bytes are identical.
        const redelivery = {...incoming, content: Buffer.from(incoming.content), properties: clone(incoming.properties)};
        h.main.captureActionAdmissionDelivery(redelivery, h.mainConsumer);
        const running = h.parser.parseMessage(h.main, [redelivery]);
        await until(() => h.mainPublisher.sent.length === 1, 'mandatory return');
        const sent = h.mainPublisher.sent[0]; h.mainPublisher.emit('return', {properties: {messageId: sent.options.messageId}});
        sent.confirm(); // The outer failure does not fabricate completion of the actual outstanding confirm.
        await assert.rejects(running, /unroutable/); assert.equal(h.mainConsumer.acked.length, 0);
        const stale = await harness(), source = await stale.sourceMessage(); stale.mainPublisher.automatic = false;
        const pending = stale.parser.parseMessage(stale.main, [source]);
        await until(() => stale.mainPublisher.sent.length === 1, 'publisher replacement');
        stale.main.cch = new ControlledPublisher(); stale.mainPublisher.sent[0].confirm();
        await assert.rejects(pending, /channels changed/); assert.equal(stale.mainConsumer.acked.length, 0);
        const pooled = await harness(), admitted = await pooled.admit(), entered = deferred(), release = deferred();
        pooled.control.hook = async () => {entered.resolve(); await release.promise;};
        const work = pooled.pool.processMessages(admitted.messages); await entered.promise;
        const newPoolConsumer = new ControlledConsumer(); pooled.pool.ch = newPoolConsumer; release.resolve();
        await assert.rejects(work, /lost.*epoch/);
        assert.equal(pooled.poolConsumer.acked.length, 0); assert.equal(newPoolConsumer.acked.length, 0);
        assert.equal(pooled.poolPublisher.sent.length, 0); assert.equal(recordIds(pooled.memory, 'h45actionfragment1:').length, 0);

        // Exercise the production native-admission socket callbacks, batch processor and send method.
        // The JSON codec/queue transport remain controlled; no network or native-addon claim is made.
        const native = await harness(), reader = native.reader, envelopes: any[] = [], sockets: any[] = [], commands: any[] = [];
        reader.shipRev = 'v0'; reader.reconnectCount = 0; reader.send = (Reader.prototype as any).send;
        reader.blockReadingQueue = {push: async (item: any) => {envelopes.push(item);}};
        reader.ship = {connected: false, close() {this.connected = false;}, nextUrl() {},
            connect(message: Function, disconnect: Function, error: Function, open: Function) {sockets.push({message, disconnect, error, open});},
            send(bytes: Buffer) {commands.push({socket: sockets.length, request: JSON.parse(bytes.toString())});}};
        const drain = async () => {if (envelopes.length) await reader.processIncomingBlocks(envelopes.splice(0));};
        const open = async () => {reader.startWS(); reader.ship.connected = true; const socket = sockets.at(-1); socket.open(); await drain(); return socket;};
        const status = Buffer.from(JSON.stringify(['get_status_result_v1', {chain_id: chainId}]));
        const old = await open(); assert.equal(reader.usesExtensionProtocol, false); assert.equal(reader.usesOrderedSourceIngress, true);
        old.message(Buffer.from(schemaJson)); await drain(); old.message(status); await drain();
        assert.deepEqual(commands.map(command => command.request[0]), ['get_status_request_v0']);
        reader.requestBlockRange(12, 13);
        assert.equal(commands.at(-1).socket, 1); assert.equal(commands.at(-1).request[0], 'get_blocks_request_v0',
            'Native request outside a batch uses its original action-source session generation');
        native.readerPublisher.automatic = false; old.message(native.frame); const held = drain();
        await until(() => native.readerPublisher.sent.length === 1, 'native broker confirmation');
        const beforeReconnect = commands.length, originalTimeout = globalThis.setTimeout; let reconnect: (() => void) | undefined;
        try {
            globalThis.setTimeout = ((callback: (...args: any[]) => void, delay: number, ...args: any[]) => {
                if (delay === 5000) {reconnect = () => callback(...args); return {unref() {return this;}};}
                return originalTimeout(callback, delay, ...args);
            }) as any;
            old.disconnect();
        } finally {globalThis.setTimeout = originalTimeout;}
        assert.equal(typeof reconnect, 'function'); reconnect!();
        const next = sockets.at(-1); reader.ship.connected = true; next.open();
        assert.equal(reader.physicalIngressGeneration, 2); native.readerPublisher.sent[0].confirm(); await held;
        assert.equal(commands.length, beforeReconnect, 'Old confirmation cannot grant source credit on the replacement socket');
        await drain(); old.open(); assert.equal(reader.physicalIngressGeneration, 2, 'Late old open cannot restore the obsolete socket');
        old.message(native.frame); await drain();
        assert.equal(recordIds(native.memory, 'h45actionrejected1:').length, 1, 'Stale native frame is retained as rejected input');
        assert.equal(commands.length, beforeReconnect);
        next.message(Buffer.from(schemaJson)); await drain();
        assert.equal(commands.at(-1).socket, 2); assert.equal(commands.at(-1).request[0], 'get_status_request_v0');
        const beforeVerified = commands.length; reader.requestBlockRange(12, 13);
        assert.equal(commands.length, beforeVerified, 'Unverified replacement session gets no block request');
        next.message(status); await drain(); reader.requestBlockRange(12, 13);
        assert.equal(commands.at(-1).socket, 2); assert.equal(commands.at(-1).request[0], 'get_blocks_request_v0');
        assert.equal(commands.filter(command => command.request[0] === 'get_blocks_ack_request_v0').length, 0);
    });

    await check('uppercase-native-source-shape', async () => {
        const h = await harness([rawTransaction([rawAction(1, 0, 'token', true)], transactionId.toUpperCase())]);
        const {admission, messages} = await h.admit();
        assert.equal(admission.inventory!.transactions[0].transactionId, transactionId);
        assert.equal(JSON.parse(messages[0].content.toString()).id, transactionId.toUpperCase(), 'dispatch retains original trace body');
        await h.pool.processMessages(messages); assert.equal(h.poolPublisher.sent.length, 1);
        const output = JSON.parse(h.poolPublisher.sent[0].payload.toString());
        assert.equal(output.trx_id, transactionId); assert.equal(output.act_digest, 'ABCDEF'.repeat(10) + 'ABCD');
        assert.equal(output.act.data.originalHex, 'ABCD');
        assert.equal((await h.store.journal.readManifest(admission.planId!)).manifest.fragments[0].effects.length, 1);
    });

    console.log(JSON.stringify({passed: true, fixture: 'source-prototype-controlled-codec-client-channels', nativeQualification: false,
        consensusValidation: false, checks}));
} finally {
    process.chdir(oldDirectory);
    const ownedDirectory = resolve(directory);
    assert.equal(dirname(ownedDirectory), resolve(tmpdir()));
    assert.match(basename(ownedDirectory), /^hyperion-action-admission-worker-/);
    rmSync(ownedDirectory, {recursive: true, force: true});
}
