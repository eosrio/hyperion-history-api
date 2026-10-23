import { HyperionWorker, ProtocolSourceCodecError, protocolSourceCapture } from "./hyperionWorker.js";
import { cargo, queue } from 'async';
import { debugLog, hLog } from "../helpers/common_functions.js";
import { createHash } from "crypto";
import { Message, Options, type Channel } from "amqplib";


import { index_queues, RabbitQueueDef } from "../definitions/index-queues.js";
import { HyperionDelta } from "../../interfaces/hyperion-delta.js";
import { TableDelta } from "../../interfaces/table-delta.js";
import { HyperionAbi } from "../../interfaces/hyperion-abi.js";
import { TransactionTrace } from "../../interfaces/action-trace.js";
import { HyperionSignedBlock, ProducerSchedule } from "../../interfaces/signed-block.js";
import { estypes } from "@elastic/elasticsearch";
import { ABI, Action, PackedTransaction, Serializer } from "@wharfkit/antelope";
import { TokenAccount } from "../../interfaces/custom-ds.js";
import { GetBlocksResultV0 } from "./state-reader.js";
import { de } from "zod/v4/locales";
import { log } from "console";
import {protocolBytes, protocolNumber} from "../protocol/contract-cache.js";
import type {ProtocolAbiDeployment, ProtocolNormalizedDelta, ProtocolAbiAccountRowInput} from "@eosrio/hyperion-sdk/protocol";
import {protocolDeployment, type IndexedProtocolAbi} from "../protocol/deployments.js";
import {protocolStateKey} from '../helpers/protocol-document-id.js';
import {assertCompleteProtocolSearch} from '../protocol/search.js';
import {ProtocolAbiObservationStore, type ProtocolAbiObservationRecord} from '../protocol/abi-observation-store.js';
import {assertProtocolAbiObservationFacts} from '../protocol/abi-observation-facts.js';
import {ProtocolSourceBindingStore, ProtocolSourceBindingReadError, protocolSourceSelectionHeader} from '../protocol/source-bindings.js';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';
import {ProtocolAbiProofReader, ProtocolAbiProofUnavailableError, type ProtocolAbiProofView} from '../protocol/abi-proof.js';
import {ProtocolAbiFrontierStore} from '../protocol/abi-frontier-store.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {actionSourceAdmissionHeader, actionSourceIngressHeader, type ActionSourceAdmission} from '../history/action-source-admission.js';
import {actionProducerEpoch, currentActionConfiguration} from '../history/action-producer-epoch.js';
import {actionHistoryImmutableJson} from '../history/action-history-manifest.js';
import type {ActionPublicationOwner} from '../history/action-confirmed-publication.js';
import {deriveProtocolActionInputs, type ActionSourceInventoryInput} from '../history/action-source-inventory.js';
import type {ProtocolAbiActionInput} from '@eosrio/hyperion-sdk/protocol';
import {snapshotNativeGenesisFacts, zeroBlockId} from '../protocol/native-genesis.js';
import {ProtocolNativeObservationStore, protocolNativeObservationBounds,
    type ProtocolNativeObservationRecord} from '../protocol/native-observation-store.js';
import {protocolNativeInputInventory, snapshotProtocolNativeDecisions} from '../protocol/native-observation-facts.js';
import {currentProofConsumerScope, trackProofConsumerOperation} from '../protocol/proof-consumer-scope.js';

class ProtocolProofStorageError extends Error {
    constructor(cause: unknown) {super('Canonical ABI proof storage failed', {cause});}
}

interface QueuePayload {
    queue: string;
    content: Buffer;
    headers?: any;
}

interface ProtocolDerivedPublications {
    accepting: boolean;
    bytes: number;
    effects: Array<() => unknown | Promise<unknown>>;
    failure?: ProtocolAbiProofUnavailableError;
}

function extractDeltaStruct(deltas: [string, TableDelta][]) {
    const deltaStruct = {};
    for (const table_delta of deltas) {
        if (table_delta[0] === "table_delta_v0" || table_delta[0] === "table_delta_v1") {
            deltaStruct[table_delta[1].name] = table_delta[1].rows;
        }
    }
    return deltaStruct;
}

interface HyperionLightBlock {
    '@timestamp': string;
    block_num: number;
    block_id: string;
    prev_id: string;
    producer: string;
    new_producers?: ProducerSchedule;
    schedule_version?: number;
    cpu_usage: number;
    net_usage?: number;
    trx_count: number;
    protocol?: Record<string, unknown>;
}

function bufferFromJson(data: any, _useFlatstr?: boolean) {
    // flatstr was historically used to force V8 to flatten cons-strings
    // before passing to Buffer.from. On Node 24 with modern V8,
    // JSON.stringify already produces a flat string, and the explicit
    // flatten is at best a no-op and at worst adds an extra function call
    // per AMQP payload. The parameter is kept for API compatibility but
    // ignored.
    return Buffer.from(JSON.stringify(data));
}

export default class MainDSWorker extends HyperionWorker {

    ch_ready = false;
    private consumerQueue;
    private preIndexingQueue;
    private protocolAbiObservationStore?: ProtocolAbiObservationStore;
    private protocolSourceBindingStore?: ProtocolSourceBindingStore;
    private protocolNativeObservationStore?: ProtocolNativeObservationStore;
    private activeSourceBinding?: Awaited<ReturnType<ProtocolSourceBindingStore['readSelection']>>;
    private activeSourceSelectionId?: string;
    private activeSourceRole?: 'live' | 'bulk' | 'repair';
    private protocolAbiProofReader?: ProtocolAbiProofReader;
    private activeProtocolAbiProofView?: ProtocolAbiProofView;
    private protocolAbiProofDeployments = new Map<string, ProtocolAbiProofView>();
    private readonly protocolDerivedPublications = new AsyncLocalStorage<ProtocolDerivedPublications>();
    private activeSourceDelivery?: {message: Message; channel: Channel | undefined};
    private readonly protocolDeliveryOwners = new WeakMap<Message, Channel>();
    private activeActionSource?: {message: Message; frameHex: string; ingressId: string; schemaJson: string; owner: ActionPublicationOwner;
        admission?: ActionSourceAdmission; configuration?: string};

    shipABI?: string;

    private allowStreaming = false;
    private dsPoolMap = {};
    private ds_pool_counters = {};
    private block_emit_idx = 1;
    private local_block_count = 0;

    common: any;
    tableHandlers = {};

    // generic queue id
    emit_idx = 1;
    dyn_emit_idx = 1;
    tbl_acc_emit_idx = 1;
    tbl_vote_emit_idx = 1;
    tbl_prop_emit_idx = 1;
    delta_emit_idx = 1;
    temp_delta_counter = 0;
    private monitoringLoop: NodeJS.Timeout | undefined;

    autoBlacklist: Map<string, any[]> = new Map();

    lastSelectedWorker = 0;

    allowedDynamicContracts: Set<string> = new Set<string>();

    backpressureQueue: any[] = [];
    waitToSend = false;

    constructor() {

        super();

        this.consumerQueue = cargo<Message>((payload, cb) => {
            this.processMessages(payload).then(() => {
                cb();
            }).catch((err) => {
                if (this.usesExtensionProtocol || this.actionSourceAdmissionEnabled) {
                    // Preserve unacknowledged broker deliveries for supervised
                    // replacement. nackAll + resuming cargo would reuse stale tags.
                    hLog('Protocol source processing failed; supervised replacement required:', err.message);
                    this.ch_ready = false;
                    this.consumerQueue.kill();
                    return process.exit(1);
                }
                hLog('NACK ALL', err.message);
                if (this.ch && this.ch_ready) {
                    this.ch.nackAll();
                }
            });
        }, this.conf.prefetch.block);

        this.preIndexingQueue = queue((data: any, cb) => {
            if (data.publish) {try {data.publish(); cb();} catch (error) {cb(error instanceof Error ? error : new Error(String(error)));} return;}
            if (this.ch && this.ch_ready) {
                this.workerBufferedPublication(this.ch, () => this.ch!.sendToQueue(data.queue, data.content, { headers: data.headers }));
                cb();
            } else {
                hLog('Channel is not ready!');
            }
        }, 1);

        this.events.on('loader_ready', () => {
            this.mLoader.appendDynamicContracts(this.allowedDynamicContracts);
        });

        this.populateTableHandlers().catch(console.log);
    }

    async run(): Promise<void> {
        this.startReports();
        return undefined;
    }

    onIpcMessage(msg: any): void {
        switch (msg.event) {
            case 'initialize_abi': {
                void this.initializeProtocolShip(msg.data).then(() => {
                    this.shipABI = msg.data;
                    this.initConsumer();
                }).catch(error => { hLog("Protocol initialization failed", error); process.exit(1); });
                break;
            }
            case 'update_abi': {
                if (msg.shipABI) {
                    if (msg.shipABI.abi_hex) {
                        this.abieos.loadAbiHex(msg.shipABI.account, msg.shipABI.abi_hex);
                        hLog(`Worker ${process.env.worker_id} updated the abi for ${msg.shipABI.account}`);
                    }
                }
                break;
            }
            case 'connect_ws': {
                this.allowStreaming = true;
                break;
            }
            case 'new_range': {
                break;
            }
            case 'update_pool_map': {
                this.dsPoolMap = msg.data;
                break;
            }
            case 'reload_config': {
                const previous = this.conf;
                const oldAlias = this.configModule.EOSIO_ALIAS;
                const oldPrefix = this.configModule.proc_prefix;
                const oldFilters = Object.fromEntries(Object.entries(this.filters).map(([key, entries]) => [key, new Set(entries)]));
                try {
                    hLog(`Reloading configuration...`);
                    this.configModule.loadConfigJson();
                    const candidate = this.configModule.config;
                    const before = previous.settings.protocol ?? {provider: 'antelope'};
                    const after = candidate.settings.protocol ?? {provider: 'antelope'};
                    if (before.provider !== after.provider || (before.provider === 'extension' && after.provider === 'extension'
                        && (before.package !== after.package || before.profileId !== after.profileId))) {
                        throw new Error('Changing a protocol provider or profile requires a controlled worker restart');
                    }
                    this.conf = candidate;
                    this.workerAttemptClient?.fenceActiveAttempts();
                    // Notify the master
                    process.send?.({
                        event: 'config_reloaded',
                        status: 'success'
                    });
                } catch (error: any) {
                    this.configModule.config = previous;
                    this.configModule.EOSIO_ALIAS = oldAlias;
                    this.configModule.proc_prefix = oldPrefix;
                    for (const [key, entries] of Object.entries(oldFilters)) {
                        this.filters[key].clear();
                        for (const entry of entries) this.filters[key].add(entry);
                    }
                    hLog(`Error reloading configuration: ${error.message}`);
                    // Notify the master about the error
                    process.send?.({
                        event: 'config_reloaded',
                        status: 'error',
                        message: error.message
                    });
                }
                break;
            }
        }
    }

    async assertQueues(): Promise<void> {

        if (this.ch) {
            this.ch_ready = true;
            if (this.preIndexingQueue.paused) {
                this.preIndexingQueue.resume();
            }
            this.ch.on('close', () => {
                this.ch_ready = false;
                this.preIndexingQueue.pause();
            });
        } else {
            hLog("Channel was not created! Something went wrong!");
            process.exit(1);
        }

        // make sure the input queue is ready if the deserializer launches too early
        const workerQueue = process.env['worker_queue'];
        if (workerQueue) {
            await this.ch.assertQueue(workerQueue, RabbitQueueDef);
        }

        if (process.env['live_mode'] === 'false') {
            for (let i = 0; i < this.conf.scaling.ds_queues; i++) {
                await this.ch.assertQueue(this.chain + ":blocks:" + (i + 1), RabbitQueueDef);
            }
        }

        let qIdx = 0;

        index_queues.forEach((q) => {
            qIdx = 0;
            let n = this.conf.scaling.indexing_queues;
            if (q.type === 'action' || q.type === 'delta') {
                n = this.conf.scaling.ad_idx_queues;
            } else if (q.type === 'dynamic-table') {
                n = this.conf.scaling.dyn_idx_queues;
            } else if (q.type === 'abi') {
                n = 1;
            }
            for (let i = 0; i < n; i++) {
                this.ch?.assertQueue(q.name + ":" + (qIdx + 1), RabbitQueueDef);
                qIdx++;
            }
        });

        // reload consumer only if ship abi is on cache
        if (this.shipABI) {
            this.initConsumer();
        }
    }

    sendDsCounterReport() {
        // send ds counters
        if (this.temp_delta_counter > 0) {
            process.send?.({
                event: 'ds_report',
                deltas: this.temp_delta_counter
            });
            this.temp_delta_counter = 0;
        }
    }

    startReports() {
        if (!this.monitoringLoop) {
            this.monitoringLoop = setInterval(() => {
                this.sendDsCounterReport();
            }, 1000);
        }
    }

    async processMessages(messages: Message[]) {
        const stop = this.profiler.start('process_messages_batch');
        try {
            if (this.tracksWorkerAttempts) {
                for (const message of messages) await this.runWorkerAttemptDelivery(message,
                    () => this.mLoader.parser?.parseMessage(this.scopedHookWorker(), [message]));
            } else await this.mLoader.parser?.parseMessage(this, messages);
        } finally {
            stop();
        }
    }

    /** Admission binds native and extension messages to their retained reader session, never the latest IPC ABI. */
    async processAdmittedSourceDelivery(message: Message, processBound: (result: GetBlocksResultV0) => Promise<void>): Promise<void> {
        if (this.tracksWorkerAttempts && !currentProofConsumerScope())
            return this.runWorkerAttemptDelivery(message, () => this.processAdmittedSourceDelivery(message, processBound));
        const owner = this.actionPublicationOwner(message);
        // Keep the receipt for its original ACK; caller-owned buffers must never supply later decode/retention bytes.
        const frame = Buffer.from(message.content), frameHex = frame.toString('hex');
        const ingressId = message.properties?.headers?.[actionSourceIngressHeader];
        const selectionId = message.properties?.headers?.[protocolSourceSelectionHeader];
        const ingress = await this.getActionAdmissionStore().resolveIngress(ingressId);
        this.assertWorkerAttemptActive();
        if (!owner.current() || ingress.chainId !== this.chainId || ingress.protocolId !== this.protocolId
            || ingress.profileId !== this.protocol.profileId || ingress.frameHex !== frameHex
            || actionHistoryImmutableJson(ingress.components) !== actionHistoryImmutableJson(this.protocolComponents ?? []))
            throw new Error('Action source delivery does not match its retained reader context');
        const run = async (result: GetBlocksResultV0) => {
            const capture = protocolSourceCapture(this.chainId, result, ingress.schemaJson);
            if (capture.captureSha256 !== ingress.captureSha256 || !owner.current()) throw new Error('Action source stable sections mismatch');
            await this.bindWorkerAttempt({ingressId, blockNum: capture.source.blockNum, blockId: capture.source.blockId});
            if (!owner.current()) throw new Error('Action source channels changed during attempt binding');
            this.activeActionSource = {message, frameHex, ingressId, schemaJson: ingress.schemaJson, owner};
            try {await processBound(result);} finally {this.activeActionSource = undefined;}
        };
        if (this.usesExtensionProtocol) {
            await this.processProtocolSourceDelivery(message, async result => {
                if (this.activeProtocolShipSchemaJson !== ingress.schemaJson) throw new Error('Action source and protocol handshakes disagree');
                await run(result);
            }, {frame, selectionId});
        } else {
            const close = this.beginProtocolShipDelivery(ingress.schemaJson);
            try {
                const result = this.decodeShipResult(frame);
                if (!Array.isArray(result) || !['get_blocks_result_v0', 'get_blocks_result_v1'].includes(result[0]))
                    throw new Error('Action source delivery is not a block result');
                await run(result[1]);
            } finally {close();}
        }
    }

    async prepareActionSourceAdmission(res: GetBlocksResultV0, block: any, traces: unknown,
                                       wireActionInputs?: readonly ProtocolAbiActionInput[]): Promise<void> {
        if (!this.actionSourceAdmissionEnabled) return;
        const scope = this.activeActionSource;
        if (!scope || !scope.owner.current()) throw new Error('Action admission lacks its original source delivery');
        const epoch = await actionProducerEpoch(this);
        this.assertWorkerAttemptActive();
        let rootActions: Array<{account: string; name: string}> | undefined;
        if (epoch.policy.rootOnly) {
            try {
                rootActions = [];
                for (const transaction of block.transactions) {
                    const packed = Array.isArray(transaction.trx) ? transaction.trx[1] : transaction.trx;
                    const included = transaction.status === 0 || (this.usesExtensionProtocol && transaction.status === undefined && !Array.isArray(transaction.trx));
                    if (included && packed?.packed_trx) for (const action of this.decodePackedTransaction(packed).actions)
                        rootActions.push({account: String(action.account), name: String(action.name)});
                }
            } catch {rootActions = undefined;}
        }
        const capture = protocolSourceCapture(this.chainId, res, scope.schemaJson);
        const inventoryInput: ActionSourceInventoryInput = {
            profileId: this.protocol.profileId as ActionSourceInventoryInput['profileId'],
            source: {chainId: this.chainId, blockNum: capture.source.blockNum, blockId: capture.source.blockId,
                producer: String(block?.producer ?? ''), timestamp: String(block?.timestamp ?? '')},
            policy: epoch.policy, traces: traces ?? null, ...(rootActions ? {rootActions} : {}),
            ...(wireActionInputs ? {wireActionInputs} : {}),
            ...(this.usesExtensionProtocol ? {sourceSelectionId: this.activeSourceSelectionId} : {})};
        const store = this.getActionAdmissionStore();
        const sourceId = await store.retainSource({schemaVersion: 1, frameHex: scope.frameHex,
            schemaJson: scope.schemaJson, captureSha256: capture.captureSha256, ingressId: scope.ingressId,
            previousBlockId: capture.source.previousBlockId, producer: epoch.producer,
            executableSha256: epoch.executableSha256, inventoryInput});
        this.assertWorkerAttemptActive();
        const target = await this.actionTarget(capture.source.blockNum, true);
        this.assertWorkerAttemptActive();
        const admission = await store.admit(sourceId, target);
        this.assertWorkerAttemptActive();
        if (!scope.owner.current() || currentActionConfiguration(this) !== epoch.configuration)
            throw new Error('Action producer epoch changed during source admission');
        scope.admission = admission; scope.configuration = epoch.configuration;
        await this.bindWorkerAttempt({admissionId: admission.id, planId: admission.planId, configurationSha256: createHash('sha256').update(epoch.configuration).digest('hex'),
            targetName: target.name, targetUuid: target.uuid, blockNum: capture.source.blockNum, blockId: capture.source.blockId});
        if (!scope.owner.current() || currentActionConfiguration(this) !== epoch.configuration)
            throw new Error('Action producer epoch changed during attempt binding');
        if (admission.incomplete) hLog('Action membership remains incomplete for block', capture.source.blockNum, admission.incomplete);
    }

    async ackAdmittedSourceDelivery(message: Message): Promise<void> {
        const scope = this.activeActionSource, admission = scope?.admission, configuration = scope?.configuration,
            selection = this.activeSourceSelectionId, binding = this.activeSourceBinding, delivery = this.activeSourceDelivery, proof = this.activeProtocolAbiProofView;
        const assertCurrent = () => {
            if (!scope || scope !== this.activeActionSource || scope.message !== message || !scope.owner.current() || !admission
                || scope.admission !== admission || scope.configuration !== configuration || currentActionConfiguration(this) !== configuration || selection !== this.activeSourceSelectionId
                || binding !== this.activeSourceBinding || delivery !== this.activeSourceDelivery)
                throw new Error('Action source cannot acknowledge unfinished/stale admission');
        };
        const revalidate = async () => {
            assertCurrent();
            const target = await this.actionTarget(admission!.source.inventoryInput.source.blockNum);
            assertCurrent();
            if (actionHistoryImmutableJson(target) !== actionHistoryImmutableJson(admission!.target)) throw new Error('Action source target changed before ACK');
            if (selection) {
                const fresh = await this.protocolSourceBindingStore!.readSelection(selection); assertCurrent();
                if (actionHistoryImmutableJson(fresh) !== actionHistoryImmutableJson(binding)) throw new Error('Action source selection changed before ACK');
            }
            if (proof) await this.getProtocolAbiProofReader().revalidate(proof);
            assertCurrent();
        };
        await revalidate();
        const store = this.getActionAdmissionStore();
        const observations = await store.prepareSourceAttemptDispositions({admissionId: admission!.id,
            configuration: configuration!, owner: scope!.owner});
        await revalidate();
        for (const evidence of observations) {
            const recorded = await store.recordAttemptDisposition({owner: scope!.owner, evidence});
            await this.observeFreshActionWrite(recorded);
            await revalidate();
        }
        assertCurrent(); this.assertWorkerAttemptActive(); this.markWorkerAcknowledgementAttempt(); scope!.owner.consumer.ack(message);
    }

    /** Resolve only durable per-frame context; initialize_abi remains a legacy startup signal. */
    async processProtocolSourceDelivery(message: Message, processBound: (result: GetBlocksResultV0) => Promise<void>,
                                        snapshot?: {frame: Buffer; selectionId: unknown}): Promise<void> {
        if (this.tracksWorkerAttempts && !currentProofConsumerScope())
            return this.runWorkerAttemptDelivery(message, () => this.processProtocolSourceDelivery(message, processBound, snapshot));
        const ownerChannel = this.protocolDeliveryOwners.get(message);
        const frame = Buffer.from(snapshot?.frame ?? message.content);
        const claimed = snapshot ? snapshot.selectionId : message.properties?.headers?.[protocolSourceSelectionHeader];
        await this.protocolReady;
        this.assertWorkerAttemptActive();
        this.protocolSourceBindingStore ??= new ProtocolSourceBindingStore(this.client, this.chain, this.conf.settings.es_replicas ?? 0);
        const store = this.protocolSourceBindingStore;
        const claimedSelectionId = typeof claimed === 'string' && claimed.length <= 4096 ? claimed : null;
        const quarantine = async (code: string, error: unknown) => {
            this.assertWorkerAttemptActive();
            const stop = this.profiler.start('protocol_source_quarantine');
            try {
                const capsule = await store.quarantine({schemaVersion: 1, chainId: this.chainId,
                protocol: {id: this.protocolId, profileId: this.protocol.profileId, components: this.protocolComponents ?? []},
                frameHex: frame.toString('hex'), claimedSelectionId,
                reason: {code, message: String((error as any)?.message ?? error).slice(0, 4096).toWellFormed() || code}});
                this.assertWorkerAttemptActive();
                process.send?.({event: 'ds_error', data: {type: 'protocol_source_incomplete', code, capsuleId: capsule.id, claimedSelectionId}});
                if (ownerChannel && ownerChannel === this.ch && this.ch_ready) {
                    this.assertWorkerAttemptActive(); this.markWorkerAcknowledgementAttempt(); ownerChannel.ack(message);
                }
            } finally { stop(); }
        };
        if (!ownerChannel) {
            await quarantine('protocol_source_receipt_unbound', new Error('Delivery lacks its original broker channel receipt'));
            return;
        }
        if (typeof claimed !== 'string' || !/^h45srcsel1:[0-9a-f]{64}$/.test(claimed)) {
            await quarantine('protocol_source_unbound', new Error('Missing or malformed reader source selection'));
            return;
        }
        let binding: Awaited<ReturnType<ProtocolSourceBindingStore['readSelection']>> | undefined;
        let readFailure: ProtocolSourceBindingReadError | undefined;
        const stopResolve = this.profiler.start('protocol_source_resolve');
        try { binding = await store.readSelection(claimed); }
        catch (error) {
            if (!(error instanceof ProtocolSourceBindingReadError)) throw error;
            readFailure = error;
        } finally { stopResolve(); }
        this.assertWorkerAttemptActive();
        if (readFailure) { await quarantine('protocol_source_' + readFailure.code, readFailure); return; }
        let close: (() => void) | undefined;
        let result: GetBlocksResultV0;
        let invalid = false;
        let validationError: unknown;
        const stopVerify = this.profiler.start('protocol_source_verify');
        try {
            const {selection, context} = binding!;
            const components = (value: readonly any[]) => [...value].sort((a, b) => {
                const left = a.runtime + ':' + a.id, right = b.runtime + ':' + b.id;
                return left < right ? -1 : left > right ? 1 : 0;
            });
            if (context.chainId !== this.chainId || selection.source.chainId !== this.chainId
                || context.protocol.id !== this.protocolId || context.protocol.profileId !== this.protocol.profileId
                || protocolImmutableJson(components(context.protocol.components)) !== protocolImmutableJson(components(this.protocolComponents ?? []))) {
                throw new Error('Reader source chain, profile or exact component build does not match this worker');
            }
            if (selection.frameSha256 !== createHash('sha256').update(frame).digest('hex')) throw new Error('Reader source frame digest mismatch');
            close = this.beginProtocolShipDelivery(context.schemaJson);
            const stopDecode = this.profiler.start('deserialize_result');
            let decoded: any;
            try { decoded = this.decodeShipResult(frame); } finally { stopDecode(); }
            if (!Array.isArray(decoded) || !['get_blocks_result_v0', 'get_blocks_result_v1'].includes(decoded[0])) throw new Error('Bound frame is not a block result');
            result = decoded[1];
            const capture = protocolSourceCapture(this.chainId, result, context.schemaJson);
            const position = (value: any) => ({blockNum: protocolNumber(value?.block_num), blockId: value?.block_id?.toString().toLowerCase() ?? ''});
            if (capture.captureSha256 !== selection.captureSha256 || protocolImmutableJson(capture.source) !== protocolImmutableJson(selection.source)
                || protocolImmutableJson(position(result.head)) !== protocolImmutableJson(selection.head)
                || protocolImmutableJson(position(result.last_irreversible)) !== protocolImmutableJson(selection.irreversible)) {
                throw new Error('Decoded reader source position or stable capture does not match retained selection');
            }
        } catch (error) {
            close?.();
            invalid = true;
            validationError = error;
        } finally { stopVerify(); }
        if (invalid) { await quarantine('protocol_source_invalid', validationError); return; }
        this.activeSourceSelectionId = claimed;
        this.activeSourceBinding = binding;
        this.activeSourceRole = binding!.selection.readerRole;
        this.activeSourceDelivery = {message, channel: ownerChannel};
        try {
            await this.bindWorkerAttempt({selectionId: claimed, readerSessionId: binding!.selection.readerSessionId,
                blockNum: binding!.selection.source.blockNum, blockId: binding!.selection.source.blockId});
            this.assertWorkerAttemptActive();
            if (ownerChannel !== this.ch || !this.ch_ready) throw new Error('Source consumer changed during attempt binding');
            await processBound(result!);
        }
        catch (error) {
            if (!(error instanceof ProtocolSourceCodecError)) throw error;
            await quarantine('protocol_source_codec_incomplete', error);
        }
        finally { this.activeSourceSelectionId = undefined; this.activeSourceBinding = undefined;
            this.activeSourceRole = undefined; this.activeProtocolAbiProofView = undefined;
            this.activeSourceDelivery = undefined; close?.(); }
    }

    ackProtocolSourceDelivery(message: Message): void {
        const delivery = this.activeSourceDelivery;
        if (delivery?.message === message && delivery.channel && delivery.channel === this.ch && this.ch_ready) {
            this.assertWorkerAttemptActive(); this.markWorkerAcknowledgementAttempt(); delivery.channel.ack(message);
        }
    }

    /** Called at receipt, before cargo can wait behind asynchronous work. */
    captureProtocolSourceDelivery(message: Message, channel: Channel): void {
        const existing = this.protocolDeliveryOwners.get(message);
        if (existing && existing !== channel) throw new Error('Cannot replace a protocol delivery channel receipt');
        this.protocolDeliveryOwners.set(message, channel);
        this.captureWorkerAttemptDelivery(message, channel, 'source-delivery');
    }

    /** Journal PREPARE precedes history filters and source ACK; it grants no decoding authority. */
    async prepareProtocolAbiObservations(res: GetBlocksResultV0): Promise<{traces?: any; deltas?: any[]; wireActionInputs?: readonly ProtocolAbiActionInput[]}> {
        if (!this.usesExtensionProtocol) return {};
        this.assertWorkerAttemptActive();
        if (!this.activeSourceSelectionId || !this.activeProtocolShipSchemaJson || !this.protocolSourceBindingStore) {
            throw new Error('ABI observations require a verified reader source selection');
        }
        const {source: position, capture, captureSha256} = protocolSourceCapture(this.chainId, res, this.activeProtocolShipSchemaJson);
        const source = {...position, inputSha256: captureSha256};
        const decoded: {traces?: any; deltas?: any[]; wireActionInputs?: readonly ProtocolAbiActionInput[]} = {};
        let observation: ProtocolAbiObservationRecord['observation'];
        let codecFailure: ProtocolSourceCodecError | undefined;
        try {
            if (res.traces && protocolBytes(res.traces).length) decoded.traces = this.decodeShipValue('transaction_trace[]', res.traces);
            if (res.deltas && protocolBytes(res.deltas).length) decoded.deltas = this.decodeShipValue('table_delta[]', res.deltas);
            let accountRows: ProtocolAbiAccountRowInput[] | undefined;
            if (decoded.deltas !== undefined) {
                accountRows = [];
                let ordinal = 0;
                for (const delta of decoded.deltas) {
                    if (!Array.isArray(delta) || !['table_delta_v0', 'table_delta_v1'].includes(delta[0])
                        || !Array.isArray(delta[1]?.rows)) throw new Error('Unsupported ABI observation delta framing');
                    for (const row of delta[1].rows) {
                        if (delta[1].name === 'account') {
                            if (![true, false, 0, 1].includes(row.present)) throw new Error('Invalid ABI account presence');
                            const raw = protocolBytes(row.data);
                            accountRows.push({ordinal, present: row.present === true || row.present === 1,
                                raw, value: this.decodeShipValue('account', raw)});
                        }
                        ordinal++;
                    }
                }
            }
            const provider = this.protocol;
            if (position.blockNum === 1 && capture.tracesHex === null) {
                if (!provider.verifyNativeGenesis || capture.schemaJson === null || !capture.blockHex || !capture.deltasHex) {
                    throw new Error('Native genesis requires a selected verifier and original header/state sections');
                }
                const facts = snapshotNativeGenesisFacts(provider.verifyNativeGenesis({schemaJson: capture.schemaJson,
                    block: Buffer.from(capture.blockHex, 'hex'), traces: null, deltas: Buffer.from(capture.deltasHex, 'hex')}, position));
                observation = {status: 'native-genesis', facts};
            } else {
                if (typeof provider.observeBlockAbi !== 'function') throw new Error('Selected provider has no ABI observation hook');
                const facts = provider.observeBlockAbi({traces: decoded.traces, accountRows}, position);
                assertProtocolAbiObservationFacts(facts);
                decoded.wireActionInputs = facts.actionInputs;
                // Validate malformed provider output here so raw source survives as an incomplete record.
                observation = {status: 'observed', facts};
            }
        } catch (error: any) {
            if (error instanceof ProtocolSourceCodecError) codecFailure = error;
            observation = {status: 'incomplete', error: {code: 'protocol_abi_observation_incomplete',
                message: String(error?.message ?? error).slice(0, 4096).toWellFormed()}};
        }
        this.protocolAbiObservationStore ??= new ProtocolAbiObservationStore(this.client, this.chain, this.conf.settings.es_replicas ?? 0);
        const abiRecord: ProtocolAbiObservationRecord = {schemaVersion: 1,
            protocol: {id: this.protocolId, profileId: this.protocol.profileId, components: this.protocolComponents ?? []},
            source, capture, observation};
        this.assertWorkerAttemptActive();
        const prepared = await this.protocolAbiObservationStore.prepare(abiRecord);
        this.assertWorkerAttemptActive();
        const stopLink = this.profiler.start('protocol_source_link_observation');
        try {
            await this.protocolSourceBindingStore.prepareObservationLink({schemaVersion: 1, selectionId: this.activeSourceSelectionId,
                observationId: prepared.id, observationDigest: prepared.digest});
        } finally { stopLink(); }
        this.assertWorkerAttemptActive();
        // Separate PREPARE must also run when ABI extraction failed, before its
        // codec rethrow/readiness wait. Neither retained labels nor readback grant authority.
        await this.prepareProtocolNativeObservations(abiRecord, prepared);
        this.assertWorkerAttemptActive();
        // This is only a wake-up hint. Master resolves the durable link and source order itself.
        // Losing IPC cannot erase PREPARE; the master's bounded periodic drain repairs it.
        try {
            process.send?.({event: 'protocol_abi_prepared', data: {selectionId: this.activeSourceSelectionId}}, error => {
                if (error) debugLog('ABI preparation hint could not reach master:', error.message);
            });
        } catch (error: any) { debugLog('ABI preparation hint could not reach master:', error?.message ?? error); }
        if (codecFailure) throw codecFailure;
        const stopProof = this.profiler.start('protocol_abi_block_wait');
        try {
            const reader = this.getProtocolAbiProofReader();
            this.activeProtocolAbiProofView = await (this.activeSourceRole === 'live'
                ? reader.waitForOpen(position, this.activeSourceSelectionId) : reader.open(position, this.activeSourceSelectionId));
        } catch (error) {
            if (!(error instanceof ProtocolAbiProofUnavailableError)) throw error;
            this.activeProtocolAbiProofView = undefined;
        } finally { stopProof(); }
        this.assertWorkerAttemptActive();
        return decoded;
    }

    private async prepareProtocolNativeObservations(abi: ProtocolAbiObservationRecord,
                                                    prepared: {id: string; digest: string}): Promise<void> {
        this.assertWorkerAttemptActive();
        const native = this.protocol.nativeActions;
        if (native === undefined) return;
        const selectionId = this.activeSourceSelectionId, binding = this.activeSourceBinding, delivery = this.activeSourceDelivery;
        const current = () => !!delivery?.channel && delivery.channel === this.ch && this.ch_ready
            && this.activeSourceDelivery === delivery && this.activeSourceSelectionId === selectionId
            && this.activeSourceBinding === binding;
        if (!selectionId || !binding || !current()) throw new Error('Native observations require the original active source delivery');
        const {inputSha256, ...position} = abi.source;
        const record: ProtocolNativeObservationRecord = {schemaVersion: 1, kind: 'observation', nativeInterfaceVersion: 1,
            contextId: binding.selection.contextId, protocol: binding.context.protocol, source: position,
            captureRef: {abiObservationId: prepared.id, abiObservationDigest: prepared.digest, inputSha256}, inventory: null,
            observation: {status: 'incomplete', error: {code: 'protocol_native_observation_incomplete', message: 'Native extraction unavailable'}}};
        const stopExtract = this.profiler.start('protocol_native_extract');
        let code = 'protocol_native_observation_incomplete';
        try {
            const capture = abi.capture;
            if (!capture.tracesHex) {code = 'native_source_traces_absent'; throw new Error('Original native source traces are absent');}
            if (!capture.blockHex) {code = 'native_source_block_absent'; throw new Error('Original native source block is absent');}
            if (capture.schemaJson !== binding.context.schemaJson) throw new Error('Native source handshake differs from its retained context');
            // Re-decode retained bytes independently: the ABI hook may fail or mutate its own decoded arguments.
            const inputs = deriveProtocolActionInputs(this.decodeShipValue('transaction_trace[]', Buffer.from(capture.tracesHex, 'hex')));
            record.inventory = protocolNativeInputInventory(inputs);
            const block = Buffer.from(capture.blockHex, 'hex'), traces = Buffer.from(capture.tracesHex, 'hex');
            const blockDigest = createHash('sha256').update(block).digest('hex'), traceDigest = createHash('sha256').update(traces).digest('hex');
            const facts = native.observe(Object.freeze({schemaJson: capture.schemaJson, block, traces}), Object.freeze({...position}));
            if (createHash('sha256').update(block).digest('hex') !== blockDigest
                || createHash('sha256').update(traces).digest('hex') !== traceDigest) throw new Error('Native observer mutated its source bytes');
            record.observation = {status: 'observed', facts: snapshotProtocolNativeDecisions(facts, inputs)};
            // Deterministic extraction/budget errors become small explicit evidence;
            // storage/configuration/reference errors below must escape to redelivery.
            protocolImmutableJson(record, protocolNativeObservationBounds.maximumBytes);
        } catch (error: unknown) {
            // Hooks can throw any JavaScript value. Error retention must not
            // invoke accessors or coercion hooks and fail before PREPARE itself.
            let message = code;
            if (typeof error === 'string') message = error;
            else if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
                try {
                    const property = Object.getOwnPropertyDescriptor(error, 'message');
                    if (property && Object.hasOwn(property, 'value') && typeof property.value === 'string') message = property.value;
                } catch { /* An opaque or revoked proxy still produces incomplete evidence. */ }
            }
            record.observation = {status: 'incomplete', error: {code, message: message.slice(0, 4096).toWellFormed() || code}};
        } finally { stopExtract(); }
        this.assertWorkerAttemptActive();
        if (!current()) throw new Error('Native observation source channel changed during extraction');
        this.protocolNativeObservationStore ??= new ProtocolNativeObservationStore(this.client, this.chain, this.conf.settings.es_replicas ?? 0);
        const stopPrepare = this.profiler.start('protocol_native_prepare');
        try { await this.protocolNativeObservationStore.prepare(selectionId, record); }
        finally { stopPrepare(); }
        this.assertWorkerAttemptActive();
        if (!current()) throw new Error('Native observation source channel changed during PREPARE');
    }

    private getProtocolAbiProofReader(): ProtocolAbiProofReader {
        return this.protocolAbiProofReader ??= new ProtocolAbiProofReader({chainId: this.chainId,
            profile: {id: this.protocolId, profileId: this.protocol.profileId, components: this.protocolComponents ?? []},
            store: new ProtocolAbiFrontierStore(this.client, this.chain, this.conf.settings.es_replicas ?? 0, {readOnly: true}),
            requireAttemptScope: this.workerAttemptScopeRequired,
            maxAncestryBlocks: this.conf.settings.protocol_abi_coordination?.recovery_window_blocks});
    }

    private initConsumer() {
        if (this.ch_ready && this.ch && process.env.worker_queue) {
            const consumer = this.ch;
            consumer.prefetch(this.conf.prefetch.block);
            consumer.consume(process.env.worker_queue, (data) => {
                if (!data) return;
                this.captureWorkerAttemptDelivery(data, consumer, 'source-delivery');
                if (this.actionSourceAdmissionEnabled) this.captureActionAdmissionDelivery(data, consumer);
                if (this.usesExtensionProtocol) this.captureProtocolSourceDelivery(data, consumer);
                this.consumerQueue.push(data).catch(console.log);
            });
            consumer.on('drain', () => {
                if (consumer !== this.ch) return;
                this.waitToSend = false;
                while (this.backpressureQueue.length > 0) {
                    const msg = this.backpressureQueue.shift();
                    let status: boolean;
                    try {status = msg.publish ? msg.publish() : this.controlledSendToQueue(msg.queue, msg.payload, msg.options);}
                    catch (error) {msg.reject?.(error); continue;}
                    msg.resolve?.();
                    if (!status) {
                        break;
                    }
                }
            });
        }
    }

    async processBlock(
        res: GetBlocksResultV0,
        block: HyperionSignedBlock,
        traces: [string, TransactionTrace][] | null,
        deltas: [string, TableDelta][] | null
    ) {
        if (!res.this_block) {
            // missing current block data
            hLog(res);
            return null;
        } else {
            let producer = '';
            let ts = '';
            let block_ts = new Date().toISOString();
            let light_block: HyperionLightBlock | null = null;
            const block_num = protocolNumber(res.this_block.block_num);
            const block_id = res.this_block.block_id.toString().toLowerCase();
            if (this.conf.indexer.fetch_block) {
                if (!block) {
                    hLog('Block not found!');
                    return null;
                }
                let previousBlockId = res.prev_block?.block_id.toString().toLowerCase();
                if (!previousBlockId) {
                    // Genesis has no SHiP predecessor position. The decoded header still has one;
                    // use it only for this derived document, never rewrite the retained source.
                    if (block_num !== 1 || block.previous?.toString().toLowerCase() !== zeroBlockId) {
                        throw new Error('Missing SHiP predecessor outside a zero-parent genesis header');
                    }
                    previousBlockId = zeroBlockId;
                }
                light_block = {
                    '@timestamp': block['timestamp'],
                    block_num: protocolNumber(res.this_block.block_num),
                    block_id: res.this_block.block_id.toString().toLowerCase(),
                    prev_id: previousBlockId,
                    producer: block.producer,
                    new_producers: block.new_producers,
                    schedule_version: block.schedule_version,
                    cpu_usage: 0,
                    net_usage: 0,
                    trx_count: 0
                };

                producer = block['producer'];
                ts = block['timestamp'];

                block_ts = ts;

                let total_cpu = 0;
                let total_net = 0;

                const failedTrx: any[] = [];
                let receiptNetAvailable = !this.usesExtensionProtocol;

                block.transactions.forEach((trx) => {

                    let valid = true;

                    // Check if the transaction is blacklisted or whitelisted
                    if (this.filters.action_blacklist.size > 0 || this.filters.action_whitelist.size > 0) {

                        // valid should be false by default if any whitelist is present
                        valid = this.filters.action_whitelist.size === 0;

                        try {
                            const unpacked_trx = this.decodePackedTransaction(Array.isArray(trx.trx) ? trx.trx[1] : trx.trx);
                            for (const act of unpacked_trx.actions) {

                                if (this.filters.action_blacklist.size > 0 && this.checkBlacklist(act)) {
                                    valid = false;
                                    // hLog(`Blacklisted action found in block ${block_num}: ${act.account}::${act.name}`);
                                    break;
                                }

                                if (this.filters.action_whitelist.size > 0 && this.checkWhitelist(act)) {
                                    valid = true;
                                    // hLog(`Whitelisted action found in block ${block_num}: ${act.account}::${act.name}`);
                                    break;
                                }

                            }
                        } catch (error: any) {
                            hLog(`Failed to unpack transaction in block ${block_num}:`, error.message);
                        }
                        
                    }

                    const receipt: any = trx;
                    if (Array.isArray(receipt.cpu_usage_us)) {
                        for (const cpu of receipt.cpu_usage_us) total_cpu += protocolNumber(cpu);
                    } else total_cpu += protocolNumber(receipt.cpu_usage_us);
                    if (receipt.net_usage_words === undefined) receiptNetAvailable = false;
                    else total_net += protocolNumber(receipt.net_usage_words);

                    if (trx.status === 0 || (this.usesExtensionProtocol && trx.status === undefined && !Array.isArray(trx.trx))) {

                        if (light_block && valid) {
                            light_block.trx_count++;
                        }

                    } else {
                        if (this.conf.features.failed_trx) {
                            switch (trx.status) {

                                // soft_fail: objectively failed (not executed), error handler executed
                                case 1: {
                                    failedTrx.push({
                                        id: trx.trx[1],
                                        status: trx.status,
                                        cpu: trx.cpu_usage_us,
                                        net: trx.net_usage_words
                                    });
                                    break;
                                }

                                // hard_fail: objectively failed and error handler objectively failed thus no state change
                                case 2: {
                                    failedTrx.push({
                                        id: trx.trx[1],
                                        status: trx.status,
                                        cpu: trx.cpu_usage_us,
                                        net: trx.net_usage_words
                                    });
                                    break;
                                }

                                // delayed: transaction delayed/deferred/scheduled for future execution
                                // case 3: {
                                //     hLog('delayed', block_num);
                                //     console.log(trx);
                                //     const unpackedTrx = this.api.deserializeTransaction(Buffer.from(trx.trx[1].packed_trx, 'hex'));
                                //     console.log(unpackedTrx);
                                //     break;
                                // }

                                // expired: transaction expired and storage space refunded to user
                                case 4: {
                                    failedTrx.push({
                                        id: trx.trx[1],
                                        status: trx.status
                                    });
                                    break;
                                }
                            }
                        }
                    }
                });

                if (light_block) {
                    light_block.cpu_usage = total_cpu;
                    if (receiptNetAvailable) light_block.net_usage = total_net;
                    else delete light_block.net_usage;
                    if (this.usesExtensionProtocol) {
                        light_block.protocol = {id: this.protocolId, profileId: this.protocol.profileId,
                            // Wire receipts contain per-input-action CPU and omit legacy status/net.
                            receipts: block.transactions.map((receipt: any) => ({cpu_usage_us: receipt.cpu_usage_us}))};
                        if (block.schedule_version === undefined) delete light_block.schedule_version;
                    }
                }

                // hLog(`Transaction Count: ${light_block.trx_count}`);

                // submit failed trx
                if (failedTrx.length > 0) {
                    for (const tx of failedTrx) {
                        if (typeof tx.id === 'string') {
                            const payload = {
                                "@timestamp": ts,
                                "block_num": block_num,
                                trx_id: tx.id,
                                status: tx.status
                            };
                            await this.pushToIndexQueue(payload, 'trx_error');
                        }
                    }
                }

                if (light_block && light_block.new_producers) {
                    process.send?.({
                        event: 'new_schedule',
                        block_num: light_block.block_num,
                        new_producers: light_block.new_producers,
                        live: process.env.live_mode
                    });
                }

                // stream light block
                if (this.allowStreaming && this.ch && light_block) {
                    this.ch.publish('', this.chain + ':stream',
                        Buffer.from(JSON.stringify(light_block)),
                        {
                            headers: {
                                event: 'block',
                                blockNum: light_block.block_num
                            }
                        }
                    );
                }
            }

            // Process Delta Traces (must be done first to catch ABI updates)
            if (deltas && this.conf.indexer.process_deltas) {
                await this.processDeltas(deltas, block_num, block_ts, block_id);
                this.assertWorkerAttemptActive();
            }

            // Process Action Traces
            let _traces: [string, TransactionTrace][] = [];
            const onBlockTransactions: string[] = [];
            if (traces && this.conf.indexer.fetch_traces) {

                if (traces["valueForKeyPath"]) {
                    _traces = traces['valueForKeyPath'](".");
                } else {
                    _traces = traces;
                }

                if (this.activeActionSource?.admission?.inventory) {
                    const scope = this.activeActionSource, admission = scope.admission!;
                    for (const transaction of admission.inventory!.transactions) {
                        if (!transaction.dispatch) continue;
                        if (!scope.owner.current() || currentActionConfiguration(this) !== scope.configuration)
                            throw new Error('Action source epoch changed before dispatch');
                        const headers = {block_num, block_id, producer, ts,
                            inline_count: transaction.dispatch.inlineCount, filtered: transaction.dispatch.filtered,
                            live: process.env['live_mode'], [actionSourceAdmissionHeader]: admission.id,
                            action_trace_ordinal: transaction.traceOrdinal,
                            ...(this.usesExtensionProtocol ? {[protocolSourceSelectionHeader]: this.activeSourceSelectionId} : {})};
                        await this.routeToPool(transaction.dispatch.body, headers, scope.owner, transaction.dispatch.canonicalJson);
                        if (process.env['live_mode'] === 'true') onBlockTransactions.push(transaction.transactionId);
                    }
                    this.assertWorkerAttemptActive();
                    await this.getActionAdmissionStore().trySeal(admission);
                } else if (_traces.length > 0 && this.conf.indexer.fetch_traces) {
                    for (const trace of _traces) {
                        if (trace[1] && trace[1].action_traces.length > 0) {
                            const inline_count = trace[1].action_traces.length;

                            // if (trace[1].failed_dtrx_trace) {
                            //     console.log(trace[1].failed_dtrx_trace[1]);
                            // }

                            let signatures = [];
                            try {
                                if (trace[1].partial && trace[1].partial[1].signatures) {
                                    signatures = trace[1].partial[1].signatures;
                                } else if (trace[1].partial && trace[1].partial[1].prunable_data) {
                                    if (trace[1].partial[1].prunable_data.prunable_data[1].signatures) {
                                        signatures = trace[1].partial[1].prunable_data.prunable_data[1].signatures;
                                    }
                                }
                                if (process.env['live_mode'] === 'true') {
                                    const trxId = trace[1].id.toLowerCase();
                                    onBlockTransactions.push(trxId);
                                    process.send?.({
                                        event: 'included_trx',
                                        block_num,
                                        trx_id: trxId,
                                        signatures: signatures,
                                        root_act: trace[1].action_traces[0][1].act
                                    });
                                }
                            } catch (e) {
                                signatures = [];
                            }

                            let filtered = false;
                            if (this.conf.indexer.max_inline && inline_count > this.conf.indexer.max_inline) {
                                trace[1].action_traces = trace[1].action_traces.slice(0, this.conf.indexer.max_inline);
                                filtered = true;
                                hLog(`${block_num} was filtered with ${inline_count} actions!`);
                            }
                            try {
                                trace[1].signatures = signatures;
                                await this.routeToPool(trace[1], {
                                    block_num,
                                    block_id,
                                    producer,
                                    ts,
                                    inline_count,
                                    filtered,
                                    live: process.env['live_mode'],
                                    ...(this.activeActionSource?.admission ? {[actionSourceAdmissionHeader]: this.activeActionSource.admission.id} : {}),
                                    ...(this.usesExtensionProtocol ? {[protocolSourceSelectionHeader]: this.activeSourceSelectionId} : {})
                                }, this.activeActionSource?.owner);
                            } catch (e) {
                                if (this.actionSourceAdmissionEnabled) throw e;
                                hLog(e);
                                hLog(block_num);
                                hLog(trace[1]);
                            }
                        }
                    }
                }
            }

            // Send light block to indexer
            if (this.conf.indexer.fetch_block && light_block) {
                await this.pushToBlocksQueue(light_block);
            }
            return {
                block_num: res['this_block']['block_num'],
                block_id: res['this_block']['block_id'],
                block_ts,
                trx_ids: onBlockTransactions,
                size: _traces.length
            };
        }
    }

    async pushToBlocksQueue(light_block: HyperionLightBlock) {
        if (!this.conf.indexer.disable_indexing) {
            const q = this.chain + ":index_blocks:" + (this.block_emit_idx);
            await this.enqueueDerivedPublication({
                queue: q,
                content: bufferFromJson(light_block)
            });
            this.block_emit_idx++;
            if (this.block_emit_idx > this.conf.scaling.indexing_queues) {
                this.block_emit_idx = 1;
            }
        }
        this.local_block_count++;
    }

    routeToPool(trace, headers, owner?: ActionPublicationOwner, canonicalPayload?: string) {

        let first_action;
        if (trace['action_traces'][0] && trace['action_traces'][0].length === 2) {

            first_action = trace['action_traces'][0][1];

            // // replace first action if the root is eosio.null::nonce
            // if (first_action.act.account === this.conf.settings.eosio_alias + '.null' && first_action.act.name === 'nonce') {

            //     console.dir(trace, { depth: Infinity });

            //     // if (trace['action_traces'][1] && trace['action_traces'][1].length === 2) {
            //     //     first_action = trace['action_traces'][1][1];
            //     // }
            // }

        } else {
            console.log('missing action_trace_v0');
            console.log(trace['action_traces']);
            console.log(trace);
            return false;
        }

        if (this.checkBlacklist(first_action.act)) {
            return false;
        }

        if (this.filters.action_whitelist.size > 0) {
            let allow = false;
            let depth = 0;
            for (const action of trace['action_traces']) {
                if (this.checkWhitelist(action[1].act)) {
                    allow = true;
                    // hLog(`Code: ${action[1].act.account} | Action: ${action[1].act.name} | Depth: ${depth}`);
                    break;
                }
                if (this.conf.whitelists.max_depth) {
                    if (depth >= this.conf.whitelists.max_depth) {
                        // hLog(`Max depth reached: ${depth} | Total: ${trace['action_traces'].length} actions`);
                        break;
                    }
                    depth++;
                }
            }
            if (!allow) {
                return false;
            }
        }

        let selected_q = 1;
        const _code = first_action.act.account;

        switch (this.conf.scaling.routing_mode) {
            case "heatmap": {
                if (this.dsPoolMap[_code]) {
                    const workers = this.dsPoolMap[_code][2];
                    for (const w of workers) {
                        if (typeof this.ds_pool_counters[_code] === 'undefined') {
                            selected_q = w;
                            this.ds_pool_counters[_code] = w;
                            break;
                        } else {
                            if (this.ds_pool_counters[_code] === workers[workers.length - 1]) {
                                this.ds_pool_counters[_code] = workers[0];
                                selected_q = w;
                                this.ds_pool_counters[_code] = w;
                                break;
                            } else {
                                if (this.ds_pool_counters[_code] === w) {
                                    continue;
                                }
                                if (w > this.ds_pool_counters[_code]) {
                                    selected_q = w;
                                    this.ds_pool_counters[_code] = w;
                                    break;
                                }
                            }
                        }
                    }
                }
                selected_q += 1;
                break;
            }
            case "round_robin": {
                this.lastSelectedWorker++;
                if (this.lastSelectedWorker === this.conf.scaling.ds_pool_size + 1) {
                    this.lastSelectedWorker = 1;
                }
                selected_q = this.lastSelectedWorker;
                break;
            }
            default: {
                hLog(`Invalid scaling.routing_mode option "${this.conf.scaling.routing_mode}". Exiting now!`);
                process.exit(1);
            }
        }

        const pool_queue = `${this.chain}:ds_pool:${selected_q}`;
        const payload = canonicalPayload === undefined ? bufferFromJson(trace, true) : Buffer.from(canonicalPayload);
        if (owner) return this.publishAdmitted(owner, pool_queue, payload, headers);

        if (!this.waitToSend) {
            if (this.ch_ready) {
                this.controlledSendToQueue(pool_queue, payload, { headers });
                return true;
            } else {
                return false;
            }
        } else {
            const scope = currentProofConsumerScope();
            if (scope) {
                const channel = this.ch, sent = Buffer.from(payload), options = {headers: structuredClone(headers)};
                void scope.operation(() => new Promise<void>((resolve, reject) => {
                    const publish = scope.bindCallback(() => {
                        if (!channel || channel !== this.ch || !this.ch_ready) throw new Error('Original queued source publisher is unavailable');
                        return this.controlledSendToQueue(pool_queue, sent, options);
                    });
                    const entry = {publish, resolve: () => {scope.signal.removeEventListener('abort', abort); resolve();},
                        reject: (error: unknown) => {scope.signal.removeEventListener('abort', abort); reject(error);}};
                    const abort = () => {
                        const index = this.backpressureQueue.indexOf(entry); if (index !== -1) this.backpressureQueue.splice(index, 1);
                        entry.reject(scope.signal.reason);
                    };
                    scope.signal.addEventListener('abort', abort, {once: true}); this.backpressureQueue.push(entry);
                })).catch(() => {});
            } else this.backpressureQueue.push({
                queue: pool_queue,
                payload: payload,
                options: { headers }
            });
            return false;
        }
    }

    controlledSendToQueue(pool_queue: string, payload: Buffer, options: Options.Publish): boolean {
        this.assertWorkerAttemptActive();
        if (this.ch) {
            const enqueueResult = this.workerBufferedPublication(this.ch, () => this.ch!.sendToQueue(pool_queue, payload, options));
            if (!enqueueResult) {
                this.waitToSend = true;
            }
            return enqueueResult;
        } else {
            hLog("Channel was not created!");
            return false;
        }
    }

    // createSerialBuffer(inputArray: Uint8Array) {
    //     return new Serialize.SerialBuffer({
    //         textEncoder: this.txEnc,
    //         textDecoder: this.txDec,
    //         array: inputArray
    //     });
    // }

    /**
     * Per-block memo for ABI lookups. At mainnet delta density the same
     * (contract, block) ABI is fetched once per row of that contract's tables —
     * hundreds of identical ES round-trips per block, across both verifyLocalType
     * (cache-miss path) and the contract_row fallback. The ES result is
     * deterministic for a fixed (contract, block), so caching it per block is
     * format-safe. Cleared at the start of each block in processDeltas.
     */
    private deltaAbiCache = new Map<string, HyperionAbi | null>();

    async fetchAbiHexAtBlockElastic(
        contract_name: string,
        last_block: number,
        get_json: boolean
    ): Promise<HyperionAbi | null> {
        const cacheKey = contract_name + '|' + last_block + '|' + (get_json ? 'j' : 'h');
        const cached = this.deltaAbiCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }
        try {
            const _includes = ["actions", "tables", "block"];
            if (this.usesExtensionProtocol) _includes.push('account', 'block_id', 'protocol_profile', 'ordinal');
            if (get_json) {
                _includes.push("abi");
            } else {
                _includes.push("abi_hex");
            }
            const query = {
                bool: {
                    must: [
                        { term: { account: contract_name } },
                        { range: { block: { lte: last_block } } }
                    ]
                }
            };
            const queryResult: estypes.SearchResponse<any, any> = await this.client.search({
                index: `${this.chain}-abi-*`,
                size: this.usesExtensionProtocol ? 2 : 1, query,
                sort: [{ block: { order: "desc" } }],
                _source: { includes: _includes }
            });
            if (this.usesExtensionProtocol) {
                assertCompleteProtocolSearch(queryResult);
            }
            const results = queryResult.hits.hits;
            if (this.usesExtensionProtocol) {
                if (results.length > 1 && results[0]._source.block === results[1]._source.block) throw new Error('Protocol ABI deployment is ambiguous');
            }
            let result: HyperionAbi | null;
            if (results.length > 0) {
                const nextRefResponse: estypes.SearchResponse<any, any> = await this.client.search({
                    index: `${this.chain}-abi-*`,
                    size: 1,
                    query: {
                        bool: {
                            must: [
                                { term: { account: contract_name } },
                                { range: { block: { gte: last_block } } }
                            ]
                        }
                    },
                    sort: [{ block: { order: "asc" } }],
                    _source: { includes: ["block"] }
                });
                if (this.usesExtensionProtocol) assertCompleteProtocolSearch(nextRefResponse);
                const nextRef = nextRefResponse.hits.hits;
                if (nextRef.length > 0) {
                    result = {
                        valid_until: nextRef[0]._source.block,
                        ...results[0]._source
                    };
                } else {
                    result = results[0]._source;
                }
            } else {
                result = null;
            }
            this.deltaAbiCache.set(cacheKey, result);
            return result;
        } catch (e) {
            if (this.usesExtensionProtocol) throw e;
            hLog(e);
            return null;
        }
    }

    registerAutoBlacklist(
        contract: string,
        field: string,
        type: string,
        block: number,
        valid_until: number | undefined
    ) {
        const info = { field, type, block, valid_until };
        if (!info.valid_until) {
            info.valid_until = 0;
        }
        if (!this.autoBlacklist.has(contract)) {
            this.autoBlacklist.set(contract, [info]);
        } else {
            this.autoBlacklist.get(contract)?.push(info)
        }
    }

    // [abiStatus, resultType, valid_from, valid_until]
    /**
     * Per-block memo of table/action type resolution, keyed (field|contract|type|block).
     * At mainnet density the same (code, table) is resolved hundreds of times per
     * block; this skips the repeated getAbiDataType native (NAPI) calls and any ES
     * fallback. abieos state is constant within a block in batch mode, so the result
     * is deterministic and format-safe; the block in the key keeps it correct across
     * ABI changes, and it is cleared per block in processDeltas. Side effects
     * (loadAbiHex, registerAutoBlacklist) run on the first miss and are idempotent.
     */
    private protocolAbiAtBlock = new Map<string, IndexedProtocolAbi>();
    private protocolAbiSelections = new Map<string, ProtocolAbiDeployment>();

    private verifyTypeCache = new Map<string, [boolean, string | undefined, number, number | undefined] | [boolean, string]>();

    async verifyLocalType(
        contract: string,
        type: string,
        block_num: number,
        field: string
    ): Promise<[boolean, string | undefined, number, number | undefined] | [boolean, string]> {

        if (this.usesExtensionProtocol) {
            this.abieos.deleteContract(contract);
            return [false, ''];
        }

        const vkey = field + '|' + contract + '|' + type + '|' + block_num;
        const vCached = this.verifyTypeCache.get(vkey);
        if (vCached !== undefined) {
            return vCached;
        }

        let abiStatus: boolean;
        let resultType: string | undefined;

        // try to get the type from the loaded contract abi if any
        try {
            resultType = this.getAbiDataType(field, contract, type);
            abiStatus = !(!resultType || resultType === "");
        } catch (e: any) {
            hLog(e.message);
            abiStatus = false;
        }

        let savedAbi: HyperionAbi | null = null;
        let valid_until: number | undefined;
        let valid_from = block_num;


        if (!abiStatus) {

            debugLog(`Fetching ABI from ES ${contract}@${block_num}`);
            savedAbi = await this.fetchAbiHexAtBlockElastic(contract, block_num, false);

            if (savedAbi) {

                if (savedAbi.valid_until) {
                    valid_until = savedAbi.valid_until;
                }

                if (savedAbi.block) {
                    valid_from = savedAbi.block;
                }

                if (savedAbi[field + 's'] && savedAbi[field + 's'].includes(type)) {

                    if (savedAbi.abi_hex && savedAbi.block) {
                        abiStatus = this.loadAbiHex(contract, savedAbi.block, savedAbi.abi_hex);
                    }

                    if (abiStatus) {
                        try {
                            resultType = this.getAbiDataType(field, contract, type);
                            // console.log(`getAbiDataType (2) ${type} (${field}) >>> "${resultType}"`);
                            abiStatus = true;
                            this.verifyTypeCache.set(vkey, [abiStatus, resultType]);
                            return [abiStatus, resultType];
                        } catch (e: any) {
                            console.log(e.message);
                            abiStatus = false;
                        }

                    } else {
                        console.log("ABI HEX was not loaded!");
                    }
                }
            }


            debugLog(`Loading current ABI (${savedAbi?.block} | ${savedAbi?.valid_until}) ${contract}`);

            try {
                abiStatus = await this.loadCurrentAbiHex(contract);
            } catch (error: any) {
                debugLog(`(abieos/current) >> ${error.message}`);
                abiStatus = false;
            }

            if (abiStatus) {
                try {
                    resultType = this.getAbiDataType(field, contract, type);
                    abiStatus = true;
                } catch (e: any) {
                    debugLog(`(abieos/current) >> ${e.message}`);
                    abiStatus = false;
                }
            }
        }

        if (!abiStatus && savedAbi) {
            this.registerAutoBlacklist(contract, field, type, valid_from, valid_until);
        }

        const result: [boolean, string | undefined, number, number | undefined] = [abiStatus, resultType, valid_from, valid_until];
        this.verifyTypeCache.set(vkey, result);
        return result;
    }

    async processContractRowNative(row: HyperionDelta, block: number) {
        // check dynamic blacklist
        if (this.autoBlacklist.has(row.code)) {
            const info = this.autoBlacklist.get(row.code)?.find(v => {
                if (v.field === "table" && v.type === row.table) {
                    if (v.block <= block) {
                        if (v.valid_until > block || v.valid_until === 0) {
                            return true;
                        }
                    }
                }
                return false;
            });
            if (info) {
                row['_blacklisted'] = true;
                return row;
            }
        }

        const stopVerify = this.profiler.start('ds_row_verify');
        const [abiStatus, tableType, validFrom, validUntil] = await this.verifyLocalType(row['code'], row['table'], block, "table");
        stopVerify();

        if (abiStatus && tableType) {
            let result: string;
            const stopDecode = this.profiler.start('ds_row_abieos');
            try {
                if (typeof row.value === 'string') {
                    result = this.abieos.hexToJson(row['code'], tableType, row.value);
                } else {
                    result = this.abieos.binToJson(row['code'], tableType, row.value);
                }
                stopDecode();
                row['data'] = result;
                delete row.value;
                return row;
            } catch (e) {
                stopDecode();
                debugLog('primary node-abieos deserialization failed', e, row);
            }
        }

        // Fallback to Antelope Deserializer
        const stopFallback = this.profiler.start('ds_row_fallback');
        const fallbackRow = await this.deserializeContractRowAntelope(row, block, validFrom, validUntil, tableType);
        stopFallback();
        return fallbackRow;
    }

    // async getContractAtBlock(accountName: string, block_num: number, check_action?: string) {
    //     let savedAbi, abi;
    //     savedAbi = await this.fetchAbiHexAtBlockElastic(accountName, block_num, true);
    //     if (savedAbi === null || (savedAbi.actions && !savedAbi.actions.includes(check_action))) {
    //         savedAbi = await this.getAbiFromHeadBlock(accountName);
    //         if (!savedAbi) return [null, null];
    //         abi = savedAbi.shipABI;
    //     } else {
    //         try {
    //             abi = JSON.parse(savedAbi.shipABI);
    //         } catch (e) {
    //             hLog(e);
    //             return [null, null];
    //         }
    //     }
    //     if (!abi) return [null, null];
    //     const initialTypes = Serialize.createInitialTypes();
    //
    //     let types: Map<string, Serialize.Type> | undefined;
    //
    //     try {
    //
    //         types = Serialize.getTypesFromAbi(initialTypes, abi);
    //
    //     } catch (e) {
    //
    //         let remapped = false;
    //         for (const struct of abi.structs) {
    //             for (const field of struct.fields) {
    //                 if (abi_remapping[field.type]) {
    //                     field.type = abi_remapping[field.type];
    //                     remapped = true;
    //                 }
    //             }
    //         }
    //
    //         if (remapped) {
    //             try {
    //                 types = Serialize.getTypesFromAbi(initialTypes, abi);
    //             } catch (e) {
    //                 hLog('failed after remapping abi');
    //                 hLog(accountName, block_num, check_action);
    //                 hLog(e);
    //             }
    //         } else {
    //             hLog(accountName, block_num);
    //             hLog(e);
    //         }
    //     }
    //
    //     const actions = new Map();
    //     if (types) {
    //         for (const {name, type} of abi.actions) {
    //             actions.set(name, Serialize.getType(types, type));
    //         }
    //     }
    //
    //     const result = {types, actions, tables: abi.tables};
    //     if (check_action) {
    //         if (actions.has(check_action)) {
    //             try {
    //                 this.abieos.loadAbi(accountName, JSON.stringify(abi));
    //             } catch (e) {
    //                 hLog(e);
    //             }
    //         }
    //     }
    //     return [result, abi];
    // }

    // async getTableType(code, table, block) {
    //     let abi, contract, abi_tables;
    //
    //     try {
    //         const r = await this.getContractAtBlock(code, block);
    //         if (r) {
    //             [contract, abi] = r;
    //         }
    //         if (contract && contract.tables) {
    //             abi_tables = contract.tables
    //         } else {
    //             return;
    //         }
    //     } catch (e: any) {
    //         hLog(e.message);
    //         return;
    //     }
    //
    //     let this_table, type;
    //     for (let t of abi_tables) {
    //         if (t.name === table) {
    //             this_table = t;
    //             break;
    //         }
    //     }
    //     if (this_table) {
    //         type = this_table.type;
    //     } else {
    //         const currentABI = await this.getAbiFromHeadBlock(code);
    //         if (!currentABI || !currentABI.abi) {
    //             return;
    //         }
    //         abi_tables = currentABI.abi.tables;
    //         for (let t of abi_tables) {
    //             if (t.name === table) {
    //                 this_table = t;
    //                 break;
    //             }
    //         }
    //         if (this_table) {
    //             type = this_table.type;
    //             const initialTypes = Serialize.createInitialTypes();
    //             contract.types = Serialize.getTypesFromAbi(initialTypes, currentABI.abi);
    //         } else {
    //             return;
    //         }
    //     }
    //     let cType = contract.types.get(type);
    //     if (!cType) {
    //         if (this.types.has(type)) {
    //             cType = this.types.get(type);
    //         } else {
    //             if (type === 'self_delegated_bandwidth') {
    //                 cType = contract.types.get('delegated_bandwidth')
    //             }
    //         }
    //         if (!cType) {
    //             hLog(code, block);
    //             hLog(`code:${code} | table:${table} | block:${block} | type:${type}`);
    //             hLog(Object.keys(contract));
    //             hLog(Object.keys(abi));
    //         }
    //     }
    //     return cType;
    // }

    async deserializeContractRowAntelope(row: HyperionDelta, block: number, validFrom, validUntil, tableType: string | undefined) {

        if (this.usesExtensionProtocol) {
            try {
                const deployment = await this.selectProtocolAbi(row.code, block, row.block_id);
                const abi: any = deployment.abi;
                const selected = abi.tables?.find(table => String(table.name) === row.table);
                if (!selected) throw new Error('No compatible protocol table mapping');
                row.data = this.protocol.contractCodec.decodeValue(abi, selected.type, protocolBytes(row.value));
                delete row.value;
            } catch (error: any) {
                row['ds_error'] = true;
                process.send?.({event: 'ds_error', data: {type: 'protocol_row_decode_incomplete',
                    block, account: row.code, table: row.table, message: error.message}});
            }
            return row;
        }

        try {
            let savedAbi = await this.fetchAbiHexAtBlockElastic(row.code, block, true);

            // attempt to load the ABI from the head block
            if (!savedAbi) {
                savedAbi = await this.getAbiFromHeadBlock(row.code);
            }

            if (!savedAbi) {
                return row;
            }

            if (savedAbi.abi) {
                const abi = ABI.from(savedAbi.abi);
                const table = abi.tables.find(t => t.name === row.table);
                if (table) {
                    row.data = Serializer.decode({ data: row.value, abi, type: table.type });
                    delete row.value;
                }
            }

            // TODO: check error on stake.libre::temppower
            // if (!row.data) {
            //     console.log(`Failed to deserialize ${row.code}::${row.table} at block ${block}`);
            //     console.log(row);
            // }

            // const row_sb = this.createSerialBuffer(Serialize.hexToUint8Array(row['value']));
            //
            // let error;
            // try {
            //     const tableType: EOSJSType = await this.getTableType(row['code'], row['table'], block);
            //     if (tableType) {
            //         try {
            //             row['data'] = tableType.deserialize(row_sb);
            //             delete row.value;
            //             return row;
            //         } catch (e: any) {
            //             error = e.message;
            //         }
            //     }
            // } catch (e: any) {
            //     hLog(e.message);
            //     error = e.message;
            // }
            // row['ds_error'] = true;
            // process.send?.({
            //     event: 'ds_error',
            //     data: {
            //         type: 'delta_ds_error',
            //         block: block,
            //         valid_until: validUntil,
            //         code: row['code'],
            //         table: row['table'],
            //         message: error
            //     }
            // });
            this.registerAutoBlacklist(row['code'], "table", row['table'], validFrom, validUntil);
        } catch (error: any) {
            hLog(`WharfKit/Antelope - Error deserializing contract row: ${error.message}`);
        }
        return row;
    }

    isAsync(fun) {
        return fun.constructor.name === 'AsyncFunction';
    }

    async processTableDelta(contractRowDelta: any, deferDynamic = false) {

        if (contractRowDelta['table'] && contractRowDelta['data']) {
            contractRowDelta['primary_key'] = String(contractRowDelta['primary_key']);
            let allowIndex: boolean;
            let handled = false;

            const key = `${contractRowDelta.code}:${contractRowDelta.table}`;
            const key2 = `${contractRowDelta.code}:*`;
            const key3 = `*:${contractRowDelta.table}`;

            if (!deferDynamic) this.pushToDynamicTableQueue(contractRowDelta);

            // strict code::table handlers
            if (this.tableHandlers[key]) {
                if (this.isAsync(this.tableHandlers[key])) {
                    await this.tableHandlers[key](contractRowDelta);
                } else {
                    this.tableHandlers[key](contractRowDelta);
                }
                handled = true;
            }

            // generic code handlers
            if (this.tableHandlers[key2]) {
                if (this.isAsync(this.tableHandlers[key2])) {
                    await this.tableHandlers[key2](contractRowDelta);
                } else {
                    this.tableHandlers[key2](contractRowDelta);
                }
                handled = true;
            }

            // generic table handlers
            if (this.tableHandlers[key3]) {
                if (this.isAsync(this.tableHandlers[key3])) {
                    await this.tableHandlers[key3](contractRowDelta);
                } else {
                    this.tableHandlers[key3](contractRowDelta);
                }
                handled = true;
            }

            if (!handled && this.conf.features.index_all_deltas) {
                allowIndex = true;
            } else {
                allowIndex = handled;
            }

            return allowIndex;
        }
    }

    /** Core helpers stage effects while a protocol row's async handlers are unresolved. */
    private stageProtocolPublication(effect: () => unknown | Promise<unknown>, bytes: number): boolean {
        const scope = this.protocolDerivedPublications?.getStore();
        if (!scope) return false;
        if (!scope.accepting) {
            process.send?.({event: 'ds_error', data: {type: 'protocol_derived_publication_incomplete',
                code: 'protocol_derived_scope_closed', message: 'Detached work cannot publish after its protocol record scope settled'}});
            return true;
        }
        this.assertWorkerAttemptActive();
        // One record cannot retain an unbounded set of helper publications.
        if (scope.failure || scope.effects.length >= 4096 || scope.bytes + bytes > 64 * 1024 * 1024) {
            scope.failure ??= new ProtocolAbiProofUnavailableError('protocol_derived_publication_limit', 'Protocol record derived publication budget exceeded');
            return true;
        }
        scope.bytes += bytes; scope.effects.push(currentProofConsumerScope()?.bindCallback(effect) ?? effect); return true;
    }

    private enqueueDerivedPublication(payload: QueuePayload): Promise<unknown> {
        // Preserve the established isolated diagnostic/drop for an already-closed record scope.
        // It performs no helper operation or publication and cannot adopt a later attempt.
        if (this.protocolDerivedPublications?.getStore()?.accepting === false) {
            this.stageProtocolPublication(() => undefined, 0); return Promise.resolve();
        }
        this.assertWorkerAttemptActive();
        const attempt = currentProofConsumerScope(), channel = this.ch;
        const queue = (value: QueuePayload) => {
            const publish = attempt?.bindCallback(() => {
                if (!channel || channel !== this.ch || !this.ch_ready) throw new Error('Original derived publisher is unavailable');
                return this.workerBufferedPublication(channel, () => channel.sendToQueue(value.queue, value.content, {headers: value.headers}));
            });
            return trackProofConsumerOperation(() => this.preIndexingQueue.push({...value, ...(publish ? {publish} : {})}));
        };
        if (!this.protocolDerivedPublications?.getStore()) return queue(payload);
        const retained: QueuePayload = {queue: payload.queue, content: Buffer.from(payload.content),
            ...(payload.headers !== undefined ? {headers: structuredClone(payload.headers)} : {})};
        this.stageProtocolPublication(() => queue(retained),
            retained.content.length + Buffer.byteLength(JSON.stringify(retained.headers ?? {})));
        return Promise.resolve();
    }

    pushToDeltaStreamingQueue(payload, jsonRow) {
        this.assertWorkerAttemptActive();
        if (this.allowStreaming && this.conf.features.streaming.deltas && this.ch) {
            const options = {headers: {
                    event: 'delta',
                    code: jsonRow.code,
                    table: jsonRow.table,
                    scope: jsonRow.scope,
                    payer: jsonRow.payer
                }};
            if (!this.protocolDerivedPublications?.getStore()) {
                this.workerBufferedPublication(this.ch, () => this.ch!.publish('', this.chain + ':stream', payload, options));
                return;
            }
            const bytes = Buffer.from(payload);
            const publish = () => this.ch && this.workerBufferedPublication(this.ch, () => this.ch!.publish('', this.chain + ':stream', bytes, options));
            this.stageProtocolPublication(publish, bytes.length + Buffer.byteLength(JSON.stringify(options.headers)));
        }
    }

    addTablePrefix(table: string, data: any) {
        const prefixedOutput = {};
        Object.keys(data).forEach(value => {
            let _val = data[value];

            // check and convert variant types
            if (Array.isArray(data[value]) && data[value].length === 2) {
                if (typeof data[value][0] === 'string' && typeof data[value][1] === 'object') {
                    _val = data[value][1];
                    _val['@type'] = data[value][0];
                }
            }


            prefixedOutput[`${table}.${value}`] = _val;
        });
        return prefixedOutput;
    }

    pushToDynamicTableQueue(jsonRow: HyperionDelta) {

        const contractState = this.conf.features.contract_state;

        if (!contractState) {
            return;
        }

        if (contractState.contracts && contractState?.contracts[jsonRow.code] || this.allowedDynamicContracts.has(jsonRow.code)) {
            if (contractState.contracts?.[jsonRow.code]?.[jsonRow.table] || this.allowedDynamicContracts.has(jsonRow.code)) {
                const doc = {
                    '@timestamp': jsonRow['@timestamp'],
                    scope: jsonRow.scope,
                    primary_key: jsonRow.primary_key,
                    payer: jsonRow.payer,
                    block_num: jsonRow.block_num,
                    block_id: jsonRow.block_id,
                    data: jsonRow.data,
                    ...(jsonRow['protocol'] ? {protocol: jsonRow['protocol']} : {})
                };
                this.enqueueDerivedPublication({
                    queue: this.chain + ":index_dynamic:" + (this.dyn_emit_idx),
                    content: bufferFromJson(doc),
                    headers: {
                        code: jsonRow.code,
                        table: jsonRow.table,
                        block_num: jsonRow.block_num,
                        present: jsonRow.present
                    }
                }).catch(console.log);
                this.dyn_emit_idx++;
                if (this.dyn_emit_idx > this.conf.scaling.dyn_idx_queues) {
                    this.dyn_emit_idx = 1;
                }
            }
        }
    }

    async pushToDeltaQueue(bufferData: any, block_num) {
        const q = this.chain + ":index_deltas:" + (this.delta_emit_idx);
        await this.enqueueDerivedPublication({
            queue: q,
            content: bufferData,
            headers: { block_num }
        });
        this.delta_emit_idx++;
        if (this.delta_emit_idx > this.conf.scaling.ad_idx_queues) {
            this.delta_emit_idx = 1;
        }
    }

    async pushToIndexQueue(data: any, type: string) {
        const q = this.chain + ":index_generic:" + (this.emit_idx);
        await this.enqueueDerivedPublication({
            queue: q,
            content: bufferFromJson(data),
            headers: { type }
        });
        this.emit_idx++;
        if (this.emit_idx > this.conf.scaling.indexing_queues) {
            this.emit_idx = 1;
        }
    }

    async pushToStateIndexQueue(data: any, type: string) {
        const q = this.chain + ":index_state:" + (this.emit_idx);
        await this.enqueueDerivedPublication({
            queue: q,
            content: bufferFromJson(data),
            headers: { type }
        });
        this.emit_idx++;
        if (this.emit_idx > this.conf.scaling.indexing_queues) {
            this.emit_idx = 1;
        }
    }

    private anyFromSender(gen_trx: any) {
        return gen_trx.sender + '::*';
    }

    checkDeltaBlacklistForGenTrx(gen_trx) {
        if (this.filters.delta_blacklist.has(this.anyFromSender(gen_trx))) {
            return true;
        }
    }

    checkDeltaWhitelistForGenTrx(gen_trx) {
        if (this.filters.delta_whitelist.has(this.anyFromSender(gen_trx))) {
            return true;
        }
    }

    deltaStructHandlers = {

        "contract_row": async (payload: any, block_num: number, block_ts: string, row: any, block_id: string) => {

            if (this.conf.indexer.abi_scan_mode) {
                return false;
            }

            if (this.conf.features.index_all_deltas ||
                (payload.code === this.conf.settings.eosio_alias || payload.table === 'accounts')) {

                payload['@timestamp'] = block_ts;
                payload['present'] = row.present;
                payload['block_num'] = block_num;
                payload['block_id'] = block_id;

                // check delta blacklist chain::code::table
                if (this.checkDeltaBlacklist(payload)) {
                    return false;
                }

                // check delta whitelist chain::code::table
                if (this.filters.delta_whitelist.size > 0) {
                    if (!this.checkDeltaWhitelist(payload)) {
                        return false;
                    }
                }

                // decode contract data
                let jsonRow = await this.processContractRowNative(payload, block_num);

                // if (jsonRow?.value) {
                //     hLog(`Deserialization failed for contract row:`, jsonRow);
                // }

                if (jsonRow?.value && !jsonRow['_blacklisted']) {
                    debugLog(jsonRow);
                    debugLog('Delta DS failed ->>', jsonRow);
                    jsonRow = await this.processContractRowNative(payload, block_num - 1);
                    debugLog('Retry with previous ABI ->>', jsonRow);
                }

                if (jsonRow['_blacklisted']) {
                    delete jsonRow['_blacklisted'];
                }

                // Print contract row that wasn't deserialized
                // if (!jsonRow.data) {
                //     hLog(jsonRow);
                // }

                if (jsonRow && await this.processTableDelta(jsonRow)) {
                    if (!this.conf.indexer.disable_indexing && this.conf.features.index_deltas) {

                        // check for plugin handlers
                        await this.mLoader.processDeltaData(jsonRow);

                        const buff = bufferFromJson(jsonRow);
                        if (process.env['live_mode'] === 'true') {
                            this.pushToDeltaStreamingQueue(buff, jsonRow);
                        }

                        if (typeof row.present !== "undefined") {
                            const isPresent = row.present === 1 || row.present === true;
                            const isDeletion = row.present === 0 || row.present === false;
                            // present=1 rows (create/modify) are always indexed. Row deletions (present=0)
                            // are only indexed when features.index_deltas_deletions is enabled, so get_deltas
                            // can surface removals (e.g. a row leaving a table). Off by default: the legacy
                            // delta-updater that tracked removals via a deleted_at marker was removed.
                            if (isPresent || (isDeletion && this.conf.features.index_deltas_deletions === true)) {
                                await this.pushToDeltaQueue(buff, block_num);
                            }
                        }
                        this.temp_delta_counter++;
                    }
                }
            }
        },

        "account": async (account: any, block_num: number, block_ts: string, row?: any, block_id?: string) => {
            if (this.usesExtensionProtocol) {
                await this.processProtocolAccount(account, block_num, block_ts, row, block_id);
                return;
            }
            if (account['abi'] !== '') {
                try {
                    const abiHex = account['abi'];
                    const abiObj: any = this.protocol.contractCodec.decodeAbi(protocolBytes(abiHex));
                    if (abiObj) {
                        const jsonABIString = JSON.stringify(abiObj);
                        const abi_actions = abiObj.actions.map(a => a.name.toString());
                        const abi_tables = abiObj.tables.map(t => t.name.toString());

                        debugLog(`📝  New code for ${account['name']} at block ${block_num} with ${abi_actions.length} actions`);

                        // console.log(`ABI actions:`, abi_actions);
                        // console.log(`ABI tables:`, abi_tables);

                        const new_abi_object = {
                            '@timestamp': block_ts,
                            account: account['name'],
                            block: block_num,
                            abi: jsonABIString,
                            abi_hex: abiHex,
                            actions: abi_actions,
                            tables: abi_tables,
                            ...(this.usesExtensionProtocol ? {protocol_profile: this.protocol.profileId, block_id, ordinal: row?.ordinal ?? 0} : {})
                        };

                        if (this.usesExtensionProtocol) this.protocolAbiAtBlock.set(account.name, new_abi_object as IndexedProtocolAbi);
                        debugLog(`[Worker ${process.env.worker_id}] read ${account['name']} ABI at block ${block_num}`);
                        const q = this.chain + ":index_abis:1";
                        await this.enqueueDerivedPublication({ queue: q, content: bufferFromJson(new_abi_object) });

                        // update locally cached abi
                        if (process.env['live_mode'] === 'true') {
                            hLog('Abi changed during live mode, updating local version...');
                            const abi_update_status = this.abieos.loadAbiHex(account['name'], abiHex);
                            if (!abi_update_status) {
                                hLog(`Reload status: ${abi_update_status}`);
                            }
                        }

                        // clear dynamic blacklist after abi update
                        if (this.autoBlacklist.has(account['name'])) {
                            hLog(`${account['name']} ABI updated, clearing dynamic blacklist entries...`);
                            this.autoBlacklist.delete(account['name']);
                        }

                        process.send?.({
                            event: 'save_abi',
                            data: new_abi_object,
                            live_mode: process.env['live_mode'],
                            worker_id: process.env.worker_id
                        });
                    }
                } catch (e: any) {
                    hLog(`Failed to process ABI from ${account['name']} at ${block_num}: ${e.message}`);
                }
            } else {
                if (account.name === 'eosio') {
                    hLog(`---------- ${block_num} ----------------`);
                    hLog(account);
                }
            }
        },

        "permission_link": async (link: any, block_num: number, block_ts: string, row: any) => {
            if (!this.conf.indexer.abi_scan_mode && this.conf.indexer.process_deltas) {
                await this.pushToStateIndexQueue({
                    "@timestamp": block_ts,
                    block_num: block_num,
                    present: row.present,
                    account: link.account,
                    code: link.code,
                    action: link['message_type'],
                    permission: link['required_permission']
                }, 'permission_link');
            }
        },

        "permission": async (perm: any, block_num: number, block_ts: string, row: any) => {
            if (!this.conf.indexer.abi_scan_mode && this.conf.indexer.process_deltas) {
                if (perm.auth.accounts.length === 0) {
                    delete perm.auth.accounts;
                }

                if (perm.auth.keys.length === 0) {
                    delete perm.auth.keys;
                }

                if (perm.auth.waits.length === 0) {
                    delete perm.auth.waits;
                }

                await this.pushToStateIndexQueue({
                    block_num: block_num,
                    present: row.present,
                    ...perm
                }, 'permission');
            }
        },

        // "account_metadata": async (account_metadata: any, block_num: number, block_ts: string, row: any, block_id: string) => {
        //     console.log(account_metadata);
        //     if (account_metadata.code) {
        //         hLog(`new code hash ${account_metadata.code.code_hash} on ${account_metadata.name}`);
        //     }
        // },

        // Deferred Transactions
        "generated_transaction": async (generated_transaction: any, block_num: number, block_ts: string) => {
            if (!this.conf.indexer.abi_scan_mode && this.conf.indexer.process_deltas && this.conf.features.deferred_trx) {

                // check delta blacklist chain::code::table
                if (this.checkDeltaBlacklistForGenTrx(generated_transaction)) {
                    return false;
                }

                // check delta whitelist chain::code::table
                if (this.filters.delta_whitelist.size > 0) {
                    if (!this.checkDeltaWhitelistForGenTrx(generated_transaction)) {
                        return false;
                    }
                }

                const unpackedTrx = this.decodePackedTransaction(generated_transaction.packed_trx);
                for (const action of unpackedTrx.actions) {
                    const act_data = await this.deserializeActionAtBlockNative(action, block_num);
                    if (act_data) {
                        action.data = act_data;
                    }
                }

                const genTxPayload = {
                    '@timestamp': block_ts,
                    block_num: block_num,
                    sender: generated_transaction.sender,
                    sender_id: generated_transaction.sender_id,
                    payer: generated_transaction.payer,
                    trx_id: generated_transaction.trx_id.toLowerCase(),
                    actions: unpackedTrx.actions,
                    packed_trx: generated_transaction.packed_trx
                };

                await this.pushToIndexQueue(genTxPayload, 'generated_transaction');
            }
        },


        // Account resource updates
        "resource_limits": async (resource_limits: any, block_num: string, block_ts: string) => {
            if (!this.conf.indexer.abi_scan_mode && this.conf.indexer.process_deltas && this.conf.features.resource_limits) {
                const cpu = parseInt(resource_limits.cpu_weight);
                const net = parseInt(resource_limits.net_weight);
                await this.pushToIndexQueue({
                    block_num: block_num,
                    '@timestamp': block_ts,
                    owner: resource_limits.owner,
                    ram_bytes: parseInt(resource_limits.ram_bytes),
                    cpu_weight: cpu,
                    net_weight: net,
                    total_weight: cpu + net
                }, 'resource_limits');
            }
        },

        // "resource_limits_config": async (resource_limits_config, block_num, block_ts, row, block_id) => {
        //     console.log(resource_limits_config);
        // },

        // "resource_limits_state": async (resource_limits_state, block_num, block_ts, row, block_id) => {
        //     hLog(block_num, resource_limits_state);
        // },

        // Resource usage updates
        "resource_usage": async (resource_usage: any, block_num: number, block_ts: string) => {
            if (!this.conf.indexer.abi_scan_mode && this.conf.indexer.process_deltas && this.conf.features.resource_usage) {
                // ignore eosio system resource usage
                if (resource_usage.owner === this.conf.settings.eosio_alias) {
                    return;
                }

                const net_used = parseInt(resource_usage.net_usage[1].consumed);
                const net_total = parseInt(resource_usage.net_usage[1].value_ex);
                let net_pct = 0.0;
                if (net_total > 0) {
                    net_pct = net_used / net_total;
                }
                const cpu_used = parseInt(resource_usage.cpu_usage[1].consumed);
                const cpu_total = parseInt(resource_usage.cpu_usage[1].value_ex);
                let cpu_pct = 0.0;
                if (cpu_total > 0) {
                    cpu_pct = cpu_used / cpu_total;
                }
                const payload = {
                    block_num: block_num,
                    '@timestamp': block_ts,
                    owner: resource_usage.owner,
                    net_used: net_used,
                    net_total: net_total,
                    net_pct: net_pct,
                    cpu_used: cpu_used,
                    cpu_total: cpu_total,
                    cpu_pct: cpu_pct,
                    ram: parseInt(resource_usage.ram_usage[1])
                }
                await this.pushToIndexQueue(payload, 'resource_usage');
            }
        },

        // Global Chain configuration update
        "global_property": async (global_property: any, block_num: number, block_ts: string) => {
            if (global_property.proposed_schedule.version !== 0) {
                hLog("Proposed Schedule version: " + global_property.proposed_schedule.version + " at block: " + global_property.proposed_schedule_block_num);
                try {
                    const payload = {
                        block_num: global_property.proposed_schedule_block_num,
                        '@timestamp': block_ts,
                        version: global_property.proposed_schedule.version,
                        producers: global_property.proposed_schedule.producers
                    };
                    payload.producers.forEach((producer: any) => {
                        producer.name = producer.producer_name;
                        delete producer.producer_name;
                        if (producer.authority[0] === 'block_signing_authority_v0') {
                            producer.authority = producer.authority[1];
                            producer.keys = producer.authority.keys.map((key: any) => {
                                return key.key;
                            });
                            delete producer.authority;
                        }
                    });
                    await this.pushToIndexQueue(payload, 'schedule');
                } catch (e: any) {
                    hLog("Failed to parse proposed schedule: " + e.message);
                }
            }
        },

        // Activated Protocol features
        // "protocol_state": async (protocol_state, block_num, block_ts, row, block_id) => {
        //     hLog(block_num, protocol_state);
        // },

        // Updated contracts
        // "code": async (code, block_num, block_ts, row, block_id) => {
        //     hLog(block_num, code);
        // },

        // "contract_index_double": async (contract_index_double, block_num, block_ts, row, block_id) => {
        //     return;
        // },

        // "contract_index64": async (cIndex64, block_num, block_ts, row, block_id) => {
        //     return;
        // },

        // "contract_index128": async (cIndex128, block_num, block_ts, row, block_id) => {
        //     return;
        // },

        // "contract_table": async (contract_table, block_num, block_ts, row, block_id) => {
        //     return;
        // },
    }

    private async processProtocolAccount(account: any, blockNum: number, blockTs: string, row: any, blockId?: string) {
        const reference = {
            '@timestamp': blockTs, account: String(account.name), block: blockNum, block_id: blockId ?? '',
            ordinal: row?.ordinal ?? 0, protocol_profile: this.protocol.profileId,
            abi_hex: Buffer.from(protocolBytes(account.abi)).toString('hex'), abi: '', actions: [] as string[], tables: [] as string[],
            abi_available: false, abi_error: '',
        };
        // A clear/rejected ABI is a deployment barrier too. Register it before
        // decoding so no same-block record can reuse a previous schema.
        this.protocolAbiAtBlock.set(reference.account, reference);
        this.protocolAbiSelections.clear();
        this.abieos.deleteContract(reference.account);
        this.verifyTypeCache.clear();
        try {
            if (!reference.abi_hex || !row?.present) throw new Error('Contract ABI is unavailable');
            const abi: any = this.protocol.contractCodec.decodeAbi(protocolBytes(reference.abi_hex));
            reference.abi = JSON.stringify(abi);
            reference.actions = abi.actions.map(action => String(action.name));
            reference.tables = abi.tables.map(table => String(table.name));
            reference.abi_available = true;
            this.autoBlacklist.delete(reference.account);
        } catch (error: any) {
            reference.abi_error = String(error.message);
            process.send?.({event: 'ds_error', data: {type: 'protocol_abi_unavailable', account: reference.account,
                block: blockNum, block_id: blockId, profileId: this.protocol.profileId,
                abiHex: reference.abi_hex, message: reference.abi_error}});
        }
        await this.enqueueDerivedPublication({queue: this.chain + ':index_abis:1', content: bufferFromJson(reference)});
        process.send?.({event: 'save_abi', data: reference, live_mode: process.env.live_mode, worker_id: process.env.worker_id});
    }

    async selectProtocolAbi(account: string, blockNum: number, blockId: string): Promise<ProtocolAbiDeployment> {
        const key = `${account}:${blockNum}:${blockId}`;
        const cached = this.protocolAbiSelections.get(key);
        if (cached) return cached;
        const selected = await this.fetchProtocolAbi(account, blockNum, blockId);
        this.protocolAbiSelections.set(key, selected);
        return selected;
    }

    private async fetchProtocolAbi(account: string, blockNum: number, blockId: string): Promise<ProtocolAbiDeployment> {
        if (!/^[a-z1-5.]{1,13}$/.test(account)) throw new Error('Invalid protocol ABI account');
        const view = this.activeProtocolAbiProofView;
        if (view && view.source.blockNum === blockNum && view.source.blockId === blockId) {
            let state;
            try { state = await this.getProtocolAbiProofReader().finalState(view, account); }
            catch (error) {
                if (error instanceof ProtocolAbiProofUnavailableError) throw error;
                throw new ProtocolProofStorageError(error);
            }
            const deployment = protocolDeployment(this.protocol, {account: state.account, block: state.source.blockNum,
                block_id: state.source.blockId, abi_hex: state.abiHex, protocol_profile: state.protocol.profileId,
                abi_available: state.present && !!state.abiHex}, account, blockNum, blockId);
            this.protocolAbiProofDeployments.set(deployment.id, view);
            return deployment;
        }
        const local = this.protocolAbiAtBlock.get(account);
        if (local?.block === blockNum && local.block_id === blockId) {
            return protocolDeployment(this.protocol, local, account, blockNum, blockId);
        }
        // An ES refresh can hide a newer ABI deployment. Until the runtime has
        // canonical coverage and trace-epoch binding, an ES-latest hit is not proof.
        throw new Error(`Canonical ABI coverage is unavailable for ${account} at ${blockNum}`);
    }

    private async processProtocolRecord(normalized: Extract<ProtocolNormalizedDelta, {kind: 'record'}>,
                                        raw: Uint8Array, blockTs: string) {
        const record: any = normalized.record;
        const source = normalized.source;
        const metadata = normalized.metadata;
        const proof = this.protocolAbiProofDeployments.get(String(source.abiDeployment));
        const revalidate = async () => {
            if (!proof) return;
            const stop = this.profiler.start('protocol_abi_final_revalidate');
            try { await this.getProtocolAbiProofReader().revalidate(proof); }
            catch (error) {
                if (error instanceof ProtocolAbiProofUnavailableError) throw error;
                throw new ProtocolProofStorageError(error);
            } finally { stop(); }
        };
        if (!['row', 'index'].includes(String(metadata.recordKind)) || typeof metadata.present !== 'boolean'
            || typeof metadata.code !== 'string' || typeof metadata.payer !== 'string') throw new Error('Incomplete normalized protocol record');
        const payload: any = {
            '@timestamp': blockTs, block_num: source.blockNum, block_id: source.blockId,
            code: metadata.code, scope: '', table: normalized.tableName,
            primary_key: protocolStateKey(this.protocolId, source.chainId, normalized.identity),
            payer: metadata.payer, present: metadata.present ? 1 : 0,
            data: normalized.value ?? {},
            protocol: {id: this.protocolId, profileId: this.protocol.profileId,
                logicalIdentity: normalized.identity, record, source, rawHex: Buffer.from(raw).toString('hex'),
                // ABI bytes are indexed once by the account delta, then referenced by deployment.
                metadata: Object.fromEntries(Object.entries(normalized.metadata).filter(([key]) => key !== 'abiHex'))},
        };
        if (this.checkDeltaBlacklist(payload) || (this.filters.delta_whitelist.size && !this.checkDeltaWhitelist(payload))) return;
        const isPrimary = metadata.recordKind === 'row';
        if (!this.conf.indexer.disable_indexing) {
            const dynamicPayload = structuredClone(payload);
            const scope: ProtocolDerivedPublications = {accepting: true, bytes: 0, effects: []};
            await this.protocolDerivedPublications.run(scope, async () => {
                try {
                    // Both primary and source-secondary records have full identities and
                    // delete semantics. Secondary rows do not execute primary-table hooks.
                    await revalidate();
                    if (isPrimary && metadata.present) {
                        await this.processTableDelta(payload, true);
                        await revalidate();
                    }
                    if (this.conf.features.index_deltas && (metadata.present || this.conf.features.index_deltas_deletions)) {
                        if (isPrimary && metadata.present) await this.mLoader.processDeltaData(payload);
                        await revalidate();
                        const bytes = bufferFromJson(payload);
                        if (process.env.live_mode === 'true') this.pushToDeltaStreamingQueue(bytes, payload);
                        await this.pushToDeltaQueue(bytes, source.blockNum);
                        this.temp_delta_counter++;
                    }
                    await revalidate();
                    this.pushToDynamicTableQueue(dynamicPayload);
                    scope.accepting = false;
                    if (scope.failure) throw scope.failure;
                    // Builtin handlers can await and call several core publication helpers.
                    // No staged write is visible until their final applicability check passes.
                    await revalidate();
                    for (const effect of scope.effects) {
                        await revalidate();
                        try { await effect(); }
                        catch (error) { throw new ProtocolProofStorageError(error); }
                    }
                } finally { scope.accepting = false; scope.effects.length = 0; }
            });
        }
    }

    async processDeltas(deltas: [string, TableDelta][], block_num: number, block_ts: string, block_id: string) {
        this.assertWorkerAttemptActive();
        const stopDeltas = this.profiler.start('process_deltas');
        this.deltaAbiCache.clear();
        this.verifyTypeCache.clear();
        // A block-local final-state ABI is usable before its async ES write becomes visible.
        this.protocolAbiAtBlock?.clear();
        this.protocolAbiSelections?.clear();
        this.protocolAbiProofDeployments?.clear();
        let ordinal = 0;
        try {
            for (const delta of deltas) {
                if (!Array.isArray(delta) || !['table_delta_v0', 'table_delta_v1'].includes(delta[0])) throw new Error('Unsupported table_delta variant');
                const {name: key, rows} = delta[1];
                for (const row of rows) {
                    this.assertWorkerAttemptActive();
                    const raw = protocolBytes(row.data);
                    const data = this.deserializeNative(key, raw);
                    const position = {chainId: this.chainId, blockId: block_id, blockNum: block_num, ordinal: ordinal++};
                    if (![true, false, 0, 1].includes(row.present as any)) throw new Error('Invalid delta presence flag');
                    const present = row.present === true || Number(row.present) === 1;
                    // Every stream reaches the selected provider before downstream filtering.
                    // Unsupported protocol layouts escape this boundary; contract ABI issues do not.
                    let normalized = this.protocol?.normalizeDelta({stream: key, present, raw, value: data}, position)
                        ?? {kind: 'passthrough' as const, value: data};
                    if (normalized.kind === 'ignore') continue;
                    if (this.conf.indexer.abi_scan_mode && key !== 'account') continue;
                    let selectedDeployment: ProtocolAbiDeployment | undefined;
                    if (normalized.kind === 'abi-required') {
                        try {
                            const abiDeployment = await this.selectProtocolAbi(normalized.account, block_num, block_id);
                            this.assertWorkerAttemptActive();
                            selectedDeployment = abiDeployment;
                            normalized = this.protocol.normalizeDelta({stream: key, present, raw, value: data}, {...position, abiDeployment});
                            if (normalized.kind === 'abi-required') throw new Error('Provider repeated an ABI dependency request');
                            if (normalized.kind === 'ignore') continue;
                        } catch (error: any) {
                            this.assertWorkerAttemptActive();
                            if (error instanceof ProtocolProofStorageError) throw error;
                            process.send?.({event: 'ds_error', data: {type: 'protocol_projection_incomplete',
                                ...position, stream: key, message: error.message, rawHex: Buffer.from(raw).toString('hex')}});
                            hLog(`Protocol contract record incomplete: ${key} at ${block_num}: ${error.message}`);
                            continue;
                        }
                    }
                    if (normalized.kind === 'passthrough' && !this.deltaStructHandlers[key] && this.usesExtensionProtocol) {
                        throw new Error(`Provider passed an unsupported required stream: ${key}`);
                    }
                    try {
                        if (normalized.kind === 'record') {
                            if (normalized.source.chainId !== position.chainId || normalized.source.blockId !== position.blockId
                                || normalized.source.blockNum !== position.blockNum || normalized.source.ordinal !== position.ordinal
                                || (selectedDeployment && normalized.source.abiDeployment !== selectedDeployment.id)) {
                                throw new Error('Provider changed the host-selected source or ABI deployment');
                            }
                            await this.processProtocolRecord(normalized, raw, block_ts);
                        } else if (this.deltaStructHandlers[key]) {
                            const value = normalized.value;
                            if (!Array.isArray(value) || value.length !== 2) throw new Error(`Invalid normalized delta: ${key}`);
                            await this.deltaStructHandlers[key](value[1], block_num, block_ts,
                                {...row, present: present ? 1 : 0, ordinal: position.ordinal}, block_id);
                        }
                    } catch (error: any) {
                        this.assertWorkerAttemptActive();
                        if (error instanceof ProtocolProofStorageError) throw error;
                        if (this.usesExtensionProtocol) process.send?.({event: 'ds_error', data: {type: 'protocol_record_incomplete',
                            ...position, stream: key, message: error.message, rawHex: Buffer.from(raw).toString('hex')}});
                        hLog(`Delta struct [${key}] processing error: ${error.message}`);
                    }
                }
            }
        } finally { stopDeltas(); }
    }

    deserializeNative(datatype: string, array: any): any {
        if (this.usesExtensionProtocol || this.shipSession) return this.decodeShipValue(datatype, array);
        // Compatibility for prototype-based native regression probes.
        if (this.shipABI) return typeof array === 'string'
            ? this.abieos.hexToJson('0', datatype, array)
            : this.abieos.binToJson('0', datatype, array);
        throw new Error('Protocol SHiP session is not initialized');
    }

    async deserializeActionAtBlockNative(action: Action, block_num: number): Promise<any> {
        const [status, actionType] = await this.verifyLocalType(
            action.account.toString(),
            action.name.toString(),
            block_num,
            "action"
        );

        if (status && actionType) {
            try {
                return this.abieos.binToJson(
                    action.account.toString(),
                    actionType,
                    protocolBytes(action.data)
                );
            } catch (e: any) {
                debugLog(`deserializeActionAtBlockNative: ${e.message}`);
            }
        }
        return null;
    }

    async storeProposal(data) {
        const proposalDoc = {
            proposer: data['scope'],
            proposal_name: data['@approvals']['proposal_name'],
            requested_approvals: data['@approvals']['requested_approvals'],
            provided_approvals: data['@approvals']['provided_approvals'],
            executed: data.present === false || data.present === 0,
            primary_key: data['primary_key'],
            block_num: data['block_num']
        };
        if (!this.conf.indexer.disable_indexing) {
            const q = this.chain + ":index_table_proposals:" + (this.tbl_prop_emit_idx);
            await this.enqueueDerivedPublication({
                queue: q,
                content: bufferFromJson(proposalDoc)
            });
            this.tbl_prop_emit_idx++;
            if (this.tbl_prop_emit_idx > (this.conf.scaling.indexing_queues)) {
                this.tbl_prop_emit_idx = 1;
            }
        }
    }

    async storeProposalTransaction(delta: HyperionDelta) {
        const trx = delta['@proposal']['transaction'];
        const transaction = Serializer.objectify(trx);
        const proposalDoc = {
            proposal_name: delta['@proposal']['proposal_name'],
            proposer: delta['scope'],
            expiration: transaction.expiration ?? null,
            trx: {
                ...transaction,
                actions: trx.actions.map((action: any) => {
                    const obj = Serializer.objectify(action);
                    return {
                        account: obj.account,
                        name: obj.name,
                        authorization: obj.authorization,
                        data: action.data,  // already deserialized by the handler
                    };
                }),
            },
            block_num: delta['block_num'],
        };
        if (!this.conf.indexer.disable_indexing) {
            const q = this.chain + ":index_table_proposals:" + (this.tbl_prop_emit_idx);
            await this.enqueueDerivedPublication({
                queue: q,
                content: bufferFromJson(proposalDoc)
            });
            this.tbl_prop_emit_idx++;
            if (this.tbl_prop_emit_idx > (this.conf.scaling.indexing_queues)) {
                this.tbl_prop_emit_idx = 1;
            }
        }
    }

    async storeVoter(data) {
        if (data['@voters']) {
            const voterDoc: any = {
                "voter": data['payer'],
                "last_vote_weight": data['@voters']['last_vote_weight'],
                "is_proxy": data['@voters']['is_proxy'],
                "proxied_vote_weight": data['@voters']['proxied_vote_weight'],
                "staked": data['@voters']['staked'],
                "primary_key": data['primary_key'],
                "block_num": data['block_num']
            };
            if (data['@voters']['proxy']) {
                voterDoc.proxy = data['@voters']['proxy'];
            }
            if (data['@voters']['producers']) {
                voterDoc.producers = data['@voters']['producers'];
            }
            if (!this.conf.indexer.disable_indexing) {
                const q = this.chain + ":index_table_voters:" + (this.tbl_vote_emit_idx);
                await this.enqueueDerivedPublication({
                    queue: q,
                    content: bufferFromJson(voterDoc)
                });
                this.tbl_vote_emit_idx++;
                if (this.tbl_vote_emit_idx > (this.conf.scaling.indexing_queues)) {
                    this.tbl_vote_emit_idx = 1;
                }
            }
        }
    }

    async storeAccount(data: HyperionDelta) {
        const accountDoc = {
            "code": data['code'],
            "scope": data['scope'],
            "block_num": data['block_num'],
            "present": data['present']
        };

        if (data['@accounts']) {
            accountDoc['amount'] = data['@accounts']['amount'];
            accountDoc['symbol'] = data['@accounts']['symbol'];
        } else {
            // debugLog(`${data['code']} is not a valid token contract!`, data);
            return;
        }

        if (!this.conf.indexer.disable_indexing) {
            const q = this.chain + ":index_table_accounts:" + (this.tbl_acc_emit_idx);
            await this.enqueueDerivedPublication({
                queue: q,
                content: bufferFromJson(accountDoc)
            });
            this.tbl_acc_emit_idx++;
            if (this.tbl_acc_emit_idx > (this.conf.scaling.indexing_queues)) {
                this.tbl_acc_emit_idx = 1;
            }
        }
    }

    private async populateTableHandlers() {

        const systemContract = this.conf.settings.system_contract ?? (this.conf.settings.eosio_alias ?? 'eosio');

        this.tableHandlers[systemContract + ':voters'] = (delta: HyperionDelta) => {
            delta['@voters'] = {};
            delta['@voters']['is_proxy'] = delta.data['is_proxy'];
            delete delta.data['is_proxy'];
            delete delta.data['owner'];
            if (delta.data['proxy'] !== "") {
                delta['@voters']['proxy'] = delta.data['proxy'];
            }
            delete delta.data['proxy'];
            if (delta.data['producers'].length > 0) {
                delta['@voters']['producers'] = delta.data['producers'];
            }
            delete delta.data['producers'];
            delta['@voters']['last_vote_weight'] = parseFloat(delta.data['last_vote_weight']);
            delete delta.data['last_vote_weight'];
            delta['@voters']['proxied_vote_weight'] = parseFloat(delta.data['proxied_vote_weight']);
            delete delta.data['proxied_vote_weight'];
            delta['@voters']['staked'] = parseFloat(delta.data['staked']);
            delete delta.data['staked'];
            if (this.conf.features.tables.voters) {
                this.storeVoter(delta);
            }
        };

        this.tableHandlers[systemContract + ':global'] = (delta: HyperionDelta) => {
            delta['@global'] = delta['data'];
            delete delta['data'];
        };

        this.tableHandlers[systemContract + ':producers'] = (delta: HyperionDelta) => {
            const data = delta['data'];
            if (data) {
                const isActive = data['is_active'];
                delta['@producers'] = {
                    total_votes: parseFloat(data['total_votes']),
                    is_active: isActive === 0 ? false : isActive === 1 ? true : isActive,
                    unpaid_blocks: data['unpaid_blocks']
                };
                delete delta['data'];
            }
        };

        this.tableHandlers[systemContract + ':userres'] = (delta: HyperionDelta) => {
            const data = delta['data'];
            if (data['net_weight'] && data['cpu_weight']) {
                const net = parseFloat(data['net_weight'].split(" ")[0]);
                const cpu = parseFloat(data['cpu_weight'].split(" ")[0]);
                delta['@userres'] = {
                    owner: data['owner'],
                    net_weight: net,
                    cpu_weight: cpu,
                    total_weight: parseFloat((net + cpu).toFixed(4)),
                    ram_bytes: parseInt(data['ram_bytes'])
                };
                delete delta['data'];
            }
        };

        this.tableHandlers[systemContract + ':delband'] = (delta: HyperionDelta) => {
            const data = delta['data'];
            if (data['net_weight'] && data['cpu_weight']) {
                const net = parseFloat(data['net_weight'].split(" ")[0]);
                const cpu = parseFloat(data['cpu_weight'].split(" ")[0]);
                delta['@delband'] = {
                    from: data['from'],
                    to: data['to'],
                    net_weight: net,
                    cpu_weight: cpu,
                    total_weight: parseFloat((net + cpu).toFixed(4))
                };
                delete delta['data'];
            }
        };

        this.tableHandlers[systemContract + '.msig:proposal'] = async (delta: HyperionDelta) => {
            // decode packed_transaction
            delta['@proposal'] = {
                proposal_name: delta['data']['proposal_name']
            };
            const trx = this.decodePackedTransaction(delta.data['packed_transaction']);
            for (const action of trx.actions) {
                const hex_data = action.data;
                action.data = await this.deserializeActionAtBlockNative(action, delta.block_num);
            }
            delta['@proposal']['transaction'] = trx;
            delete delta['data'];

            // Store decoded transaction data (expiration + actions) in MongoDB
            if (this.conf.features.tables.proposals) {
                await this.storeProposalTransaction(delta);
            }
        };

        this.tableHandlers[systemContract + '.msig:approvals'] = (delta: HyperionDelta) => {
            delta['@approvals'] = {
                proposal_name: delta['data']['proposal_name'],
                requested_approvals: delta['data']['requested_approvals'],
                provided_approvals: delta['data']['provided_approvals']
            };
            delete delta['data'];
            if (this.conf.features.tables.proposals) {
                this.storeProposal(delta);
            }
        };

        this.tableHandlers[systemContract + '.msig:approvals2'] = (delta: HyperionDelta) => {
            delta['@approvals'] = {
                proposal_name: delta['data']['proposal_name'],
                requested_approvals: delta['data']['requested_approvals'].map((item: any) => {
                    return { actor: item.level.actor, permission: item.level.permission, time: item.time };
                }),
                provided_approvals: delta['data']['provided_approvals'].map((item: any) => {
                    return { actor: item.level.actor, permission: item.level.permission, time: item.time };
                })
            };
            if (this.conf.features.tables.proposals) {
                this.storeProposal(delta);
            }
        };

        this.tableHandlers['*:accounts'] = (delta: HyperionDelta) => {

            if (!delta.data) {
                // attempt forced deserialization
                if (delta.value.length === 32) {
                    try {
                        const decoded = Serializer.decode({ type: TokenAccount, data: delta['value'] });
                        delta['data'] = Serializer.objectify(decoded);
                    } catch (e) {
                        console.log(e);
                        hLog(`Forced accounts table deserialization failed on ${delta['code']}`);
                    }
                }
            }

            if (delta['data'] && typeof delta['data']['balance'] === 'string') {
                try {
                    const [amount, symbol] = delta['data']['balance'].split(" ");
                    delta['@accounts'] = {
                        amount: parseFloat(amount),
                        symbol: symbol
                    };
                    delete delta.data['balance'];
                } catch (e) {
                    hLog(delta);
                    hLog(e);
                }
            }

            if (this.conf.features.tables.accounts) {
                this.storeAccount(delta);
            }
        };
    }
}
