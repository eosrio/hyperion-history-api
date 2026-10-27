import { Client } from "@elastic/elasticsearch";
import { EventEmitter } from "events";
import type {ProtocolProvider, ProtocolShipSession, ProtocolComponent} from "@eosrio/hyperion-sdk/protocol";
import {loadChainProtocol} from "../protocol/selection.js";
import {ContractDecoder, protocolBytes, protocolNumber} from "../protocol/contract-cache.js";
import {protocolAbiCaptureDigest, type ProtocolAbiObservationRecord} from '../protocol/abi-observation-store.js';
import type {ProtocolSourcePosition} from '../protocol/source-bindings.js';
import { Channel, ConfirmChannel } from "amqplib";

import { HyperionConfig } from "../../interfaces/hyperionConfig.js";
import { ConnectionManager } from "../connections/manager.class.js";
import { HyperionModuleLoader } from "../modules/loader.js";
import { ConfigurationModule, Filters } from "../modules/config.js";
import { debugLog, hLog } from "../helpers/common_functions.js";
import { StateHistorySocket } from "../connections/state-history.js";
import { BasicDelta } from "../../interfaces/hyperion-delta.js";
import { getHeapStatistics, HeapInfo } from "node:v8";
import { HyperionActionAct } from "../../interfaces/hyperion-action.js";
import { Action, APIClient, PackedTransaction } from "@wharfkit/antelope";
import {inflateSync} from 'node:zlib';
import { HyperionAbi } from "../../interfaces/hyperion-abi.js";
import { WorkerProfiler } from "../helpers/profiler.js";
import {ActionSourceAdmissionStore} from '../history/action-source-admission.js';
import {publishAdmittedAction, bindActionPublicationOwnerToScope, bindActionQueuedPublicationLineage, type ActionPublicationOwner} from '../history/action-confirmed-publication.js';
import {queuedPublicationData} from '../history/queued-publication-lineage.js';
import {createHash, randomUUID} from 'node:crypto';
import {serialize} from 'node:v8';
import {WorkerProofDemandObserver} from '../history/action-proof-demand-enrollment.js';
import type {Message} from 'amqplib';
import {actionHistoryImmutableJson} from '../history/action-history-manifest.js';
import {WorkerAttemptClient, createControlledLocalAttemptClient, type WorkerAttempt} from '../protocol/worker-attempt-client.js';
import type {WorkerAttemptBinding, WorkerAttemptKind, WorkerAttemptRole} from '../protocol/worker-attempt-supervisor.js';
import {currentProofConsumerScope, assertProofConsumerCapability, trackProofConsumerOperation} from '../protocol/proof-consumer-scope.js';

const maximumProjectionInitializationAttempts = 4;

// Broker-decoded headers may contain bytes, timestamps or undefined fields, unlike portable action JSON.
function workerAttemptHeadersSha256(headers: unknown): string {
    let budget = 0, nodes = 0; const seen = new Set<object>();
    const add = (bytes: number) => {budget += bytes; if (budget > 64 * 1024) throw new Error('Worker attempt original header budget exhausted');};
    const visit = (value: unknown, depth: number): void => {
        if (++nodes > 4096 || depth > 32) throw new Error('Worker attempt original header structure budget exhausted');
        add(32);
        if (typeof value === 'string') {if (value.length > 64 * 1024) add(64 * 1024); add(Buffer.byteLength(value)); return;}
        if (value == null || ['number','boolean','bigint','undefined'].includes(typeof value)) return;
        if (value instanceof Uint8Array) {add(value.byteLength); return;}
        if (value instanceof Date) return;
        if (typeof value !== 'object' || seen.has(value)) throw new Error('Original worker headers are not bounded typed data');
        const prototype = Object.getPrototypeOf(value);
        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error('Unsupported original worker header type');
        seen.add(value);
        for (const key in value) if (Object.hasOwn(value, key)) {
            add(key.length * 3); const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !('value' in descriptor)) throw new Error('Original worker header accessor is unavailable');
            visit(descriptor.value, depth + 1);
        }
        seen.delete(value);
    };
    visit(headers, 0);
    const bytes = serialize(headers);
    if (bytes.length > 64 * 1024) throw new Error('Worker attempt original header budget exhausted');
    return createHash('sha256').update(bytes).digest('hex');
}

/** Exact stable sections; mutable head/LIB remain in the separately bound frame. */
export function protocolSourceCapture(chainId: string, result: any, schemaJson: string) {
    const source: ProtocolSourcePosition = {chainId, blockNum: protocolNumber(result.this_block?.block_num),
        blockId: result.this_block?.block_id?.toString().toLowerCase() ?? '',
        previousBlockId: result.prev_block?.block_id?.toString().toLowerCase() ?? null};
    const section = (value: unknown) => value === null || value === undefined ? null : Buffer.from(protocolBytes(value)).toString('hex');
    const capture: ProtocolAbiObservationRecord['capture'] = {kind: 'unattested-ship-result-sections-v1', schemaJson,
        blockHex: section(result.block), tracesHex: section(result.traces), deltasHex: section(result.deltas)};
    return {source, capture, captureSha256: protocolAbiCaptureDigest(source, capture)};
}

/** Only a pure decoder invocation under an immutable delivery context creates this marker. */
export class ProtocolSourceCodecError extends Error {
    constructor(readonly datatype: string, cause: unknown) {
        super(`Protocol ${datatype} decode failed: ${String((cause as any)?.message ?? cause)}`, {cause});
        this.name = 'ProtocolSourceCodecError';
    }
}

export abstract class HyperionWorker {

    conf: HyperionConfig;
    manager: ConnectionManager;
    mLoader: HyperionModuleLoader;
    chain: string;
    chainId: string;
    profiler: WorkerProfiler;

    rpc: APIClient;
    client: Client;
    ship: StateHistorySocket;

    // AMQP Channels
    ch?: Channel;
    cch?: ConfirmChannel;

    pushedBlocks = 0;
    cch_ready = false;
    ch_ready = false;

    events: EventEmitter;

    filters: Filters;

    failedAbiMap: Map<string, Set<number>> = new Map();
    protected abieos!: ContractDecoder;
    protocol!: ProtocolProvider;
    protocolId!: string;
    protocolComponents?: readonly ProtocolComponent[];
    protocolReady!: Promise<void>;
    shipSession?: ProtocolShipSession;
    private protocolShipAbi?: unknown;
    protected protocolShipAbiJson?: string;
    private deliveryShipContext?: {session: ProtocolShipSession; abi: unknown; schemaJson: string};
    configModule: ConfigurationModule;
    private actionAdmissionStore?: ActionSourceAdmissionStore;
    private readonly actionAdmissionOwners = new WeakMap<object, Channel>();
    protected workerAttemptClient?: WorkerAttemptClient;
    private workerAttemptDeliveries?: WeakMap<object, {handle: WorkerAttempt; receiptId: string; payloadSha256: string; headersSha256: string | null; consumer: Channel}>;
    private proofDemandObserver?: WorkerProofDemandObserver;
    /** Explicit internal engineering injection; ordinary workers do not enroll diagnostics. */
    configureProofDemandObserver(observer: WorkerProofDemandObserver): void {
        if (this.workerAttemptDeliveries || !(observer instanceof WorkerProofDemandObserver)) throw new Error('Observer must be installed before physical receipt');
        this.proofDemandObserver = observer;
    }
    private workerAttemptChannels?: WeakMap<object, string>;
    private workerAttemptChannelListeners?: WeakSet<object>;

    get workerAttemptScopeRequired(): boolean {return this.workerAttemptClient?.mode !== 'controlled-local-only';}
    protected get tracksWorkerAttempts(): boolean {return !!this.workerAttemptClient || this.usesExtensionProtocol || this.actionSourceAdmissionEnabled;}
    /** Explicit test/component transport only; never a master-accepted end or an environment bypass. */
    installControlledAttemptLifecycle(role: WorkerAttemptRole): void {
        if (this.workerAttemptClient?.mode === 'controlled-local-only' && this.workerAttemptClient.role === role) return;
        this.configureWorkerAttemptLifecycle(createControlledLocalAttemptClient(role));
    }
    configureWorkerAttemptLifecycle(client: WorkerAttemptClient): void {
        if (this.workerAttemptDeliveries) throw new Error('Cannot replace a worker lifecycle after physical receipt');
        this.workerAttemptClient?.dispose(); this.workerAttemptClient = client;
    }
    private attemptClient(): WorkerAttemptClient {
        if (!this.workerAttemptClient) throw new Error('Managed worker attempt lifecycle is not configured; standalone fixtures require explicit local-only setup');
        return this.workerAttemptClient;
    }
    private attemptChannelId(channel: object | undefined): string | null {
        if (!channel) return null;
        this.workerAttemptChannels ??= new WeakMap(); this.workerAttemptChannelListeners ??= new WeakSet();
        let id = this.workerAttemptChannels.get(channel);
        if (!id) {id = randomUUID(); this.workerAttemptChannels.set(channel, id);}
        if (!this.workerAttemptChannelListeners.has(channel)) {
            this.workerAttemptChannelListeners.add(channel); const captured = id;
            (channel as Channel).once?.('close', () => this.workerAttemptClient?.fenceChannel(captured));
        }
        return id;
    }
    captureWorkerAttemptDelivery(message: Message, channel: Channel, kind: 'source-delivery' | 'ds-delivery'): void {
        if (!this.tracksWorkerAttempts) return;
        this.workerAttemptDeliveries ??= new WeakMap();
        const previous = this.workerAttemptDeliveries.get(message);
        if (previous) {if (previous.consumer !== channel) throw new Error('Cannot replace original attempt consumer'); return;}
        const payloadSha256 = createHash('sha256').update(message.content).digest('hex');
        let headersSha256: string | null;
        try {headersSha256 = workerAttemptHeadersSha256(message.properties?.headers ?? {});} catch {headersSha256 = null;}
        const receiptId = randomUUID();
        const handle = this.attemptClient().capture({kind, receiptId, payloadSha256, headersSha256,
            consumerId: this.attemptChannelId(channel), publisherId: this.attemptChannelId(this.cch),
            queue: typeof process.env.worker_queue === 'string' ? process.env.worker_queue : null,
            deliveryTag: Number.isSafeInteger(message.fields?.deliveryTag) ? message.fields.deliveryTag : null},
            kind === 'ds-delivery' && this.attemptClient().queuedPublicationLineageRequested ? {
                messageId: message.properties.messageId ?? '', redelivered: message.fields.redelivered === true,
                data: queuedPublicationData(typeof process.env.worker_queue === 'string' ? process.env.worker_queue : '', message.content, message.properties.headers ?? {})
            } : undefined);
        this.workerAttemptDeliveries.set(message, {handle, receiptId, payloadSha256, headersSha256, consumer: channel});
        if (kind === 'ds-delivery' && this.proofDemandObserver) try {
            const content = Object.getOwnPropertyDescriptor(message, 'content')?.value;
            const properties = Object.getOwnPropertyDescriptor(message, 'properties')?.value;
            const headers = properties && Object.getOwnPropertyDescriptor(properties, 'headers')?.value;
            this.proofDemandObserver.capture(receiptId, content, headers);
        } catch {}
    }
    protected observeProofDemandBinding(message: Message, admission: {source: {inventoryInput: {source: any; sourceSelectionId?: string}; previousBlockId: string | null}; id: string}, traceOrdinal: number): void {
        try {
            const receipt = this.workerAttemptDeliveries?.get(message); if (!receipt) return;
            const source = admission.source.inventoryInput.source;
            this.proofDemandObserver?.bound(receipt.receiptId, {admissionId: admission.id, traceOrdinal,
                source: {chainId: source.chainId, blockNum: source.blockNum, blockId: source.blockId,
                    previousBlockId: admission.source.previousBlockId, selectionId: admission.source.inventoryInput.sourceSelectionId ?? null}});
        } catch {}
    }
    async runWorkerAttemptDelivery<T>(message: Message, operation: () => T | Promise<T>): Promise<T> {
        if (!this.tracksWorkerAttempts) return operation();
        const retained = this.workerAttemptDeliveries?.get(message);
        if (!retained) throw new Error('Worker attempt lacks its original physical ingress');
        return this.attemptClient().run(retained.handle, () => {
            if (retained.headersSha256 === null) throw new Error('Original worker header snapshot is unavailable; raw custody is retained');
            if (createHash('sha256').update(message.content).digest('hex') !== retained.payloadSha256
                || workerAttemptHeadersSha256(message.properties?.headers ?? {}) !== retained.headersSha256)
                throw new Error('Original queued worker attempt bytes/headers changed');
            return operation();
        });
    }
    async runProjectionAttempt<T>(kind: Extract<WorkerAttemptKind, 'projection-initialization' | 'projection-frame'>,
                                  metadata: unknown, operation: () => T | Promise<T>, mayRetryInitialization?: () => boolean): Promise<T> {
        const client = this.attemptClient();
        for (let attempt = 1; ; attempt++) {
            const bytes = actionHistoryImmutableJson(metadata), digest = createHash('sha256').update(bytes).digest('hex');
            const handle = client.capture({kind, receiptId: randomUUID(), payloadSha256: digest,
                headersSha256: createHash('sha256').update('{}').digest('hex'), consumerId: null, publisherId: null, queue: null, deliveryTag: null});
            try {return await client.run(handle, operation);}
            catch (error) {
                if (kind !== 'projection-initialization' || attempt >= maximumProjectionInitializationAttempts || !mayRetryInitialization?.()
                    || !client.consumeProjectionInitializationRetry(handle, error)) throw error;
            }
        }
    }
    async bindWorkerAttempt(fields: WorkerAttemptBinding): Promise<void> {await this.attemptClient().bindCurrent(fields);}
    /** A fresh store return is forwarded by its original scoped worker; controlled fixtures have no parent authority. */
    async observeFreshActionWrite(result: object): Promise<boolean> {
        const client = this.attemptClient();
        return client.mode === 'managed' ? client.observeFreshActionWrite(result) : false;
    }
    markWorkerAcknowledgementAttempt(): void {if (currentProofConsumerScope()) this.attemptClient().markAcknowledgementAttempt();}
    settleOriginalWorkerDelivery(message: Message, negative = false): void {
        if (!this.tracksWorkerAttempts) {negative ? this.ch?.nack(message) : this.ch?.ack(message); return;}
        const retained = this.workerAttemptDeliveries?.get(message);
        if (!retained || retained.consumer !== this.ch || !this.ch_ready) throw new Error('Original worker settlement channel is unavailable');
        this.attemptClient().assertCurrent(retained.handle);
        if (negative) retained.consumer.nack(message);
        else {this.markWorkerAcknowledgementAttempt(); retained.consumer.ack(message);}
    }
    assertWorkerAttemptActive(): void {currentProofConsumerScope()?.assertActive();}
    /** Observable backpressure after synchronous byte handoff; no physical flush or broker confirmation. */
    workerBufferedPublication(channel: Channel, send: () => boolean): boolean {
        const scope = currentProofConsumerScope(); if (!scope) return send();
        scope.assertActive(); let writable = false, ended = false, invoked = false, drained = false, closed = false, uncertain = false;
        let resolve!: () => void;
        void scope.operation(() => new Promise<void>(yes => {resolve = yes;}));
        const cleanup = () => {channel.off('drain', onDrain); channel.off('close', onClose);};
        const finish = () => {if (!ended && invoked && (closed || !uncertain && (writable || drained))) {ended = true; cleanup(); resolve();}};
        const onDrain = () => {drained = true; finish();}, onClose = () => {closed = true; finish();};
        channel.on('drain', onDrain); channel.on('close', onClose);
        try {scope.assertActive(); writable = send();}
        catch (error) {uncertain = true; throw error;}
        finally {invoked = true; finish();}
        return writable;
    }
    /** Methods exposed to hooks retain the issuing attempt even when saved and invoked in another context. */
    scopedHookWorker(): this {
        const scope = currentProofConsumerScope(); if (!scope) return this;
        const target = this, methods = new Map<PropertyKey, {value: unknown; bound: unknown}>();
        const helperObjects = new WeakMap<object, object>();
        const helpers = (value: object) => {
            let prior = helperObjects.get(value); if (prior) return prior;
            const references = new Map<PropertyKey, {value: unknown; bound: unknown}>();
            prior = new Proxy(value, {get(object, key) {
                scope.assertActive(); const member = Reflect.get(object, key, object);
                if (typeof member !== 'function') return member;
                const cached = references.get(key); if (cached && cached.value === member) return cached.bound;
                const bound = scope.bindCallback(member as (...args: any[]) => any, object);
                references.set(key, {value: member, bound}); return bound;
            }});
            helperObjects.set(value, prior); return prior;
        };
        return new Proxy(this, {get(_object, key) {
            scope.assertActive(); const value = Reflect.get(target, key, target);
            if (key === 'common' && value && typeof value === 'object') return helpers(value);
            if (typeof value !== 'function') return value;
            const prior = methods.get(key); if (prior?.value === value) return prior.bound;
            const bound = scope.bindCallback(value as (...args: any[]) => any, target); methods.set(key, {value, bound}); return bound;
        }});
    }

    /** Internal engineering seam. Public activation requires the remaining #225 qualification gates. */
    get actionSourceAdmissionEnabled(): boolean {return false;}

    private actionSourceBindingMode?: boolean;
    /** Shared source lifecycle; builtin live qualification uses the existing engineering admission gate. */
    get usesProtocolSourceBindings(): boolean {
        if (this.usesExtensionProtocol) return true;
        return this.actionSourceBindingMode ??= this.actionSourceAdmissionEnabled && this.conf?.indexer?.live_reader === true;
    }

    getActionAdmissionStore(): ActionSourceAdmissionStore {
        return this.actionAdmissionStore ??= new ActionSourceAdmissionStore(this.client, this.chain, this.conf.settings.es_replicas ?? 0);
    }
    captureActionAdmissionDelivery(message: object, channel: Channel): void {
        const previous = this.actionAdmissionOwners.get(message);
        if (previous && previous !== channel) throw new Error('Cannot replace an admitted action consumer receipt');
        this.actionAdmissionOwners.set(message, channel);
        this.captureWorkerAttemptDelivery(message as Message, channel,
            this.attemptClient().role === 'deserializer' ? 'source-delivery' : 'ds-delivery');
    }
    actionPublicationOwner(message: object): ActionPublicationOwner {
        const consumer = this.actionAdmissionOwners.get(message), publisher = this.cch;
        if (!consumer || !publisher) throw new Error('Admitted action lacks its original consumer/publisher channels');
        const scope = currentProofConsumerScope();
        const owner = {consumer, publisher, current: () => {
            try {assertProofConsumerCapability(scope);} catch {return false;}
            return consumer === this.ch && publisher === this.cch && this.ch_ready && this.cch_ready;
        }};
        if (!owner.current()) throw new Error('Admitted action channels are unavailable');
        if (this.workerAttemptClient?.queuedPublicationLineageEnabled && this.workerAttemptClient.role === 'deserializer')
            bindActionQueuedPublicationLineage(owner, (queue, payload, headers) => this.workerAttemptClient!.prepareQueuedPublication(queue, payload, headers));
        return bindActionPublicationOwnerToScope(owner);
    }
    async publishAdmitted(owner: ActionPublicationOwner, queue: string, content: Buffer, headers: any): Promise<void> {
        await publishAdmittedAction(owner, queue, content, {headers});
    }
    async actionTarget(blockNum: number, provision = false): Promise<{name: string; uuid: string}> {
        return trackProofConsumerOperation(async () => {
        const settings = this.conf.settings;
        if (!Number.isSafeInteger(blockNum) || blockNum < 1 || !Number.isSafeInteger(settings.index_partition_size)
            || settings.index_partition_size < 1) throw new Error('Invalid admitted action partition');
        const name = `${this.chain}-action-${settings.index_version}-${Math.ceil(blockNum / settings.index_partition_size).toString().padStart(6, '0')}`;
        if (provision) {
            const exists = await this.client.indices.exists({index: name});
            this.assertWorkerAttemptActive();
            if (!exists) {
                try {
                    const result = await this.client.indices.create({index: name});
                    if (result.acknowledged !== true || result.shards_acknowledged !== true || result.index !== name)
                        throw new Error('Action admission target creation was not acknowledged');
                } catch (error: any) {
                    if (error?.meta?.statusCode !== 400 || error?.meta?.body?.error?.type !== 'resource_already_exists_exception') throw error;
                }
            }
        }
        this.assertWorkerAttemptActive();
        const result = await this.client.indices.getSettings({index: name, flat_settings: true});
        const uuid = result[name]?.settings?.['index.uuid'];
        if (Object.keys(result).length !== 1 || typeof uuid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uuid))
            throw new Error('Action admission requires a concrete target UUID');
        this.assertWorkerAttemptActive(); return {name, uuid};
        });
    }

    protected constructor() {
        this.checkDebugger();
        const cm = new ConfigurationModule();
        this.configModule = cm;
        this.conf = cm.config;

        const isProfilingEnabled = !!this.conf.settings?.ds_profiling;
        const workerRole = process.env.worker_role || 'unknown';
        const workerId = process.env.worker_id || 'unknown';
        this.profiler = new WorkerProfiler(workerRole, workerId, isProfilingEnabled);
        this.profiler.startReporting();
        if (['deserializer','ds_pool_worker','projection'].includes(workerRole)) {
            if (!process.send) throw new Error('Managed worker requires its parent lifecycle IPC');
            this.workerAttemptClient = new WorkerAttemptClient({mode: 'managed', role: workerRole as WorkerAttemptRole, transport: {
                on: (event, listener) => process.on(event, listener), removeListener: (event, listener) => process.removeListener(event, listener),
                send: (message, callback) => process.send!(message, callback ?? (() => {}))}});
        }

        process.on('SIGINT', () => this.profiler.stopReporting());
        process.on('SIGTERM', () => this.profiler.stopReporting());

        this.filters = cm.filters;
        this.manager = new ConnectionManager(cm);
        this.mLoader = new HyperionModuleLoader(cm);
        this.chain = this.conf.settings.chain;
        this.chainId = this.manager.conn.chains[this.chain].chain_id;
        this.rpc = this.manager.nodeosApiClient;
        this.client = this.manager.elasticsearchClient;
        this.ship = this.manager.shipClient;
        this.events = new EventEmitter();
        this.protocolReady = this.initializeProtocol();

        this.mLoader.init().then(async () => {
            await this.protocolReady;
            // Connect to RabbitMQ (amqplib)
            this.events.emit('loader_ready');
            this.connectAMQP().then(() => {
                this.onConnect();
            }).catch(console.log);
        });

        const bytesToString = (bytes: number) => {
            const e = Math.log(bytes) / Math.log(1024) | 0;
            const n = (bytes / Math.pow(1024, e)).toFixed(2);
            return n + ' ' + (e == 0 ? 'bytes' : (['KB', 'MB', 'GB', 'TB'])[e - 1]);
        };


        // handle ipc messages
        process.on('message', (msg: any) => {
            if (msg.event === 'stop') this.workerAttemptClient?.fenceAll();
            switch (msg.event) {
                case 'request_v8_heap_stats': {
                    const report: HeapInfo = getHeapStatistics();
                    const used_pct = report.used_heap_size / report.heap_size_limit;
                    if (process.send) {
                        process.send({
                            event: 'v8_heap_report',
                            id: process.env.worker_role + ':' + process.env.worker_id,
                            data: {
                                heap_usage: (used_pct * 100).toFixed(2) + "%",
                                ...report
                            }
                        });
                    }
                    break;
                }
                case 'request_memory_usage': {
                    const report = process.memoryUsage();
                    if (process.send) {
                        process.send({
                            event: 'memory_report',
                            id: process.env.worker_role + ':' + process.env.worker_id,
                            data: {
                                resident: bytesToString(report.rss),
                            }
                        });
                    }
                    break;
                }
                default: {
                    this.onIpcMessage(msg);
                }
            }
        });
    }

    private async initializeProtocol() {
        const selected = await loadChainProtocol(this.conf.settings.protocol, {sourceEvidence: this.usesProtocolSourceBindings});
        this.protocol = selected.provider;
        this.protocolId = selected.id;
        this.protocolComponents = selected.components;
        this.abieos = selected.decoder;
    }

    async initializeProtocolShip(abiString: string): Promise<void> {
        await this.protocolReady;
        const handshake = JSON.parse(abiString);
        const replacement = this.protocol.createShipSession(handshake);
        this.shipSession?.close?.();
        this.shipSession = replacement;
        this.protocolShipAbi = handshake;
        this.protocolShipAbiJson = abiString;
    }

    decodeShipResult(bytes: Uint8Array): any {
        const session = this.deliveryShipContext?.session ?? this.shipSession;
        if (!session) throw new Error("Protocol SHiP session is not initialized");
        return this.decodeProtocolSource('result', () => session.decodeResult(bytes));
    }

    /** A queued delivery owns its decoder until all asynchronous processing ends. */
    protected beginProtocolShipDelivery(schemaJson: string): () => void {
        if (this.deliveryShipContext) throw new Error('Concurrent protocol source delivery is unsupported');
        const abi = JSON.parse(schemaJson);
        const session = this.protocol.createShipSession(abi);
        const context = {session, abi, schemaJson};
        this.deliveryShipContext = context;
        return () => {
            if (this.deliveryShipContext === context) this.deliveryShipContext = undefined;
            session.close?.();
        };
    }

    protected get activeProtocolShipSchemaJson(): string | undefined {
        return this.deliveryShipContext?.schemaJson ?? this.protocolShipAbiJson;
    }

    private decodeProtocolSource<T>(datatype: string, decode: () => T): T {
        try { return decode(); }
        catch (error) {
            if (this.deliveryShipContext) throw new ProtocolSourceCodecError(datatype, error);
            throw error;
        }
    }

    decodeShipValue(type: string, input: unknown): any {
        const session = this.deliveryShipContext?.session ?? this.shipSession;
        if (!session) throw new Error("Protocol SHiP session is not initialized");
        const bytes = protocolBytes(input);
        return this.decodeProtocolSource(type, () => { switch (type) {
            case "signed_block": return session.decodeBlock(bytes);
            case "transaction_trace[]": return session.decodeTraces(bytes);
            case "table_delta[]": return session.decodeDeltas(bytes);
            default: return session.decodeRow(type, bytes);
        } });
    }

    decodePackedTransaction(input: any): any {
        if (!this.usesExtensionProtocol) return PackedTransaction.from(input).getTransaction();
        const compression = Number(input?.compression ?? 0);
        if (compression !== 0 && compression !== 1) throw new Error('Unsupported packed transaction compression');
        const bytes = protocolBytes(input?.packed_trx ?? input);
        const abi = this.deliveryShipContext?.abi ?? this.protocolShipAbi;
        if (!(this.deliveryShipContext?.session ?? this.shipSession) || !abi) throw new Error('Protocol SHiP session is not initialized');
        return this.protocol.contractCodec.decodeValue(abi, 'transaction', compression === 1
            ? inflateSync(bytes, {maxOutputLength: 64 * 1024 * 1024}) : bytes);
    }

    get usesExtensionProtocol(): boolean {
        return !!this.protocol && this.protocol.profileId !== "antelope-default-v1";
    }

    async connectAMQP() {
        const channels = await this.manager.createAMQPChannels((channels: [Channel, ConfirmChannel]) => {
            if (this.ch) this.workerAttemptClient?.fenceChannel(this.attemptChannelId(this.ch)!);
            if (this.cch) this.workerAttemptClient?.fenceChannel(this.attemptChannelId(this.cch)!);
            [this.ch, this.cch] = channels;
            hLog('AMQP Reconnecting...');
            this.onConnect();
        }, () => {
            this.ch_ready = false;
            this.cch_ready = false;
        });

        if (channels) {
            [this.ch, this.cch] = channels;
        } else {
            hLog('AMQP Failed to create channels!');
        }
    }

    onConnect() {
        this.ch_ready = true;
        this.cch_ready = true;
        this.assertQueues().then(() => {
            if (this.ch && this.cch) {
                const consumer = this.ch;
                const publisher = this.cch;
                consumer.on('close', () => {
                    if (consumer === this.ch) this.ch_ready = false;
                });
                publisher.on('close', () => {
                    if (publisher === this.cch) this.cch_ready = false;
                });
                this.events.emit('ready');
            } else {
                hLog("onConnect was called before channels are instantiated!");
            }
        }).catch((reason: any) => {
            hLog('⚠️ Failed to assert queues\n\t⚠️', reason.message);
            process.exit();
        });
    }

    checkDebugger() {
        if (/--inspect/.test(process.execArgv.join(' '))) {
            import('node:inspector').then((inspector) => {
                hLog('DEBUGGER ATTACHED', inspector.url());
            });
        }
    }

    private anyFromCode(act: HyperionActionAct | Action) {
        return act.account + '::*'
    }

    private anyFromName(act: HyperionActionAct | Action) {
        return '*::' + act.name;
    }

    private codeActionPair(act: HyperionActionAct | Action) {
        return act.account + '::' + act.name;
    }

    private anyFromDeltaCode(delta: BasicDelta) {
        return delta.code + '::*'
    }

    private anyFromDeltaTable(delta: BasicDelta) {
        return '*::' + delta.table;
    }

    private codeDeltaPair(delta: BasicDelta) {
        return delta.code + '::' + delta.table;
    }

    protected checkBlacklist(act: HyperionActionAct | Action) {

        // test for chain::code::*
        if (this.filters.action_blacklist.has(this.anyFromCode(act))) {
            return true;
        }

        // test for chain::*::name
        if (this.filters.action_blacklist.has(this.anyFromName(act))) {
            return true;
        }

        // test for chain::code::name
        return this.filters.action_blacklist.has(this.codeActionPair(act));
    }

    protected checkWhitelist(act: HyperionActionAct | Action) {

        // test for chain::code::*
        if (this.filters.action_whitelist.has(this.anyFromCode(act))) {
            return true;
        }

        // test for chain::*::name
        if (this.filters.action_whitelist.has(this.anyFromName(act))) {
            return true;
        }

        // test for chain::code::name
        return this.filters.action_whitelist.has(this.codeActionPair(act));
    }

    protected checkDeltaBlacklist(delta: BasicDelta) {

        // test blacklist for chain::code::*
        if (this.filters.delta_blacklist.has(this.anyFromDeltaCode(delta))) {
            return true;
        }

        // test blacklist for chain::*::table
        if (this.filters.delta_blacklist.has(this.anyFromDeltaTable(delta))) {
            return true;
        }

        // test blacklist for chain::code::table
        return this.filters.delta_blacklist.has(this.codeDeltaPair(delta));
    }

    protected checkDeltaWhitelist(delta: BasicDelta) {

        // test whitelist for chain::code::*
        if (this.filters.delta_whitelist.has(this.anyFromDeltaCode(delta))) {
            return true;
        }

        // test whitelist for chain::*::table
        if (this.filters.delta_whitelist.has(this.anyFromDeltaTable(delta))) {
            return true;
        }

        // test whitelist for chain::code::table
        return this.filters.delta_whitelist.has(this.codeDeltaPair(delta));
    }

    async getAbiFromHeadBlock(code: string): Promise<HyperionAbi | null> {
        if (this.usesExtensionProtocol) return null;
        try {
            const result = await this.rpc.v1.chain.get_abi(code);
            if (result && result.abi) {
                return {
                    abi: result.abi,
                    valid_until: null,
                    valid_from: null
                };
            }
        } catch (e) {
            hLog(e);
        }
        return null;
    }

    loadAbiHex(contract: string, block_num: number, abi_hex: string) {
        // check local blacklist for corrupted ABIs that failed to load before
        let _status: boolean;
        if (this.failedAbiMap.has(contract) && this.failedAbiMap.get(contract)?.has(block_num)) {
            _status = false;
            debugLog('ignore saved abi for', contract, block_num);
        } else {
            _status = this.abieos.loadAbiHex(contract, abi_hex);
            if (!_status) {
                hLog(`Abieos::loadAbiHex error for ${contract} at ${block_num}`);
                if (this.failedAbiMap.has(contract)) {
                    this.failedAbiMap.get(contract)?.add(block_num);
                } else {
                    this.failedAbiMap.set(contract, new Set([block_num]));
                }
            } else {
                this.removeFromFailed(contract);
            }
        }
        return _status;
    }

    removeFromFailed(contract: string) {
        if (this.failedAbiMap.has(contract)) {
            this.failedAbiMap.delete(contract);
            hLog(`${contract} was removed from the failed map!`);
        }
    }

    getAbiDataType(field: string, contract: string, type: string): string {
        let dataType = '';
        try {
            switch (field) {
                case "action": {
                    dataType = this.abieos.getTypeForAction(contract, type);
                    break;
                }
                case "table": {
                    dataType = this.abieos.getTypeForTable(contract, type);
                    break;
                }
            }
        } catch (e: any) {
            // TODO: check for possible deserialization errors
            debugLog(e.message);
        }
        return dataType;
    }

    async loadCurrentAbiHex(contract: string): Promise<boolean> {
        if (this.usesExtensionProtocol) return false;
        let _status: boolean = false;
        if (this.failedAbiMap.has(contract) && this.failedAbiMap.get(contract)?.has(-1)) {
            _status = false;
            debugLog('ignore current abi for', contract);
        } else {
            const currentAbi = await this.rpc.v1.chain.get_raw_abi(contract);
            if (currentAbi.abi.array.byteLength > 0) {
                const abi_hex = Buffer.from(currentAbi.abi.array).toString('hex');
                
                try {
                    _status = this.abieos.loadAbiHex(contract, abi_hex);
                } catch (e: any) {
                    debugLog(`(abieos/current) >> ${e.message}`);
                }

                if (!_status) {
                    hLog(`Abieos::loadAbiHex error for ${contract} at head`);
                    if (this.failedAbiMap.has(contract)) {
                        this.failedAbiMap.get(contract)?.add(-1);
                    } else {
                        this.failedAbiMap.set(contract, new Set([-1]));
                    }
                } else {
                    this.removeFromFailed(contract);
                }
            } else {
                _status = false;
            }
        }
        return _status;
    }

    abstract run(): Promise<void>

    abstract assertQueues(): Promise<void>

    abstract onIpcMessage(msg: any): void

}

