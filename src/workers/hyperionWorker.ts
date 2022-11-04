import {HyperionConfig} from "../interfaces/hyperionConfig.js";
import {ConnectionManager} from "../connections/manager.class.js";
import {HyperionModuleLoader} from "../modules/loader.js";
import {ConfigurationModule, Filters} from "../modules/config.js";
import {JsonRpc} from "enf-eosjs";
import {Client} from "@elastic/elasticsearch";
import {Channel, ConfirmChannel} from "amqplib/callback_api.js";
import {EventEmitter} from "events";
import * as v8 from "v8";
import {HeapInfo} from "v8";
import {debugLog, hLog} from "../helpers/common_functions.js";
import {StateHistorySocket} from "../connections/state-history.js";
import {Abieos} from "@eosrio/node-abieos";

export abstract class HyperionWorker {

    conf: HyperionConfig;
    manager: ConnectionManager;
    mLoader: HyperionModuleLoader;
    chain: string;
    chainId: string;

    // AMQP Channels
    ch!: Channel;
    cch!: ConfirmChannel;

    rpc: JsonRpc;
    client: Client;
    ship: StateHistorySocket;

    txEnc = new TextEncoder();
    txDec = new TextDecoder();
    cch_ready = false;
    ch_ready = false;

    events: EventEmitter;

    filters: Filters;

    failedAbiMap: Map<string, Set<number>> = new Map();

    protected abieos = Abieos.getInstance();

    protected constructor() {
        this.checkDebugger();
        const cm = new ConfigurationModule();
        this.conf = cm.config;
        this.filters = cm.filters;
        this.manager = new ConnectionManager(cm);
        this.mLoader = new HyperionModuleLoader(cm);
        this.chain = this.conf.settings.chain;
        this.chainId = this.manager.conn.chains[this.chain].chain_id;
        this.rpc = this.manager.nodeosJsonRPC;
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
                    const report: HeapInfo = v8.getHeapStatistics();
                    const used_pct = report.used_heap_size / report.heap_size_limit;
                    process.send?.({
                        event: 'v8_heap_report',
                        id: process.env.worker_role + ':' + process.env.worker_id,
                        data: {
                            heap_usage: (used_pct * 100).toFixed(2) + "%",
                            ...report
                        }
                    });
                    break;
                }
                case 'request_memory_usage': {
                    const report = process.memoryUsage();
                    process.send?.({
                        event: 'memory_report',
                        id: process.env.worker_role + ':' + process.env.worker_id,
                        data: {
                            resident: bytesToString(report.rss),
                        }
                    });
                    break;
                }
                default: {
                    this.onIpcMessage(msg);
                }
            }
        });
    }

    async connectAMQP() {
        [this.ch, this.cch] = await this.manager.createAMQPChannels((channels) => {
            [this.ch, this.cch] = channels;
            hLog('AMQP Reconnecting...');
            this.onConnect();
        }, () => {
            this.ch_ready = false;
            this.cch_ready = false;
        });
    }

    onConnect() {
        this.ch_ready = true;
        this.cch_ready = true;
        this.assertQueues();
        this.ch.on('close', () => {
            this.ch_ready = false;
        });
        this.cch.on('close', () => {
            this.cch_ready = false;
        });
        this.events.emit('ready');
    }

    checkDebugger() {
        if (/--inspect/.test(process.execArgv.join(' '))) {
            const inspector = require('inspector');
            hLog('DEBUGGER ATTACHED', inspector.url());
        }
    }

    private anyFromCode(act: any) {
        return this.chain + '::' + act.account + '::*'
    }

    private anyFromName(act: any) {
        return this.chain + '::*::' + act.name;
    }

    private codeActionPair(act: any) {
        return this.chain + '::' + act.account + '::' + act.name;
    }

    private anyFromDeltaCode(delta: any) {
        return this.chain + '::' + delta.code + '::*'
    }

    private anyFromDeltaTable(delta: any) {
        return this.chain + '::*::' + delta.table;
    }

    private codeDeltaPair(delta: any) {
        return this.chain + '::' + delta.code + '::' + delta.table;
    }

    protected checkBlacklist(act) {

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

    protected checkWhitelist(act) {

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

    protected checkDeltaBlacklist(delta) {

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

    protected checkDeltaWhitelist(delta) {

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

    loadAbiHex(contract, block_num, abi_hex) {
        // check local blacklist for corrupted abis that failed to load before
        let _status;
        if (this.failedAbiMap.has(contract) && this.failedAbiMap.get(contract)?.has(block_num)) {
            _status = false;
            debugLog('ignore saved abi for', contract, block_num);
        } else {
            _status = this.abieos.loadAbiHex(contract, abi_hex);
            if (!_status) {
                hLog(`AbiEOS.load_abi_hex error for ${contract} at ${block_num}`);
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

    removeFromFailed(contract) {
        if (this.failedAbiMap.has(contract)) {
            this.failedAbiMap.delete(contract);
            hLog(`${contract} was removed from the failed map!`);
        }
    }

    async fetchAbiAtBlock(contractName: string, lastBlock: number, getJson: boolean): Promise<any> {
        try {
            const t_start = process.hrtime.bigint();
            const _includes = ["actions", "tables", "block"];
            if (getJson) {
                _includes.push("abi");
            } else {
                _includes.push("abi_hex");
            }
            const contractTerm = {term: {account: contractName}};
            const lteQuery = {
                bool: {must: [contractTerm, {range: {block: {lte: lastBlock}}}]}
            };
            const gteQuery = {
                bool: {must: [contractTerm, {range: {block: {gte: lastBlock}}}]}
            };
            const queryResult = await this.client.search<any>({
                index: `${this.chain}-abi-*`,
                size: 1,
                query: lteQuery,
                sort: [{block: {order: "desc"}}],
                _source: {includes: _includes}
            });
            const results = queryResult.hits.hits;
            if (results.length > 0) {
                const nextRefResponse = await this.client.search<any>({
                    index: `${this.chain}-abi-*`,
                    size: 1,
                    query: gteQuery,
                    sort: [{block: {order: "asc"}}],
                    _source: {includes: ["block"]}
                });
                const nextRef = nextRefResponse.hits.hits;

                const t_end = process.hrtime.bigint();
                const results = queryResult.hits.hits;
                const duration = (Number(t_end - t_start) / 1000 / 1000).toFixed(2);
                hLog(`fetchAbiAtBlock took: ${duration} ms`);

                const from = results[0]._source.block;

                let until = -1;
                if (nextRef.length > 0) {
                    until = nextRef[0]._source.block;
                }

                console.log(contractName, from, until);

                return {
                    valid_from: from,
                    valid_until: until,
                    ...results[0]._source
                };

            } else {
                return null;
            }
        } catch (e: any) {
            hLog(e);
            return null;
        }
    }

    async loadCurrentAbiHex(contract) {
        let _status;
        if (this.failedAbiMap.has(contract) && this.failedAbiMap.get(contract)?.has(-1)) {
            _status = false;
            debugLog('ignore current abi for', contract);
        } else {
            const currentAbi = await this.rpc.getRawAbi(contract);
            if (currentAbi.abi.byteLength > 0) {
                const abi_hex = Buffer.from(currentAbi.abi).toString('hex');
                _status = this.abieos.loadAbiHex(contract, abi_hex);
                if (!_status) {
                    hLog(`AbiEOS.load_abi_hex error for ${contract} at head`);
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

    abstract assertQueues(): void

    abstract onIpcMessage(msg: any): void

}
