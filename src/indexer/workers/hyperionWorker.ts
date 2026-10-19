import { Client } from "@elastic/elasticsearch";
import { EventEmitter } from "events";
import type {ProtocolProvider, ProtocolShipSession} from "@eosrio/hyperion-sdk/protocol";
import {loadChainProtocol} from "../protocol/selection.js";
import {ContractDecoder, protocolBytes} from "../protocol/contract-cache.js";
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
    protocolReady!: Promise<void>;
    shipSession?: ProtocolShipSession;
    private protocolShipAbi?: unknown;
    configModule: ConfigurationModule;

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
        this.abieos = selected.decoder;
    }

    async initializeProtocolShip(abiString: string): Promise<void> {
        await this.protocolReady;
        const handshake = JSON.parse(abiString);
        const replacement = this.protocol.createShipSession(handshake);
        this.shipSession?.close?.();
        this.shipSession = replacement;
        this.protocolShipAbi = handshake;
    }

    decodeShipResult(bytes: Uint8Array): any {
        if (!this.shipSession) throw new Error("Protocol SHiP session is not initialized");
        return this.shipSession.decodeResult(bytes);
    }

    decodeShipValue(type: string, input: unknown): any {
        if (!this.shipSession) throw new Error("Protocol SHiP session is not initialized");
        const bytes = protocolBytes(input);
        switch (type) {
            case "signed_block": return this.shipSession.decodeBlock(bytes);
            case "transaction_trace[]": return this.shipSession.decodeTraces(bytes);
            case "table_delta[]": return this.shipSession.decodeDeltas(bytes);
            default: return this.shipSession.decodeRow(type, bytes);
        }
    }

    decodePackedTransaction(input: any): any {
        if (!this.usesExtensionProtocol) return PackedTransaction.from(input).getTransaction();
        const compression = Number(input?.compression ?? 0);
        if (compression !== 0 && compression !== 1) throw new Error('Unsupported packed transaction compression');
        const bytes = protocolBytes(input?.packed_trx ?? input);
        if (!this.shipSession || !this.protocolShipAbi) throw new Error('Protocol SHiP session is not initialized');
        return this.protocol.contractCodec.decodeValue(this.protocolShipAbi, 'transaction', compression === 1
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

