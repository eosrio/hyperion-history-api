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
import {publishAdmittedAction, type ActionPublicationOwner} from '../history/action-confirmed-publication.js';

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

    /** Internal engineering seam. Public activation requires the remaining #225 qualification gates. */
    get actionSourceAdmissionEnabled(): boolean {return false;}

    getActionAdmissionStore(): ActionSourceAdmissionStore {
        return this.actionAdmissionStore ??= new ActionSourceAdmissionStore(this.client, this.chain, this.conf.settings.es_replicas ?? 0);
    }
    captureActionAdmissionDelivery(message: object, channel: Channel): void {
        const previous = this.actionAdmissionOwners.get(message);
        if (previous && previous !== channel) throw new Error('Cannot replace an admitted action consumer receipt');
        this.actionAdmissionOwners.set(message, channel);
    }
    actionPublicationOwner(message: object): ActionPublicationOwner {
        const consumer = this.actionAdmissionOwners.get(message), publisher = this.cch;
        if (!consumer || !publisher) throw new Error('Admitted action lacks its original consumer/publisher channels');
        const owner = {consumer, publisher, current: () => consumer === this.ch && publisher === this.cch && this.ch_ready && this.cch_ready};
        if (!owner.current()) throw new Error('Admitted action channels are unavailable');
        return owner;
    }
    async publishAdmitted(owner: ActionPublicationOwner, queue: string, content: Buffer, headers: any): Promise<void> {
        await publishAdmittedAction(owner, queue, content, {headers});
    }
    async actionTarget(blockNum: number, provision = false): Promise<{name: string; uuid: string}> {
        const settings = this.conf.settings;
        if (!Number.isSafeInteger(blockNum) || blockNum < 1 || !Number.isSafeInteger(settings.index_partition_size)
            || settings.index_partition_size < 1) throw new Error('Invalid admitted action partition');
        const name = `${this.chain}-action-${settings.index_version}-${Math.ceil(blockNum / settings.index_partition_size).toString().padStart(6, '0')}`;
        if (provision && !await this.client.indices.exists({index: name})) {
            try {
                const result = await this.client.indices.create({index: name});
                if (result.acknowledged !== true || result.shards_acknowledged !== true || result.index !== name)
                    throw new Error('Action admission target creation was not acknowledged');
            } catch (error: any) {
                if (error?.meta?.statusCode !== 400 || error?.meta?.body?.error?.type !== 'resource_already_exists_exception') throw error;
            }
        }
        const result = await this.client.indices.getSettings({index: name, flat_settings: true});
        const uuid = result[name]?.settings?.['index.uuid'];
        if (Object.keys(result).length !== 1 || typeof uuid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uuid))
            throw new Error('Action admission requires a concrete target UUID');
        return {name, uuid};
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
        const selected = await loadChainProtocol(this.conf.settings.protocol);
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

