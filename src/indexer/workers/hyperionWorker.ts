import {Client} from "@elastic/elasticsearch";
import {EventEmitter} from "events";
import {Abieos} from "@eosrio/node-abieos";
import {Channel, ConfirmChannel} from "amqplib";

import {HyperionConfig} from "../../interfaces/hyperionConfig.js";
import {ConnectionManager} from "../connections/manager.class.js";
import {HyperionModuleLoader} from "../modules/loader.js";
import {ConfigurationModule, Filters} from "../modules/config.js";
import {debugLog, hLog} from "../helpers/common_functions.js";
import {StateHistorySocket} from "../connections/state-history.js";
import {BasicDelta} from "../../interfaces/hyperion-delta.js";
import {getHeapStatistics, HeapInfo} from "node:v8";
import {HyperionActionAct} from "../../interfaces/hyperion-action.js";
import {APIClient} from "@wharfkit/antelope";
import {HyperionAbi} from "../../interfaces/hyperion-abi.js";

export abstract class HyperionWorker {

    conf: HyperionConfig;
    manager: ConnectionManager;
    mLoader: HyperionModuleLoader;
    chain: string;
    chainId: string;

    // AMQP Channels
    ch?: Channel;
    cch?: ConfirmChannel;

    rpc: APIClient;
    client: Client;
    ship: StateHistorySocket;

    cch_ready = false;
    ch_ready = false;

    events: EventEmitter;

    filters: Filters;

    failedAbiMap: Map<string, Set<number>> = new Map();
    protected abieos = Abieos.getInstance();
    configModule: ConfigurationModule;

    protected constructor() {
        this.checkDebugger();
        const cm = new ConfigurationModule();
        this.configModule = cm;
        this.conf = cm.config;
        this.filters = cm.filters;
        this.manager = new ConnectionManager(cm);
        this.mLoader = new HyperionModuleLoader(cm);
        this.chain = this.conf.settings.chain;
        this.chainId = this.manager.conn.chains[this.chain].chain_id;
        this.rpc = this.manager.nodeosApiClient;
        this.client = this.manager.elasticsearchClient;
        this.ship = this.manager.shipClient;
        this.events = new EventEmitter();

        this.mLoader.init().then(() => {
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
                this.ch.on('close', () => {
                    this.ch_ready = false;
                });
                this.cch.on('close', () => {
                    this.cch_ready = false;
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

    private anyFromCode(act: HyperionActionAct) {
        return this.chain + '::' + act.account + '::*'
    }

    private anyFromName(act: HyperionActionAct) {
        return this.chain + '::*::' + act.name;
    }

    private codeActionPair(act: HyperionActionAct) {
        return this.chain + '::' + act.account + '::' + act.name;
    }

    private anyFromDeltaCode(delta: BasicDelta) {
        return this.chain + '::' + delta.code + '::*'
    }

    private anyFromDeltaTable(delta: BasicDelta) {
        return this.chain + '::*::' + delta.table;
    }

    private codeDeltaPair(delta: BasicDelta) {
        return this.chain + '::' + delta.code + '::' + delta.table;
    }

    protected checkBlacklist(act: HyperionActionAct) {

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

    protected checkWhitelist(act: HyperionActionAct) {

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
        let _status: boolean;
        if (this.failedAbiMap.has(contract) && this.failedAbiMap.get(contract)?.has(-1)) {
            _status = false;
            debugLog('ignore current abi for', contract);
        } else {
            const currentAbi = await this.rpc.v1.chain.get_raw_abi(contract);
            if (currentAbi.abi.array.byteLength > 0) {
                const abi_hex = Buffer.from(currentAbi.abi.array).toString('hex');
                _status = this.abieos.loadAbiHex(contract, abi_hex);
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

