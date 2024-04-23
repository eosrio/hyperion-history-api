import {Client} from "@elastic/elasticsearch";
import {JsonRpc} from "eosjs/dist";
import {ConnectionManager} from "../connections/manager.class";
import {ConfigurationModule} from "./config";
import {HyperionModuleLoader} from "./loader";

import {
    debugLog,
    getLastIndexedABI,
    getLastIndexedBlock,
    getLastIndexedBlockByDelta,
    getLastIndexedBlockByDeltaFromRange,
    getLastIndexedBlockFromRange,
    hLog,
    messageAllWorkers,
    waitUntilReady
} from "../helpers/common_functions";

import pm2io from '@pm2/io';
import {GetInfoResult} from "eosjs/dist/eosjs-rpc-interfaces";

import {
    createWriteStream,
    existsSync,
    mkdirSync,
    readFileSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
    WriteStream
} from "fs";

import cluster, {Worker} from "cluster";
import path from "path";
import {io, Socket} from 'socket.io-client';
import {HyperionConfig} from "../interfaces/hyperionConfig";
import {HyperionWorkerDef} from "../interfaces/hyperionWorkerDef";

import {IOConfig} from "@pm2/io/build/main/pmx";
import Gauge from "@pm2/io/build/main/utils/metrics/gauge";
import {queue, QueueObject} from "async";
import {convertLegacyPublicKey} from "eosjs/dist/eosjs-numeric";
import IORedis from "ioredis";
import AlertsManager from "./alertsManager";

import {bootstrap} from 'global-agent';
import {App, TemplatedApp, WebSocket} from "uWebSockets.js";
import moment from "moment";
import Timeout = NodeJS.Timeout;
import {SearchResponse} from "@elastic/elasticsearch/lib/api/types";
import {getTotalValue} from "../api/helpers/functions";

interface RevBlock {
    num: number;
    id: string;
    tx: string[];
}

export class HyperionMaster {

    // global configuration
    conf: HyperionConfig;

    // connection manager
    manager: ConnectionManager;

    // eosjs rpc
    rpc: JsonRpc;

    // live producer schedule
    private currentSchedule: any;

    // elasticsearch client
    private readonly esClient: Client;

    // hyperion module loader
    mLoader: HyperionModuleLoader;

    // Chain/Queue Prefix
    chain: string;

    // Chain API Info
    private chain_data?: GetInfoResult;

    // Main workers
    private workerMap: HyperionWorkerDef[] = [];
    private worker_index = 0;

    // Scaling params
    private max_readers: number;
    private IndexingQueues: any;
    private maxBatchSize: number;
    private dsErrorStream?: WriteStream;

    // mem-optimized deserialization pool
    private dsPoolMap: Map<number, Worker> = new Map();
    private globalUsageMap = {};
    private totalContractHits = 0;

    // producer monitoring
    private lastProducedBlockNum = 0;
    private handoffCounter: number = 0;
    private lastProducer: string | null = null;
    private producedBlocks: object = {};
    private missedRounds: object = {};

    // IPC Messaging
    private totalMessages = 0;

    // Indexer Monitoring
    private lastProcessedBlockNum = 0;
    private allowMoreReaders = true;
    private allowShutdown = false;
    private readonly log_interval = 5000;
    private consumedBlocks = 0;
    private deserializedActions = 0;
    private indexedObjects = 0;
    private deserializedDeltas = 0;
    private liveConsumedBlocks = 0;
    private livePushedBlocks = 0;
    private pushedBlocks = 0;
    private total_read = 0;
    private total_blocks = 0;
    private total_actions = 0;
    private total_deltas = 0;
    private total_abis = 0;
    private consume_rates: number[] = [];
    private total_range = 0;
    private range_completed = false;
    private head = -1;
    private starting_block?: number;
    private idle_count = 0;
    private auto_stop = 0;

    // IPC Messages Handling
    private msgHandlerMap: any;

    private cachedInitABI = null;
    private activeReadersCount = 0;
    private lastAssignedBlock = 0;
    private lastIndexedABI = 0;
    private activeSchedule: any;
    private pendingSchedule: any;
    private proposedSchedule: any;
    private wsRouterWorker?: Worker;
    private liveBlockQueue?: QueueObject<any>;
    private readingPaused = false;

    // private readingLimited = false;

    // Hyperion Hub Socket
    private hub?: Socket;

    // Timers
    private contractMonitoringInterval?: Timeout;
    private queueMonitoringInterval?: Timeout;
    private shutdownTimer?: Timeout;

    private mode_transition = false;

    private readonly cm: ConfigurationModule;
    private alerts: AlertsManager;
    private ioRedisClient: IORedis.Redis;

    // Reversible Blocks
    private revBlockArray: RevBlock[] = [];
    private shutdownStarted = false;

    // pm2 custom metrics/gauges
    private metrics: Record<string, Gauge> = {};
    private shouldCountIPCMessages = false;

    // local websocket server
    private localController?: TemplatedApp;

    private liveReader?: HyperionWorkerDef;
    private repairReader?: HyperionWorkerDef;
    private pendingRepairRanges: {
        start: number,
        end: number,
        size?: number
    }[] = [];
    private connectedController?: WebSocket<any>;
    private lastIrreversibleBlock: number = 0;

    constructor() {
        this.cm = new ConfigurationModule();

        if (!this.cm.config) {
            hLog("Configuration is not present! Exiting now!");
            process.exit(1);
        }

        this.conf = this.cm.config;

        if (this.conf.settings.use_global_agent) {
            bootstrap();
        }

        this.max_readers = this.conf.scaling.readers;
        if (this.conf.indexer.disable_reading) {
            this.max_readers = 1;
        }

        this.maxBatchSize = this.conf.scaling.batch_size;

        this.chain = this.conf.settings.chain;
        this.alerts = new AlertsManager(this.conf.alerts, this.chain);
        this.manager = new ConnectionManager(this.cm);

        this.esClient = this.manager.elasticsearchClient;
        this.rpc = this.manager.nodeosJsonRPC;
        this.ioRedisClient = new IORedis(this.manager.conn.redis);

        this.mLoader = new HyperionModuleLoader(this.cm);

        this.mLoader.init().then(() => {
            this.mLoader.plugins.forEach(value => {
                value.initOnce();
                hLog(`Plugin loaded: ${value.internalPluginName}`);
            })
            this.initHandlerMap();
            this.mLoader.plugins.forEach(value => {
                const pluginHandlerMap = value.initHandlerMap();
                hLog(`Plugin IPC handlers loaded: ${Object.keys(pluginHandlerMap)}`);
                for (const handler in pluginHandlerMap) {
                    if (Object.keys(this.msgHandlerMap).includes(handler)) {
                        hLog(`Handler already mapped, cannot load ${handler} from plugin ${value.internalPluginName}`);
                        return;
                    }
                    this.msgHandlerMap[handler] = pluginHandlerMap[handler];
                }
            })
            this.liveBlockQueue = queue((task, callback) => {
                this.onLiveBlock(task);
                callback();
            }, 1);
        });
    }

    initHandlerMap() {
        this.msgHandlerMap = {
            'skipped_block': (msg: any) => {
                this.consumedBlocks++;
                if (msg.block_num > this.lastProcessedBlockNum) {
                    this.lastProcessedBlockNum = msg.block_num;
                }
            },
            'consumed_block': (msg: any) => {
                if (msg.live === 'false') {
                    this.consumedBlocks++;
                    if (msg.block_num > this.lastProcessedBlockNum) {
                        this.lastProcessedBlockNum = msg.block_num;
                    }
                } else {

                    // LIVE READER
                    this.liveConsumedBlocks++;

                    // cache the last block number for quick api access
                    this.ioRedisClient.set(`${this.chain}:last_idx_block`, `${msg.block_num}@${msg.block_ts}`).catch(console.log);

                    if (this.revBlockArray.length > 0) {
                        if (this.revBlockArray[this.revBlockArray.length - 1].num === msg.block_num) {
                            hLog('WARNING, same block number detected!');
                            hLog(this.revBlockArray[this.revBlockArray.length - 1].num, msg.block_num);
                        }
                    }

                    this.revBlockArray.push({
                        num: msg.block_num,
                        id: msg.block_id,
                        tx: msg.trx_ids
                    });

                    this.lastProducedBlockNum = msg.block_num;

                    if (this.liveBlockQueue && this.conf.settings.bp_monitoring && !this.conf.indexer.abi_scan_mode) {
                        this.liveBlockQueue.push(msg).catch(reason => {
                            hLog('Error handling consumed_block:', reason);
                        });
                        if (this.liveBlockQueue.length() > 1) {
                            hLog("Live Block Queue:", this.liveBlockQueue.length(), 'blocks');
                        }
                    }
                }
            },
            'new_schedule': (msg: any) => {
                this.onScheduleUpdate(msg);
            },
            'init_abi': (msg: any) => {
                if (!this.cachedInitABI) {
                    this.cachedInitABI = msg.data;
                    hLog('received ship abi for distribution');
                    messageAllWorkers(cluster, {
                        event: 'initialize_abi',
                        data: msg.data
                    });
                    this.monitorIndexingQueues();
                    this.startContractMonitoring();
                }
            },
            'router_ready': () => {
                messageAllWorkers(cluster, {
                    event: 'connect_ws'
                });
            },
            'ingestor_block_report': () => {
                // console.log(data);
            },
            'save_abi': (msg: any) => {
                this.total_abis++;
                if (msg.live_mode === 'true') {
                    hLog(`deserializer ${msg.worker_id} received new abi! propagating changes to other workers...`);
                    for (const worker of this.workerMap) {
                        if (worker.worker_role === 'deserializer' && worker.worker_id !== parseInt(msg.worker_id)) {
                            worker.wref?.send({event: 'update_abi', abi: msg.data});
                        }
                    }
                }
            },
            'update_init_block': (msg: any) => {
                if (msg.block_num && this.head) {
                    this.lastAssignedBlock = msg.block_num;
                    this.total_range = this.head - msg.block_num;
                }
            },
            'repair_reader_ready': () => {
                this.sendPendingRepairRanges();
            },
            'kill_worker': (msg: any) => {
                for (let workersKey in cluster.workers) {
                    const w = cluster.workers[workersKey];
                    if (w && w.id === parseInt(msg.id)) {
                        const idx = this.workerMap.findIndex(value => value.worker_id === w.id);
                        this.workerMap.splice(idx, 1);
                        w.kill();
                    }
                }
            },
            'completed': (msg: any) => {
                if (this.repairReader && msg.id === this.repairReader.worker_id?.toString()) {
                    console.log('Repair completed!', msg);
                    this.sendPendingRepairRanges();
                } else {
                    this.activeReadersCount--;
                    if (this.activeReadersCount < this.max_readers && this.lastAssignedBlock < this.head && this.allowMoreReaders) {
                        // Assign next range
                        const start = this.lastAssignedBlock;
                        let end = this.lastAssignedBlock + this.maxBatchSize;
                        // Check if we are not exceeding the head block
                        if (end > this.head) {
                            end = this.head;
                        }
                        this.lastAssignedBlock = end;
                        this.activeReadersCount++;
                        messageAllWorkers(cluster, {
                            event: 'new_range',
                            target: msg.id,
                            data: {
                                first_block: start,
                                last_block: end
                            }
                        });
                    } else {
                        if (this.lastAssignedBlock >= this.head) {
                            hLog(`Parallel readers finished the requested range`);
                            const readers = this.workerMap.filter(value => value.worker_role === 'reader');
                            this.workerMap = this.workerMap.filter(value => value.worker_role !== 'reader');
                            readers.forEach(value => value.wref?.kill());
                        }
                    }
                }
            },
            'add_index': (msg: any) => {
                this.indexedObjects += msg.size;
            },
            'ds_report': (msg: any) => {
                if (msg.actions) {
                    this.deserializedActions += msg.actions;
                }
                if (msg.deltas) {
                    this.deserializedDeltas += msg.deltas;
                }
            },
            'ds_error': (msg: any) => {
                this.dsErrorStream?.write(JSON.stringify(msg.data) + '\n');
            },
            'read_block': (msg: any) => {
                if (!msg.live) {
                    this.pushedBlocks++;
                } else {
                    this.livePushedBlocks++;
                }
            },
            // 'ds_ready': (msg: any) => {
            //     hLog(msg);
            // },
            'contract_usage_report': (msg: any) => {
                if (msg.data) {
                    this.totalContractHits += msg.total_hits;
                    for (const contract in msg.data) {
                        if (msg.data.hasOwnProperty(contract)) {
                            if (this.globalUsageMap[contract]) {
                                this.globalUsageMap[contract][0] += msg.data[contract];
                            } else {
                                this.globalUsageMap[contract] = [msg.data[contract], 0, []];
                            }
                        }
                    }
                }
            },
            'lib_update': (msg: any) => {
                // publish LIB to hub
                if (msg.data) {

                    // save local lib
                    this.lastIrreversibleBlock = msg.data.block_num;

                    this.revBlockArray = this.revBlockArray.filter(item => item.num > msg.data.block_num);
                    if (this.conf.hub && this.hub && this.conf.hub.inform_url) {
                        this.hub.emit('hyp_ev', {e: 'lib', d: msg.data});
                    }
                    // forward LIB to streaming router
                    if (this.conf.features.streaming.enable && this.wsRouterWorker) {
                        debugLog(`Live Reader reported LIB update: ${msg.data.block_num} | ${msg.data.block_id}`);
                        this.wsRouterWorker.send(msg);
                    }
                }
            },
            'included_trx': (msg: any) => {
                if (this.ioRedisClient) {
                    this.ioRedisClient.set(msg.trx_id, JSON.stringify({
                        status: 'executed',
                        b: msg.block_num,
                        s: msg.signatures,
                        a: msg.root_act
                    }), "EX", 3600).catch(console.log);
                }
            },
            'fork_event': async (msg: any) => {
                const forkedBlocks = this.revBlockArray.filter(item => item.num >= msg.data.starting_block && item.id !== msg.data.new_id);
                this.revBlockArray = this.revBlockArray.filter(item => item.num < msg.data.starting_block);
                if (this.ioRedisClient) {
                    for (const block of forkedBlocks) {
                        if (block.tx.length > 0) {
                            for (const trxId of block.tx) {
                                await this.ioRedisClient.set(trxId, JSON.stringify({status: 'forked'}), "EX", 600);
                            }
                        }
                    }
                }
                this.emitAlert('fork', msg);
                if (msg.data && this.conf.features.streaming.enable && this.wsRouterWorker) {
                    msg.data.forkedBlocks = forkedBlocks;
                    this.wsRouterWorker.send(msg);
                }
            }
        };
    }

    printMode() {
        const package_json = JSON.parse(readFileSync('./package.json').toString());
        hLog(`--------- Hyperion Indexer ${package_json.version} ---------`);
        hLog(`Using parser version ${this.conf.settings.parser}`);
        hLog(`Chain: ${this.conf.settings.chain}`);
        if (this.conf.indexer.abi_scan_mode) {
            hLog('\n-------------------\n ABI SCAN MODE \n-------------------');
        } else {
            hLog('\n---------------\n INDEXING MODE \n---------------');
        }
    }

    private async purgeQueues() {
        if (this.conf.indexer.purge_queues) {
            if (this.conf.indexer.disable_reading) {
                hLog('Cannot purge queue with disabled reading! Exiting now!');
                process.exit(1);
            } else {
                await this.manager.purgeQueues();
            }
        }
    }

    private async verifyIngestClients() {
        for (const ingestClient of this.manager.ingestClients) {
            try {
                const ping_response: boolean = await ingestClient.ping();
                if (!ping_response) {
                    hLog('Failed to connect to one of the ingestion nodes. Please verify the connections.json file');
                }
            } catch (e: any) {
                hLog(e.message);
                hLog('Failed to connect to one of the ingestion nodes. Please verify the connections.json file');
                process.exit(1);
            }
        }
    }

    private addStateTables(indicesList, index_queues) {
        const queue_prefix = this.conf.settings.chain;
        const index_queue_prefix = queue_prefix + ':index';
        const table_feats = this.conf.features.tables;

        if (table_feats.proposals) {
            indicesList.push({name: 'tableProposals', type: 'table-proposals'});
            index_queues.push({type: 'table-proposals', name: index_queue_prefix + "_table_proposals"});
        }

        if (table_feats.accounts) {
            indicesList.push({name: 'tableAccounts', type: 'table-accounts'});
            index_queues.push({type: 'table-accounts', name: index_queue_prefix + "_table_accounts"});
        }

        if (table_feats.voters) {
            indicesList.push({name: 'tableVoters', type: 'table-voters'});
            index_queues.push({type: 'table-voters', name: index_queue_prefix + "_table_voters"});
        }

        if (table_feats.delband) {
            indicesList.push({name: 'tableDelband', type: 'table-delband'});
            index_queues.push({type: 'table-delband', name: index_queue_prefix + "_table_delband"});
        }

        // special dynamic table mapper
        // indicesList.push({name: 'dynamicTable', type: 'dynamic-table'});
        index_queues.push({type: 'dynamic-table', name: index_queue_prefix + "_dynamic"});

    }

    private async getCurrentSchedule() {
        try {
            this.currentSchedule = await this.rpc.get_producer_schedule();
            if (!this.currentSchedule) {
                console.error('empty producer schedule, something went wrong!');
                process.exit(1);
            } else {
                if (this.currentSchedule.active) {
                    this.activeSchedule = this.currentSchedule.active;
                }
                if (this.currentSchedule.pending) {
                    this.pendingSchedule = this.currentSchedule.pending;
                }
                if (this.currentSchedule.proposed) {
                    this.proposedSchedule = this.currentSchedule.proposed;
                }
            }
        } catch (e) {
            console.error('failed to connect to api');
            process.exit(1);
        }
    }

    private async applyUpdateScript() {
        const script_status = await this.esClient.putScript({
            id: "updateByBlock",
            script: {
                lang: "painless",
                source: `
                    boolean valid = false;
                    if(ctx._source.block_num != null) {
                      if(params.block_num < ctx._source.block_num) {
                        ctx['op'] = 'none';
                        valid = false;
                      } else {
                        valid = true;
                      } 
                    } else {
                      valid = true;
                    }
                    if(valid == true) {
                      for (entry in params.entrySet()) {
                        if(entry.getValue() != null) {
                          ctx._source[entry.getKey()] = entry.getValue();
                        } else {
                          ctx._source.remove(entry.getKey());
                        }
                      }
                    }
                `
            }
        });
        if (!script_status.acknowledged) {
            hLog('Failed to load script updateByBlock. Aborting!');
            process.exit(1);
        } else {
            hLog('Painless Update Script loaded!');
        }
    }

    // private async addLifecyclePolicies(indexConfig) {
    //     if (indexConfig.ILPs) {
    //         for (const ILP of indexConfig.ILPs) {
    //             try {
    //                 await this.esClient.ilm.getLifecycle({
    //                     policy: ILP.policy
    //                 });
    //             } catch {
    //                 try {
    //                     const ilm_status = await this.esClient.ilm.putLifecycle(ILP);
    //                     if (!ilm_status.acknowledged) {
    //                         hLog(`Failed to create ILM Policy`);
    //                     }
    //                 } catch (e) {
    //                     hLog(`[FATAL] :: Failed to create ILM Policy`);
    //                     hLog(e);
    //                     process.exit(1);
    //                 }
    //             }
    //         }
    //     }
    // }

    private async appendExtraMappings(indexConfig) {
        // Modify mappings
        for (const exM of this.mLoader.extraMappings) {
            if (exM['action']) {
                for (const key in exM['action']) {
                    if (exM['action'][key]) {
                        indexConfig['action']['mappings']['properties'][key] = exM['action'][key];
                        hLog(`Action Mapping added for ${key}`);
                    }
                }
            }
            if (exM['delta']) {
                for (const key in exM['delta']) {
                    if (exM['delta'][key]) {
                        indexConfig['delta']['mappings']['properties'][key] = exM['delta'][key];
                        hLog(`Delta Mapping added for ${key}`);
                    }
                }
            }
        }
    }

    private async updateIndexTemplates(indicesList: { name: string, type: string }[], indexConfig) {
        hLog(`Updating index templates for ${this.conf.settings.chain}...`);
        let updateCounter = 0;
        for (const index of indicesList) {
            try {
                if (indexConfig[index.name]) {
                    const creation_status = await this.esClient['indices'].putTemplate({
                        name: `${this.conf.settings.chain}-${index.type}`,
                        body: indexConfig[index.name]
                    });
                    if (!creation_status || !creation_status.acknowledged) {
                        hLog(`Failed to create template: ${this.conf.settings.chain}-${index}`);
                    } else {
                        updateCounter++;
                        debugLog(`${this.conf.settings.chain}-${index.type} template updated!`);
                    }
                } else {
                    hLog(`${index.name} template not found!`);
                }
            } catch (e: any) {
                hLog(`[FATAL] ${e.message}`);
                if (e.meta) {
                    hLog(e.meta.body);
                }
                process.exit(1);
            }
        }
        hLog(`${updateCounter} index templates updated`);
    }

    // ------ START OF WORKER MANAGEMENT METHODS ------ //

    private async defineBlockRange() {
        // Define block range
        if (this.conf.indexer.start_on !== 0) {
            this.starting_block = this.conf.indexer.start_on;
            // Check last indexed block again
            if (!this.conf.indexer.rewrite) {
                let lastIndexedBlockOnRange;
                if (this.conf.indexer.abi_scan_mode) {
                    hLog(`Last indexed ABI: ${this.lastIndexedABI}`);
                    this.starting_block = this.lastIndexedABI;
                } else {
                    if (this.conf.features.index_deltas) {
                        lastIndexedBlockOnRange = await getLastIndexedBlockByDeltaFromRange(this.esClient, this.chain, this.starting_block, this.head);
                    } else {
                        lastIndexedBlockOnRange = await getLastIndexedBlockFromRange(this.esClient, this.chain, this.starting_block, this.head);
                    }
                    if (lastIndexedBlockOnRange > this.starting_block) {
                        hLog('WARNING! Data present on target range!');
                        hLog('Changing initial block num. Use REWRITE = true to bypass.');
                        this.starting_block = lastIndexedBlockOnRange;
                    }
                }
            }
        } else {
            if (this.conf.indexer.rewrite) {
                hLog(`WARNING! "indexer.rewrite: true" If you want to reindex from a specific block, "indexer.start_on" must be greater than zero!`);
                hLog(`The indexer will start from ${this.starting_block}`);
            }
            // Auto Mode
            if (this.conf.indexer.abi_scan_mode) {
                hLog(`Last indexed ABI: ${this.lastIndexedABI}`);
                this.starting_block = this.lastIndexedABI;
            }
        }
        // print results
        hLog(' |>> First Block: ' + this.starting_block);
        hLog(' >>| Last  Block: ' + this.head);
    }

    private async findRange() {
        // Auto-stop
        if (this.conf.settings.auto_stop) {
            this.auto_stop = this.conf.settings.auto_stop;
        }

        // Find last indexed block
        let lastIndexedBlock;
        if (this.conf.features.index_deltas) {
            lastIndexedBlock = await getLastIndexedBlockByDelta(this.esClient, this.chain);
            hLog(`Last indexed block (deltas): ${lastIndexedBlock}`);
        } else {
            lastIndexedBlock = await getLastIndexedBlock(this.esClient, this.chain);
            hLog(`Last indexed block (blocks): ${lastIndexedBlock}`);
        }

        // Start from the last indexed block
        this.starting_block = 1;

        // Fecth chain lib
        try {
            this.chain_data = await this.rpc.get_info();
        } catch (e: any) {
            hLog('Failed to connect to chain api: ' + e.message);
            process.exit(1);
        }
        this.head = this.chain_data.head_block_num;

        if (lastIndexedBlock > 0) {
            this.starting_block = lastIndexedBlock;
        }

        if (this.conf.indexer.stop_on !== 0) {
            this.head = this.conf.indexer.stop_on;
        }
    }

    private static printWorkerMap(wmp: HyperionWorkerDef[]): void {
        hLog('---------------- PROPOSED WORKER LIST ----------------------');
        for (const w of wmp) {
            const str: string[] = [];
            for (const key in w) {
                if (w.hasOwnProperty(key) && key !== 'worker_id') {
                    switch (key) {
                        case 'worker_role': {
                            str.push(`Role: ${w[key]}`);
                            break;
                        }
                        case 'worker_queue': {
                            str.push(`Queue Name: ${w[key]}`);
                            break;
                        }
                        case 'first_block': {
                            str.push(`First Block: ${w[key]}`);
                            break;
                        }
                        case 'last_block': {
                            str.push(`Last Block: ${w[key]}`);
                            break;
                        }
                        case 'live_mode': {
                            str.push(`Live Mode: ${w[key]}`);
                            break;
                        }
                        case 'type': {
                            str.push(`Index Type: ${w[key]}`);
                            break;
                        }
                        case 'worker_last_processed_block': {
                            str.push(`Last Processed Block: ${w[key]}`);
                            break;
                        }
                        case 'queue': {
                            str.push(`Indexing Queue: ${w[key]}`);
                            break;
                        }
                        case 'distribution': {
                            if (!!w[key]) {
                                str.push(`Dist Map: ${Object.keys(w[key]).length} indices`);
                            } else {
                                str.push(`Dist Map: N/A`);
                            }
                            break;
                        }
                        default: {
                            str.push(`${key}: ${w[key]}`);
                        }
                    }
                }
            }
            hLog(`Worker ID: ${w.worker_id} \t ${str.join(" | ")}`)
        }
        hLog('--------------------------------------------------');
    }

    private async setupReaders() {
        // Setup Readers

        this.lastAssignedBlock = this.starting_block ?? 0;

        this.activeReadersCount = 0;

        // Setup parallel readers unless explicitly disabled
        if (!this.conf.indexer.live_only_mode) {
            // console.log(this.activeReadersCount, this.max_readers, this.lastAssignedBlock, this.head)
            while (this.activeReadersCount < this.max_readers && this.lastAssignedBlock < this.head) {
                const start = this.lastAssignedBlock;
                let end = this.lastAssignedBlock + this.maxBatchSize;
                if (end > this.head) {
                    end = this.head;
                }
                this.lastAssignedBlock += this.maxBatchSize;
                this.addWorker({
                    worker_role: 'reader',
                    first_block: start,
                    last_block: end
                });
                this.activeReadersCount++;
                hLog(`Setting parallel reader [${this.worker_index}] from block ${start} to ${end}`);
            }
        }

        // Setup live workers
        if (this.conf.indexer.live_reader && this.chain_data) {
            const _head = this.chain_data.head_block_num;
            hLog(`Setting live reader at head = ${_head}`);

            // live block reader
            this.liveReader = this.addWorker({
                worker_role: 'continuous_reader',
                worker_last_processed_block: _head,
                ws_router: ''
            });

            // live deserializers
            for (let j = 0; j < this.conf.scaling.ds_threads; j++) {
                this.addWorker({
                    worker_role: 'deserializer',
                    worker_queue: this.chain + ':live_blocks',
                    live_mode: 'true'
                });
            }
        }
    }

    private async setupDeserializers() {
        for (let i = 0; i < this.conf.scaling.ds_queues; i++) {
            for (let j = 0; j < this.conf.scaling.ds_threads; j++) {
                this.addWorker({
                    worker_role: 'deserializer',
                    worker_queue: this.chain + ':blocks' + ":" + (i + 1),
                    live_mode: 'false'
                });
            }
        }
    }

    private async setupIndexers() {
        if (this.conf.indexer.rewrite || this.conf.settings.preview) {
            hLog(`Indexer rewrite enabled (${this.conf.indexer.start_on} - ${this.conf.indexer.stop_on})`);
        }
        let qIdx = 0;
        this.IndexingQueues.forEach((q) => {
            let n = this.conf.scaling.indexing_queues;
            qIdx = 0;
            if (q.type === 'action' || q.type === 'delta') {
                n = this.conf.scaling.ad_idx_queues;
            } else if (q.type === 'dynamic-table') {
                n = this.conf.scaling.dyn_idx_queues;
            } else if (q.type === 'abi') {
                n = 1;
            }
            for (let i = 0; i < n; i++) {
                this.addWorker({
                    worker_role: 'ingestor',
                    queue: q.name + ":" + (qIdx + 1),
                    type: q.type
                });
                qIdx++;
            }
        });
    }

    private async setupStreaming() {
        const _streaming = this.conf.features.streaming;
        if (_streaming.enable) {
            this.addWorker({worker_role: 'router'});
            if (_streaming.deltas) hLog('Delta streaming enabled!');
            if (_streaming.traces) hLog('Action trace streaming enabled!');
            if (!_streaming.deltas && !_streaming.traces) {
                hLog('WARNING! Streaming is enabled without any datatype,' +
                    'please enable STREAM_TRACES and/or STREAM_DELTAS');
            }
        }
    }

    private addWorker(def: HyperionWorkerDef): HyperionWorkerDef {
        this.worker_index++;
        def.worker_id = this.worker_index;
        def.failures = 0;
        this.workerMap.push(def);
        return def;
    }

    private async setupDSPool() {
        for (let i = 0; i < this.conf.scaling.ds_pool_size; i++) {
            this.addWorker({
                worker_role: 'ds_pool_worker',
                local_id: i + 1
            });
        }
    }

    private async setupWorkers() {
        this.lastIndexedABI = await getLastIndexedABI(this.esClient, this.chain);
        await this.defineBlockRange();
        this.total_range = this.head - (this.starting_block ?? 0);
        await this.setupReaders();
        await this.setupDeserializers();
        await this.setupIndexers();
        await this.setupStreaming();
        await this.setupDSPool();
        this.addWorker({worker_role: "delta_updater"});
    }

    private launchWorkers() {
        let launchedCount = 0;
        this.workerMap.forEach((wrk: HyperionWorkerDef) => {
            if (!wrk.wref && wrk.worker_id) {
                wrk.wref = cluster.fork(wrk);
                wrk.wref.id = wrk.worker_id;
                wrk.wref.on('message', (msg) => {
                    this.handleMessage(msg);
                });

                if (wrk.worker_role === 'ds_pool_worker' && wrk.local_id) {
                    this.dsPoolMap.set(wrk.local_id, wrk.wref);
                }

                if (wrk.worker_role === 'router') {
                    this.wsRouterWorker = wrk.wref;
                }

                launchedCount++;
            }
        });
        hLog(`${launchedCount} workers launched`);
    }

    private updateWorkerAssignments() {
        const pool_size = this.conf.scaling.ds_pool_size;
        const worker_max_pct = 1 / pool_size;

        const worker_shares = {};
        for (let i = 0; i < pool_size; i++) {
            worker_shares[i] = 0.0;
        }

        const worker_counters = {};
        for (let i = 0; i < pool_size; i++) {
            worker_counters[i] = 0;
        }

        const propWorkerMap = {};

        // phase 1 - calculate usage
        for (const code in this.globalUsageMap) {
            const _pct = this.globalUsageMap[code][0] / this.totalContractHits;
            let used_pct = 0;
            const proposedWorkers: number[] = [];
            for (let i = 0; i < pool_size; i++) {
                if (worker_shares[i] < worker_max_pct) {
                    const rem_pct = (_pct - used_pct);
                    if (rem_pct === 0) {
                        break;
                    }
                    if (rem_pct > worker_max_pct) {
                        used_pct += (worker_max_pct - worker_shares[i]);
                        worker_shares[i] = worker_max_pct;
                    } else {
                        if (worker_shares[i] + rem_pct > worker_max_pct) {
                            used_pct += (worker_max_pct - worker_shares[i]);
                            worker_shares[i] = worker_max_pct;
                        } else {
                            used_pct += rem_pct;
                            worker_shares[i] += rem_pct;
                        }
                    }
                    proposedWorkers.push(i);
                    worker_counters[i]++;
                }
            }
            propWorkerMap[code] = proposedWorkers;
            this.globalUsageMap[code][1] = _pct;
        }

        // phase 2 - re-balance
        const totalContracts = Object.keys(this.globalUsageMap).length;
        const desiredCodeCount = totalContracts / pool_size;
        const ignoreList: number[] = [];
        for (let i = 0; i < pool_size; i++) {
            if (worker_counters[i] > desiredCodeCount * 1.1) {
                ignoreList.push(i);
            }
        }

        for (const code in propWorkerMap) {
            if (propWorkerMap[code].length === 1) {
                const oldVal = propWorkerMap[code][0];
                if (ignoreList.includes(oldVal)) {
                    for (let i = 0; i < pool_size; i++) {
                        if (worker_counters[i] < desiredCodeCount) {
                            propWorkerMap[code] = [i];
                            worker_counters[i]++;
                            worker_counters[oldVal]--;
                            break;
                        }
                    }
                }
            }
        }


        // phase 3 - assign
        for (const code in this.globalUsageMap) {
            if (JSON.stringify(this.globalUsageMap[code][2]) !== JSON.stringify(propWorkerMap[code])) {
                // hLog(this.globalUsageMap[code][2], ">>", proposedWorkers);
                propWorkerMap[code].forEach(w => {
                    const idx = this.globalUsageMap[code][2].indexOf(w);
                    if (idx !== -1) {
                        this.globalUsageMap[code][2].splice(idx, 1);
                    } else {
                        // hLog(`Worker ${w} assigned to ${code}`);
                    }
                });
                this.globalUsageMap[code][2].forEach(w_id => {
                    // hLog(`>>>> Worker ${this.globalUsageMap[code][2]} removed from ${code}!`);
                    if (this.dsPoolMap.has(w_id)) {
                        this.dsPoolMap.get(w_id)?.send({
                            event: "remove_contract",
                            contract: code
                        });
                    }
                });
                this.globalUsageMap[code][2] = propWorkerMap[code];
            }
        }
    }

    private sendToRole(role: string, payload: any) {
        this.workerMap
            .filter(value => value.worker_role === role)
            .forEach(value => {
                value.wref?.send(payload);
            });
    }

    private async waitForLaunch(): Promise<void> {
        return new Promise(resolve => {
            hLog(`Use "pm2 trigger ${pm2io.getConfig()['module_name']} start" to start the indexer now or restart without preview mode.`);
            const idleTimeout = setTimeout(() => {
                hLog('No command received after 10 minutes.');
                hLog('Exiting now! Disable the PREVIEW mode to continue.');
                process.exit(1);
            }, 60000 * 10);
            pm2io.action('start', (reply) => {
                resolve();
                reply({ack: true});
                clearTimeout(idleTimeout);
            });
        });
    }

    // ------ END OF WORKER MANAGEMENT METHODS ------ //

    setupDeserializationErrorLogger() {
        const logPath = path.join(path.resolve(), 'logs', this.chain);
        if (!existsSync(logPath)) mkdirSync(logPath, {recursive: true});
        const dsLogFileName = (new Date().toISOString()) + "_ds_err_" + this.starting_block + "_" + this.head + ".log";
        const dsErrorsLog = logPath + '/' + dsLogFileName;
        if (existsSync(dsErrorsLog)) unlinkSync(dsErrorsLog);
        const symbolicLink = logPath + '/deserialization_errors.log';
        if (existsSync(symbolicLink)) unlinkSync(symbolicLink);
        symlinkSync(dsLogFileName, symbolicLink);
        this.dsErrorStream = createWriteStream(dsErrorsLog, {flags: 'a'});
        hLog(`📣️  Deserialization errors are being logged in:\n[${symbolicLink}]`);
        this.dsErrorStream.write(`begin ${this.chain} error logs\n`);
    }

    onLiveBlock(msg) {
        if (this.proposedSchedule && this.proposedSchedule.version) {
            if (msg.schedule_version >= this.proposedSchedule.version) {
                hLog(`Active producers changed!`);
                this.printActiveProds();
                this.activeSchedule = this.proposedSchedule;
                this.printActiveProds();
                this.proposedSchedule = null;
                this.producedBlocks = {};
            }
        }
        if ((msg.block_num === this.lastProducedBlockNum + 1) || this.lastProducedBlockNum === 0) {
            const prod = msg.producer;
            if (this.producedBlocks[prod]) {
                this.producedBlocks[prod]++;
            } else {
                this.producedBlocks[prod] = 1;
            }
            if (this.lastProducer !== prod) {
                this.handoffCounter++;
                if (this.lastProducer && this.handoffCounter > 2) {
                    const activeProds = this.activeSchedule.producers;
                    const newIdx = activeProds.findIndex(p => p['producer_name'] === prod) + 1;
                    const oldIdx = activeProds.findIndex(p => p['producer_name'] === this.lastProducer) + 1;
                    if ((newIdx === oldIdx + 1) || (newIdx === 1 && oldIdx === activeProds.length)) {
                        if (this.conf.settings.bp_logs) {
                            hLog(`[${msg.block_num}] producer handoff: ${this.lastProducer} [${oldIdx}] -> ${prod} [${newIdx}]`);
                        }
                    } else {
                        let cIdx = oldIdx + 1;
                        while (cIdx !== newIdx) {
                            try {
                                if (activeProds[cIdx - 1]) {
                                    const missingProd = activeProds[cIdx - 1]['producer_name'];
                                    this.reportMissedBlocks(missingProd, this.lastProducedBlockNum, 12);
                                    if (this.missedRounds[missingProd]) {
                                        this.missedRounds[missingProd]++;
                                    } else {
                                        this.missedRounds[missingProd] = 1;
                                    }
                                    hLog(`${missingProd} missed a round [${this.missedRounds[missingProd]}]`);
                                }
                            } catch (e) {
                                hLog(activeProds);
                                hLog(e);
                            }
                            cIdx++;
                            if (cIdx === activeProds.length) {
                                cIdx = 0;
                            }
                        }
                    }
                    if (this.producedBlocks[this.lastProducer]) {
                        if (this.producedBlocks[this.lastProducer] < 12) {
                            const _size = 12 - this.producedBlocks[this.lastProducer];
                            this.reportMissedBlocks(this.lastProducer, this.lastProducedBlockNum, _size);
                        }
                    }
                    this.producedBlocks[this.lastProducer] = 0;
                }
                this.lastProducer = prod;
            }
            if (this.conf.settings.bp_logs) {
                if (this.proposedSchedule) {
                    hLog(`received block ${msg.block_num} from ${prod} [${this.activeSchedule.version} >> ${this.proposedSchedule.version}]`);
                } else {
                    hLog(`received block ${msg.block_num} from ${prod} [${this.activeSchedule.version}]`);
                }
            }
        }
        this.lastProducedBlockNum = msg.block_num;
    }

    handleMessage(msg) {
        if (this.shouldCountIPCMessages) {
            this.totalMessages++;
        }

        if (this.msgHandlerMap[msg.event]) {
            this.msgHandlerMap[msg.event](msg);
        }
    }

    private reportMissedBlocks(missingProd: any, lastProducedBlockNum: number, size: number) {
        hLog(`${missingProd} missed ${size} ${size === 1 ? "block" : "blocks"} after ${lastProducedBlockNum}`);
        const _body = {
            type: 'missed_blocks',
            '@timestamp': new Date().toISOString(),
            'missed_blocks': {
                'producer': missingProd,
                'last_block': lastProducedBlockNum,
                'size': size,
                'schedule_version': this.activeSchedule.version
            }
        };
        this.esClient.index({
            index: this.chain + '-logs-' + this.conf.settings.index_version,
            body: _body
        }).catch(hLog);
    }

    // ------- START OF MONITORING AND CONTROL METHODS -------- //

    private startContractMonitoring() {
        if (!this.contractMonitoringInterval) {
            // Monitor Global Contract Usage
            this.contractMonitoringInterval = setInterval(() => {

                // const t0 = process.hrtime.bigint();
                this.updateWorkerAssignments();
                // const t1 = process.hrtime.bigint();

                // hLog('----------- Usage Report ----------');
                // hLog(`Total Hits: ${this.totalContractHits}`);
                // hLog(`Update time: ${parseInt((t1 - t0).toString()) / 1000000} ms`);
                // hLog(this.globalUsageMap);
                // hLog('-----------------------------------');

                // update on deserializers
                for (const w of this.workerMap) {
                    if (w.worker_role === 'deserializer') {
                        if (w.wref && w.wref.isConnected()) {
                            w.wref.send({
                                event: 'update_pool_map',
                                data: this.globalUsageMap
                            });
                        }
                    }
                }

                // clearUsageMap();
            }, 5000);
        }
    }

    private pauseReaders() {
        if (!this.readingPaused) {
            this.sendToRole('reader', {event: 'pause'});
            this.readingPaused = true;
        }
    }

    private resumeReaders() {
        if (this.readingPaused) {
            this.sendToRole('reader', {event: 'resume'});
            this.readingPaused = false;
        }
    }

    private async checkQueues(autoscaleConsumers, limit) {
        const testedQueues = new Set();
        let aboveLimit = false;
        let canResume = true;
        let queuedMessages = 0;
        for (const worker of this.workerMap) {
            let queue = worker.queue;
            if (!queue) {
                queue = worker.worker_queue;
            }

            if (worker.worker_role === 'ds_pool_worker') {
                queue = `${this.chain}:ds_pool:${worker.local_id}`;
            }

            if (queue && !testedQueues.has(queue)) {

                const size = await this.manager.checkQueueSize(queue);
                queuedMessages += size;
                let qlimit = this.conf.scaling.max_queue_limit;
                if (worker.worker_role === 'deserializer') {
                    qlimit = this.conf.scaling.block_queue_limit;
                }

                // if (size / qlimit > 0.5) {
                // 	hLog(queue, size, ((size / qlimit) * 100).toFixed(2) + "%");
                // }

                // pause readers if queues are above the max_limit
                if (size >= qlimit) {
                    aboveLimit = true;
                }

                // check if any queue is above resume point
                if (size >= this.conf.scaling.resume_trigger) {
                    canResume = false;
                }

                // check indexing queues
                if (worker.worker_role === 'ingestor') {
                    if (size > limit) {
                        if (!autoscaleConsumers[queue]) {
                            autoscaleConsumers[queue] = 0;
                        }
                        if (autoscaleConsumers[queue] < this.conf.scaling.max_autoscale) {
                            hLog(`${queue} is above the limit (${size}/${limit}). Launching consumer...`);
                            this.addWorker({queue: queue, type: worker.type, worker_role: 'ingestor'});
                            this.launchWorkers();
                            autoscaleConsumers[queue]++;
                        }
                    }
                }

                // // resume readers if the queues are below the trigger point
                // if (size <= this.conf.scaling.resume_trigger) {
                //
                // 	// remove flow limiter
                // 	if (this.readingLimited) {
                // 		this.readingLimited = false;
                // 		hLog('removing flow limiters');
                // 		for (const worker of this.workerMap) {
                // 			if (worker.worker_role === 'reader') {
                // 				worker.wref.send({event: 'set_delay', data: {state: false, delay: 0}});
                // 			}
                // 		}
                // 	}
                //
                // 	// fully unpause
                // 	if (this.readingPaused) {
                // 		canResume = true;
                // 		this.readingPaused = false;
                // 		hLog('resuming readers');
                // 		for (const worker of this.workerMap) {
                // 			if (worker.worker_role === 'reader') {
                // 				worker.wref.send({event: 'pause'});
                // 			}
                // 		}
                // 	}
                // }
                //
                // // apply block processing delay on 80% usage
                // if (size >= this.conf.scaling.max_queue_limit * 0.8) {
                // 	this.readingLimited = true;
                // 	hLog('applying flow limiters');
                // 	for (const worker of this.workerMap) {
                // 		if (worker.worker_role === 'reader') {
                // 			worker.wref.send({event: 'set_delay', data: {state: true, delay: 250}});
                // 		}
                // 	}
                // }

                testedQueues.add(queue);
            }
        }
        if (aboveLimit) {
            this.pauseReaders();
        } else {
            if (canResume) {
                this.resumeReaders();
            }
        }
        this.metrics.queuedMessages?.set(queuedMessages);
    }

    private monitorIndexingQueues() {
        if (!this.queueMonitoringInterval) {
            const limit = this.conf.scaling.auto_scale_trigger;
            const autoscaleConsumers = {};
            setTimeout(() => {
                this.checkQueues(autoscaleConsumers, limit).catch(console.log);
            }, 3000);
            if (!this.conf.scaling.polling_interval) {
                this.conf.scaling.polling_interval = 20000;
            }
            this.queueMonitoringInterval = setInterval(async () => {
                await this.checkQueues(autoscaleConsumers, limit);
            }, this.conf.scaling.polling_interval);
        }
    }

    private startIndexMonitoring() {
        let reference_time = Date.now();

        setInterval(() => {

            let _workers = 0;
            if (cluster.workers) {
                _workers = Object.keys(cluster.workers).length;
            }

            const tScale = (this.log_interval / 1000);
            this.total_read += this.pushedBlocks;
            this.total_blocks += this.consumedBlocks;
            this.total_actions += this.deserializedActions;
            this.total_deltas += this.deserializedDeltas;
            const consume_rate = this.consumedBlocks / tScale;
            this.consume_rates.push(consume_rate);
            if (this.consume_rates.length > 20) {
                this.consume_rates.splice(0, 1);
            }
            let avg_consume_rate = 0;
            if (this.consume_rates.length > 0) {
                for (const r of this.consume_rates) {
                    avg_consume_rate += r;
                }
                avg_consume_rate = avg_consume_rate / this.consume_rates.length;
            } else {
                avg_consume_rate = consume_rate;
            }
            const log_msg: string[] = [];

            // print current head for live reading
            if (this.lastProducedBlockNum > 0 && this.lastIrreversibleBlock > 0) {
                log_msg.push(`H:${this.lastProducedBlockNum} L:${this.lastIrreversibleBlock}`);
            }

            log_msg.push(`W:${_workers}`);

            const _r = (this.pushedBlocks + this.livePushedBlocks) / tScale;
            log_msg.push(`R:${_r}`);
            this.metrics.readingRate?.set(_r);

            const _c = (this.liveConsumedBlocks + this.consumedBlocks) / tScale;
            log_msg.push(`C:${_c}`);
            this.metrics.consumeRate?.set(_c);

            const _a = (this.deserializedActions) / tScale;
            log_msg.push(`A:${_a}`);
            this.metrics.actionDSRate?.set(_a);

            const _dds = (this.deserializedDeltas) / tScale
            log_msg.push(`D:${_dds}`);
            this.metrics.deltaDSRate?.set(_dds);

            const _ir = (this.indexedObjects) / tScale
            log_msg.push(`I:${_ir}`);
            this.metrics.indexingRate?.set(_ir);

            if (this.total_blocks < this.total_range && !this.conf.indexer.live_only_mode) {
                let time_string = 'waiting for indexer';
                if (avg_consume_rate > 0) {
                    const remaining = this.total_range - this.total_blocks;
                    const estimated_time = Math.round(remaining / avg_consume_rate);
                    time_string = moment().add(estimated_time, 'seconds').fromNow(false);
                }
                const pct_parsed = ((this.total_blocks / this.total_range) * 100).toFixed(1);
                const pct_read = ((this.total_read / this.total_range) * 100).toFixed(1);
                log_msg.push(`${this.total_blocks}/${this.total_read}/${this.total_range}`);
                log_msg.push(`syncs ${time_string} (${pct_parsed}% ${pct_read}%)`);
                this.metrics.syncEta.set(time_string);
            }

            // publish last processed block to pm2
            this.metrics.lastProcessedBlockNum.set(this.lastProcessedBlockNum);

            // publish log to hub
            if (this.conf.hub && this.conf.hub.inform_url && this.hub) {
                this.hub.emit('hyp_ev', {
                    e: 'rates',
                    d: {r: _r, c: _c, a: _a}
                });
            }

            // print monitoring log
            if (this.conf.settings.rate_monitoring && !this.mode_transition) {
                hLog(log_msg.join(' | '));
            }

            if (this.liveConsumedBlocks > 0 && this.consumedBlocks === 0 && this.conf.indexer.abi_scan_mode) {
                hLog('Warning: Live reading on ABI SCAN mode')
            }

            if (this.liveConsumedBlocks + this.indexedObjects + this.deserializedActions + this.consumedBlocks === 0 && !this.mode_transition) {

                // Report completed range (parallel reading)
                if (this.total_blocks === this.total_range && !this.range_completed) {
                    const ttime = (Date.now() - reference_time) / 1000;
                    hLog(`\n
        -------- BLOCK RANGE COMPLETED -------------
        | Range: ${this.starting_block} >> ${this.head}
        | Total time: ${ttime} seconds
        | Blocks: ${this.total_range}
        | Actions: ${this.total_actions}
        | Deltas: ${this.total_deltas}
        | ABIs: ${this.total_abis}
        --------------------------------------------\n`);
                    this.range_completed = true;
                    if (this.conf.indexer.abi_scan_mode) {
                        if (this.conf.settings.auto_mode_switch) {
                            this.mode_transition = true;
                            hLog('Auto switching to full indexing mode in 10 seconds...');
                            setTimeout(() => {
                                reference_time = Date.now();
                                this.startFullIndexing().catch(console.log);
                            });
                        }
                    }
                }
                if (!this.mode_transition) {

                    // Allow 10s threshold before shutting down the process
                    this.shutdownTimer = setTimeout(() => {
                        this.allowShutdown = true;
                    }, 10000);

                    // Auto-Stop
                    if (this.pushedBlocks === 0) {
                        this.idle_count++;
                        if (this.auto_stop > 0) {
                            if ((tScale * this.idle_count) >= this.auto_stop) {
                                hLog("Reached limit for no blocks processed, stopping now...");
                                process.exit(1);
                            } else {
                                const idleMsg = `No blocks processed! Indexer will stop in ${this.auto_stop - (tScale * this.idle_count)} seconds!`;
                                if (this.idle_count === 1) {
                                    this.emitAlert('warning', idleMsg);
                                }
                                hLog(idleMsg);
                            }
                        } else {
                            if (!this.shutdownStarted) {
                                const readers = this.workerMap.filter(value => {
                                    return value.worker_role === 'reader' || value.worker_role === 'continuous_reader';
                                });
                                if (readers.length === 0) {
                                    hLog(`No more active workers, stopping now...`);
                                    process.exit();
                                }
                                const idleMsg = 'No blocks are being processed, please check your state-history node!';
                                if (this.idle_count === 2) {
                                    this.emitAlert('warning', idleMsg);
                                }
                                hLog(idleMsg);
                            }
                        }
                    }

                }
            } else {
                if (this.idle_count > 1) {
                    this.emitAlert('info', '✅ Data processing resumed!');
                    hLog('Processing resumed!');
                }
                this.idle_count = 0;
                if (this.shutdownTimer) {
                    clearTimeout(this.shutdownTimer);
                    this.shutdownTimer = undefined;
                }
            }

            // reset counters
            this.resetMonitoringCounters();


            if (_workers === 0 && !this.mode_transition) {
                hLog('FATAL ERROR - All Workers have stopped!');
                process.exit(1);
            }

        }, this.log_interval);
    }

    resetMonitoringCounters() {
        this.pushedBlocks = 0;
        this.livePushedBlocks = 0;
        this.consumedBlocks = 0;
        this.liveConsumedBlocks = 0;
        this.deserializedActions = 0;
        this.deserializedDeltas = 0;
        this.indexedObjects = 0;
    }

    // ------ END OF MONITORING AND CONTROL METHODS ------ //

    private onScheduleUpdate(msg: any) {
        if (msg.live === 'true') {
            hLog(`Producer schedule updated at block ${msg.block_num}. Waiting version update...`);
            this.proposedSchedule = msg.new_producers;
        }
    }

    printActiveProds() {
        if (this.activeSchedule && this.activeSchedule.producers) {
            const arr = this.activeSchedule.producers.map((p, i) => {
                const pos = (i < 9 ? "0" + (i + 1) : i + 1);
                return "│ " + pos + " " + p.producer_name + "\t│";
            });
            const div = '──────────────────';
            console.log(`\n ⛏  Active Producers\n┌${div}┐\n${arr.join('\n')}\n└${div}┘`);
        }
    }

    // ------- START OF HYPERION HUB METHODS -------

    private emitHubUpdate() {
        this.hub?.emit('hyp_info', {
            type: 'indexer',
            production: this.conf.hub.production,
            location: this.conf.hub.location,
            chainId: this.chain_data?.chain_id,
            chainLogo: this.conf.api.chain_logo_url,
            providerName: this.conf.api.provider_name,
            providerUrl: this.conf.api.provider_url,
            providerLogo: this.conf.api.provider_logo,
            explorerEnabled: this.conf.plugins.explorer?.enabled,
            chainCodename: this.chain,
            chainName: this.conf.api.chain_name,
            endpoint: this.conf.api.server_name,
            features: this.conf.features,
            filters: {
                blacklists: this.conf.blacklists,
                whitelists: this.conf.whitelists
            }
        });
    }

    startHyperionHub() {
        if (this.conf.hub) {
            const url = this.conf.hub.inform_url;
            hLog(`Connecting to Hyperion Hub...`);
            this.hub = io(url, {
                query: {
                    key: this.conf.hub.publisher_key,
                    client_mode: 'false'
                }
            });
            this.hub.on('connect', () => {
                hLog(`Hyperion Hub connected!`);
                this.emitHubUpdate();
            });
            // this.hub.on('reconnect', () => {
            //     this.emitHubUpdate();
            // });
        }
    }

    // ------- END OF HYPERION HUB METHODS -------

    // --------- START OF REPAIR METHODS ------------

    async fillMissingBlocks(data: any, ws: WebSocket<any>) {
        this.pendingRepairRanges = data.filter((range: any) => {
            return range.end - range.start >= 0;
        });
        this.pendingRepairRanges.reverse();
        let totalBlocks = 0;
        this.pendingRepairRanges.forEach(value => {
            value["size"] = value.end - value.start + 1;
            totalBlocks += value.size;
        });
        hLog(`Filling ${totalBlocks} missing blocks...`);
        this.repairReader = this.addWorker({
            worker_role: 'repair_reader'
        });
        this.launchWorkers();
        this.connectedController = ws;
    }

    private createLocalController(controlPort: number) {
        this.localController = App().ws('/local', {
            open: () => {
                hLog(`Local controller connected!`);
            },
            message: (ws, msg) => {
                const buffer = Buffer.from(msg);
                const message = JSON.parse(buffer.toString());
                if (message.event === 'fill_missing_blocks') {
                    this.fillMissingBlocks(message.data, ws).catch(console.log);
                }
            },
            close: () => {
                hLog(`Local controller disconnected!`);
            }
        });
        this.localController.listen(controlPort, (token) => {
            if (token) {
                hLog(`Local controller listening on port ${controlPort}`);
            }
        });
    }

    private sendPendingRepairRanges() {
        if (this.pendingRepairRanges.length > 0) {
            const nextRange = this.pendingRepairRanges.shift();
            console.log('NEXT RANGE FOR REPAIR: ', nextRange);
            if (this.repairReader && this.repairReader.wref && this.repairReader.worker_id && nextRange) {
                this.repairReader.wref.send({
                    event: 'new_range',
                    target: this.repairReader.worker_id.toString(),
                    data: {
                        first_block: nextRange.start,
                        last_block: nextRange.end + 1
                    }
                });
            }
        } else {
            console.log('Repair completed!');
            this.connectedController?.send(JSON.stringify({
                event: 'repair_completed'
            }));
        }
    }

    // --------- END OF REPAIR FUNCTIONS ------------

    // Main start function

    async runMaster() {

        // config checks
        if (!this.conf.scaling.max_queue_limit) {
            hLog(`scaling.max_queue_limit is not defined!`);
            process.exit(1);
        }

        if (!this.conf.scaling.resume_trigger) {
            hLog(`scaling.resume_trigger is not defined!`);
            process.exit(1);
        }

        if (!this.conf.scaling.block_queue_limit) {
            hLog(`scaling.block_queue_limit is not defined!`);
            process.exit(1);
        }

        if (!this.conf.settings.index_partition_size) {
            hLog(`[FATAL ERROR] settings.index_partition_size is not defined!`);
            process.exit(1);
        }

        this.printMode();
        let controlPort = this.manager.conn.chains[this.conf.settings.chain].control_port;
        if (!controlPort) {
            controlPort = 7002;
            hLog(`control_port not defined in connections.json, using default: ${controlPort}`);
        }
        this.createLocalController(controlPort);

        // Preview mode - prints only the proposed worker map
        let preview = this.conf.settings.preview;

        await this.purgeQueues();

        // Chain API
        if (this.conf.settings.bp_monitoring) {
            await this.getCurrentSchedule();
            this.printActiveProds();
        }

        // Redis


        // Wait for Redis availability
        await waitUntilReady(async () => {
            try {
                await this.ioRedisClient.ping();
                return true;
            } catch (e) {
                return false;
            }
        }, 10, 5000, () => {
            hLog(`Redis not available, exiting...`);
            process.exit();
        });

        // Remove first indexed block from cache (v2/health)
        await this.ioRedisClient.del(`${this.manager.chain}::fib`);

        // Wait for Nodeos Chain API availability
        await waitUntilReady(async () => {
            try {
                const info = await this.rpc.get_info();
                if (info.server_version_string) {
                    hLog(`Nodeos version: ${info.server_version_string}`);
                    return true;
                } else {
                    return false;
                }
            } catch (e: any) {
                hLog(`Chain API Error: ${e.message}`);
                return false;
            }
        }, 10, 5000, () => {
            hLog(`Chain API not available, exiting...`);
            process.exit();
        });

        // Wait for Elasticsearch availability
        await waitUntilReady(async () => {
            try {
                const esInfo = await this.esClient.info();
                hLog(`Elasticsearch: ${esInfo.version.number} | Lucene: ${esInfo.version.lucene_version}`);
                this.emitAlert('info', `Indexer started using ES v${esInfo.version.number}`);
                return true;
            } catch (e: any) {
                console.log(e.message);
                return false;
            }
        }, 10, 5000, () => {
            hLog('Failed to check elasticsearch version!');
            process.exit();
        });

        await this.verifyIngestClients();

        const prefix = this.chain + ':index';
        this.IndexingQueues = [
            {
                type: 'action',
                name: prefix + "_actions"
            },
            {
                type: 'block',
                name: prefix + "_blocks"
            },
            {
                type: 'delta',
                name: prefix + "_deltas"
            },
            {
                type: 'abi',
                name: prefix + "_abis"
            },
            {
                type: 'generic',
                name: prefix + "_generic"
            }
        ];

        const indexConfig: any = await import('../definitions/index-templates');

        const indicesList = [
            {name: "action", type: "action"},
            {name: "block", type: "block"},
            {name: "abi", type: "abi"},
            {name: "delta", type: "delta"},
            {name: "logs", type: "logs"},
            {name: 'permissionLink', type: 'link'},
            {name: 'permission', type: 'perm'},
            {name: 'resourceLimits', type: 'reslimits'},
            {name: 'resourceUsage', type: 'userres'},
            {name: 'generatedTransaction', type: 'gentrx'},
            {name: 'failedTransaction', type: 'trxerr'},
            {name: 'schedule', type: 'schedule'}
        ];

        this.addStateTables(indicesList, this.IndexingQueues);
        await this.applyUpdateScript();

        // await this.addLifecyclePolicies(indexConfig);

        await this.appendExtraMappings(indexConfig);
        await this.updateIndexTemplates(indicesList, indexConfig);

        // await this.createIndices(indicesList);

        if (this.conf.indexer.fill_state) {
            await this.fillCurrentStateTables();
        }

        await this.findRange();

        this.emitAlert(
            'info',
            `Range defined from ${this.starting_block} to ${this.head}` +
            (this.conf.indexer.live_reader ? ' with ' : ' without ') +
            'live reading active');

        await this.setupWorkers();

        // Quit App if on preview mode
        if (preview) {
            HyperionMaster.printWorkerMap(this.workerMap);
            await this.waitForLaunch();
        }

        // Setup Error Logging
        this.setupDeserializationErrorLogger();

        // Start Monitoring
        this.startIndexMonitoring();

        // handle worker disconnection events
        cluster.on('disconnect', (worker) => {
            if (!this.mode_transition && !this.shutdownStarted) {
                const workerReference = this.workerMap.find(value => value.worker_id === worker.id);
                if (workerReference) {
                    hLog(`The worker #${worker.id} has disconnected, attempting to re-launch in 5 seconds...`);
                    workerReference.wref = undefined;
                    if (!workerReference.failures) {
                        workerReference.failures = 0;
                    }
                    workerReference.failures++;
                    hLog(`New worker defined: ${workerReference.worker_role} for ${workerReference.worker_queue}`);
                    setTimeout(() => {
                        this.launchWorkers();
                        setTimeout(() => {
                            if (workerReference.worker_role === 'deserializer' && workerReference.wref) {
                                workerReference.wref.send({
                                    event: 'initialize_abi',
                                    data: this.cachedInitABI
                                });
                            }
                        }, 1000);
                    }, 5000);
                } else {
                    hLog(`The worker #${worker.id} has disconnected`);
                }
            }
        });

        // Launch all workers
        this.launchWorkers();

        // enable ipc msg rate monitoring
        let ipcDebugRate = this.conf.settings.ipc_debug_rate;
        if (ipcDebugRate && ipcDebugRate > 0 && ipcDebugRate < 1000) {
            hLog(`settings.ipc_debug_rate was set too low (${this.conf.settings.ipc_debug_rate}) using 1000 instead!`);
            ipcDebugRate = 1000;
        }
        this.shouldCountIPCMessages = (ipcDebugRate && ipcDebugRate >= 1000) as boolean;
        if (this.conf.settings.debug) {
            if (this.shouldCountIPCMessages) {
                const rate = ipcDebugRate ?? 10000;
                this.totalMessages = 0;
                setInterval(() => {
                    hLog(`IPC Messaging Rate: ${(this.totalMessages / (rate / 1000)).toFixed(2)} msg/s`);
                    this.totalMessages = 0;
                }, ipcDebugRate);
            }
        }

        // load hyperion hub connection
        if (this.conf.hub) {
            try {
                this.startHyperionHub();
            } catch (e) {
                hLog(e);
            }
        }

        // Actions that can be triggered via pm2 trigger <action> <process> or on the pm2 dashboard
        this.addPm2Actions();

        // Add custom metrics
        this.addPm2Metrics();
    }

    async streamBlockHeaders(
        start_on: number,
        stop_on: number,
        func: (data: any) => void
    ) {
        const responseQueue: SearchResponse<any, any>[] = [];
        const init_response = await this.esClient.search<any>({
            index: this.chain + '-block-*',
            scroll: '30s',
            size: 1000,
            track_total_hits: true,
            query: {
                bool: {
                    must: [
                        {
                            range: {
                                block_num: {
                                    gte: start_on,
                                    lte: stop_on
                                }
                            }
                        }
                    ]
                }
            },
            sort: [{block_num: {order: "asc"}}],
            _source: {
                includes: [
                    "block_num",
                    "block_id",
                    "prev_id"
                ]
            },
        });
        const totalHits = getTotalValue(init_response);
        hLog(`Total hits in range: ${totalHits}`);
        responseQueue.push(init_response);
        while (responseQueue.length) {
            const response = responseQueue.shift();
            if (response) {
                for (const hit of response.hits.hits) {
                    func(hit._source);
                }

                const next_response = await this.esClient.scroll({
                    scroll_id: response._scroll_id,
                    scroll: '30s'
                });

                if (next_response.hits.hits.length > 0) {
                    responseQueue.push(next_response);
                }
            }
        }
    }

    async processAccount(accountName: string) {
        const acc = await this.manager.nodeosJsonRPC.get_account(accountName);

        // table-accounts
        if (acc.core_liquid_balance) {
            const arr = acc.core_liquid_balance.split(' ');
            const payload = {
                block_num: acc.head_block_num,
                symbol: arr[1],
                amount: parseFloat(arr[0]),
                code: this.conf.settings.eosio_alias + '.token',
                scope: accountName,
                present: 2
            };
            try {
                await this.manager.elasticsearchClient.index({
                    index: this.chain + '-table-accounts',
                    id: `${payload.code}-${payload.scope}-${payload.symbol}`,
                    document: payload,
                });
                // console.log(`${payload.scope}: ${payload.amount} ${payload.symbol}`);
            } catch (e) {
                console.log(`Failed to index account: ${payload.code}-${payload.scope}-${payload.symbol}`);
                console.log(e);
            }
        }

        // table-voters
        if (acc.voter_info) {
            const payload = {
                block_num: acc.head_block_num,
                last_vote_weight: parseFloat(acc.voter_info.last_vote_weight),
                proxied_vote_weight: parseFloat(acc.voter_info.proxied_vote_weight),
                staked: parseFloat(acc.voter_info.staked),
                voter: acc.voter_info.owner,
                is_proxy: acc.voter_info.is_proxy === 1,
                proxy: acc.voter_info.proxy,
                producers: acc.voter_info.producers
            }

            if (payload.producers.length === 0) {
                delete payload.producers;
            }

            if (payload.proxy === '') {
                delete payload.proxy;
            }

            try {
                await this.manager.elasticsearchClient.index({
                    index: this.chain + '-table-voters',
                    id: `${payload.voter}`,
                    document: payload
                });
                // console.log(`${payload.scope}: ${payload.amount} ${payload.symbol}`);
            } catch (e) {
                console.log(`Failed to index voter: ${payload.voter}`);
                console.log(e);
            }
        }


        if (acc.permissions) {
            for (const perm of acc.permissions) {
                const payload = {
                    owner: accountName,
                    block_num: acc.head_block_num,
                    parent: perm.parent,
                    name: perm.perm_name,
                    auth: perm.required_auth,
                    present: 2
                };

                if (payload.auth.accounts.length === 0) {
                    // @ts-ignore
                    delete payload.auth.accounts;
                }

                if (payload.auth.keys.length === 0) {
                    // @ts-ignore
                    delete payload.auth.keys;
                } else {
                    for (const key of payload.auth.keys) {
                        key.key = convertLegacyPublicKey(key.key);
                    }
                }

                if (payload.auth.waits.length === 0) {
                    // @ts-ignore
                    delete payload.auth.waits;
                }

                try {
                    await this.manager.elasticsearchClient.index({
                        index: this.chain + '-perm',
                        id: `${payload.owner}-${payload.name}`,
                        document: payload
                    });
                    // console.log(`${payload.scope}: ${payload.amount} ${payload.symbol}`);
                } catch (e) {
                    console.log(`Failed to index permission: ${payload.owner}-${payload.name}`);
                    console.log(e);
                }
            }
        }
    }

    async getRows(start_at?: number | string | null) {
        const data = await this.manager.nodeosJsonRPC.get_table_rows({
            code: this.conf.settings.eosio_alias,
            table: 'voters',
            scope: this.conf.settings.eosio_alias,
            key_type: "name",
            lower_bound: start_at,
            upper_bound: "",
            limit: 10,
            json: true
        });
        return data.rows;
    }

    async fillCurrentStateTables() {
        hLog(`Filling system state tables with current data...`);
        const tRef = Date.now();

        let processedAccounts = 0;
        let totalAccounts = 0;
        let lastAccount = null;

        setInterval(() => {
            if (processedAccounts > 0) {
                hLog(`[Account Filler] processing ${processedAccounts} accounts/s | ${lastAccount} | ${totalAccounts}`);
                processedAccounts = 0;
            }
        }, 1000);

        const queue: any[] = [];
        const rows = await this.getRows(null);
        if (rows.length > 0) {
            lastAccount = rows[rows.length - 1].owner
        }
        queue.push(...rows);
        while (queue.length > 0) {
            const acc = queue.shift();
            await this.processAccount(acc.owner);
            processedAccounts++;
            totalAccounts++;
            if (queue.length === 0) {
                const nextBatch = await this.getRows(acc.owner);
                if (nextBatch.length > 1) {
                    lastAccount = (nextBatch.shift()).owner;
                    queue.push(...nextBatch);
                }
            }
        }

        hLog(`Filling took ${Date.now() - tRef}ms | ${totalAccounts} accounts`);
        process.exit();
    }

    async startFullIndexing() {

        // emit kill signal
        hLog(`Killing ${this.workerMap.length} workers`);
        let disconnect_counter = 0;
        for (const w of this.workerMap) {
            if (w.wref && w.wref.isConnected()) {
                w.wref.on("disconnect", () => {
                    disconnect_counter++;
                });
                w.wref.kill();
            }
        }

        // wait for all disconnect events
        await new Promise<void>((resolve) => {
            let _loop = setInterval(() => {
                if (disconnect_counter === this.workerMap.length) {
                    clearInterval(_loop);
                    resolve();
                }
            }, 100);
            setTimeout(() => {
                if (_loop) {
                    clearInterval(_loop);
                    resolve();
                }
            }, 10000);
        });

        // clear worker references
        this.workerMap = [];

        // disable abi scan mode and rewrite config file
        this.cm.setAbiScanMode(false);
        hLog('indexer.abi_scan_mode set to false');
        this.conf.indexer.abi_scan_mode = false;

        // reset global counters
        this.total_abis = 0;
        this.total_actions = 0;
        this.total_blocks = 0;
        this.total_deltas = 0;
        this.total_read = 0;
        this.range_completed = false;
        this.lastProcessedBlockNum = 0;
        this.cachedInitABI = null;


        await this.findRange();
        await this.setupWorkers();

        // launch new workers
        this.launchWorkers();

        // exit transition
        this.mode_transition = false;
    }

    private emitAlert(msgType: string, msgContent: string) {
        this.alerts.emitAlert({type: msgType, process: process.title, content: msgContent});
    }

    // ------- START OF PM2 METRICS AND ACTIONS ------- //

    private addPm2Metrics() {
        this.metrics.readingRate = pm2io.metric({name: 'Block Reading (blocks/s)'});
        this.metrics.consumeRate = pm2io.metric({name: 'Block Processing (blocks/s)'});
        this.metrics.actionDSRate = pm2io.metric({name: 'Action Deserialization (actions/s)'});
        this.metrics.deltaDSRate = pm2io.metric({name: 'Delta Deserialization (deltas/s)'});
        this.metrics.indexingRate = pm2io.metric({name: 'Indexing Rate (docs/s)'});
        this.metrics.queuedMessages = pm2io.metric({name: 'Queued Messages'});
        this.metrics.lastProcessedBlockNum = pm2io.metric({name: 'Last Block'});
        this.metrics.syncEta = pm2io.metric({name: 'Time to sync'});
    }

    private addPm2Actions() {
        const ioConfig: IOConfig = {
            apmOptions: {
                appName: this.chain + " indexer",
                publicKey: "",
                secretKey: "",
                sendLogs: true
            },
            metrics: {
                v8: true,
                http: false,
                network: false,
                runtime: true,
                eventLoop: true
            }
        };
        pm2io.init(ioConfig);


        pm2io.action('stop', (reply) => {
            try {
                this.shutdownStarted = true;
                this.allowMoreReaders = false;
                const stopMsg = 'Stop signal received. Shutting down readers immediately!';
                hLog(stopMsg);
                this.emitAlert('warning', stopMsg);
                messageAllWorkers(cluster, {
                    event: 'stop'
                });
                setInterval(() => {
                    if (this.allowShutdown && this.starting_block) {
                        getLastIndexedBlockFromRange(this.esClient, this.chain, this.starting_block, this.head).then((value: number) => {
                            hLog(`Last Indexed Block: ${value}`);
                            writeFileSync(`./chains/.${this.chain}_lastblock.txt`, value.toString());
                            hLog('Shutting down master...');
                            reply({ack: true});
                            process.exit(1);
                        });
                    }
                }, 100);
            } catch (e: any) {
                reply({ack: false, error: e.message});
            }
        });

        pm2io.action('get_usage_map', (reply) => {
            reply(this.globalUsageMap);
        });

        pm2io.action('get_memory_usage', (reply) => {
            this.requestDataFromWorkers(
                {
                    event: 'request_memory_usage'
                },
                'memory_report'
            ).then(value => {
                reply(value);
            });
        });

        pm2io.action('get_heap', (reply) => {
            this.requestDataFromWorkers(
                {
                    event: 'request_v8_heap_stats'
                },
                'v8_heap_report'
            ).then(value => {
                reply(value);
            });
        });
    }

    async requestDataFromWorkers(requestEvent: {
        event: string,
        data?: any
    }, responseEventType: string, timeoutSec: number = 1000) {
        const requests: any[] = [];
        for (const id in cluster.workers) {
            if (cluster.workers.hasOwnProperty(id)) {
                const worker: Worker | undefined = cluster.workers[id];
                requests.push(new Promise((resolve) => {
                    if (worker) {
                        const _timeout = setTimeout(() => {
                            worker.removeListener('message', _listener);
                            resolve([id, null]);
                        }, timeoutSec);
                        const _listener = (msg: any) => {
                            if (msg.event === responseEventType) {
                                clearTimeout(_timeout);
                                worker.removeListener('message', _listener);
                                resolve([msg.id, msg.data]);
                            }
                        };
                        worker.on('message', _listener);
                        worker.send(requestEvent);
                    }
                }));
            }
        }
        const results = await Promise.all(requests);
        const responses = {};
        for (const result of results) {
            if (result[1]) {
                responses[result[0]] = result[1];
            }
        }
        return responses;
    }

    // ------- END OF PM2 METRICS AND ACTIONS ------- //
}

