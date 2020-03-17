import {ConfigurationModule} from "./config";
import {ConnectionManager} from "../connections/manager.class";
import {JsonRpc} from "eosjs/dist";
import {ApiResponse, Client} from "@elastic/elasticsearch";
import {HyperionModuleLoader} from "./loader";

import {
    getLastIndexedABI,
    getLastIndexedBlock,
    getLastIndexedBlockByDelta,
    getLastIndexedBlockByDeltaFromRange,
    getLastIndexedBlockFromRange, hLog,
    messageAllWorkers
} from "../helpers/common_functions";

import {GetInfoResult} from "eosjs/dist/eosjs-rpc-interfaces";
import * as pm2io from '@pm2/io';

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

import {join} from "path";
import * as cluster from "cluster";
import {HyperionWorkerDef} from "../interfaces/hyperionWorkerDef";
import moment = require("moment");
import Timeout = NodeJS.Timeout;
import {HyperionConfig} from "../interfaces/hyperionConfig";
import {Worker} from "cluster";
import got from "got";

// const doctor = require('./modules/doctor');

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
    private client: Client;

    // hyperion module loader
    mLoader: HyperionModuleLoader;

    // Chain/Queue Prefix
    chain: string;

    // Chain API Info
    private chain_data: GetInfoResult;

    // Main workers
    private workerMap: HyperionWorkerDef[];
    private worker_index: number;

    // Scaling params
    private max_readers: number;
    private IndexingQueues: any;
    private maxBatchSize: number;
    private dsErrorStream: WriteStream;

    // mem-optimized deserialization pool
    private dsPoolMap: Map<number, cluster.Worker> = new Map();
    private globalUsageMap = {};
    private totalContractHits = 0;

    // producer monitoring
    private producedBlocks: object = {};
    private lastProducedBlockNum = 0;
    private lastProducer: string = null;
    private handoffCounter: number = 0;
    private missedRounds: object = {};
    private blockMsgQueue: any[] = [];

    // IPC Messaging
    private totalMessages = 0;

    // Repair
    private doctorId = 0;
    private missingRanges = [];
    private doctorIdle = true;

    // Indexer Monitoring
    private lastProcessedBlockNum = 0;
    private allowMoreReaders = true;
    private allowShutdown = false;
    private readonly log_interval = 5000;
    private consumedBlocks = 0;
    private deserializedActions = 0;
    private total_indexed_blocks = 0;
    private indexedObjects = 0;
    private deserializedDeltas = 0;
    private liveConsumedBlocks = 0;
    private livePushedBlocks = 0;
    private pushedBlocks = 0;
    private total_read = 0;
    private total_blocks = 0;
    private total_actions = 0;
    private total_deltas = 0;
    private consume_rates: number[] = [];
    private total_range = 0;
    private range_completed = false;
    private head: number;
    private starting_block: number;
    private shutdownTimer: Timeout;
    private idle_count = 0;
    private auto_stop = 0;

    // IPC Messages Handling
    private msgHandlerMap: any;

    private cachedInitABI = false;
    private activeReadersCount = 0;
    private lastAssignedBlock: number;
    private lastIndexedABI: number;


    constructor() {
        const cm = new ConfigurationModule();
        this.conf = cm.config;
        this.manager = new ConnectionManager(cm);
        this.mLoader = new HyperionModuleLoader(cm);
        this.chain = this.conf.settings.chain;
        this.initHandlerMap();
    }

    initHandlerMap() {
        this.msgHandlerMap = {
            'consumed_block': (msg: any) => {
                if (msg.live === 'false') {
                    this.consumedBlocks++;
                    if (msg.block_num > this.lastProcessedBlockNum) {
                        this.lastProcessedBlockNum = msg.block_num;
                    }
                } else {
                    // LIVE READER
                    this.liveConsumedBlocks++;
                    if (this.conf.settings.bp_monitoring) {
                        this.onLiveBlock(msg);
                    }
                }
            },
            'init_abi': (msg: any) => {
                if (!this.cachedInitABI) {
                    this.cachedInitABI = msg.data;
                    hLog('received ship abi for distribution');
                    messageAllWorkers(cluster, {
                        event: 'initialize_abi',
                        data: msg.data
                    });
                }
            },
            'router_ready': () => {
                messageAllWorkers(cluster, {
                    event: 'connect_ws'
                });
            },
            'save_abi': (msg: any) => {
                if (msg.live_mode === 'true') {
                    hLog(`deserializer ${msg.worker_id} received new abi! propagating changes to other workers...`);
                    for (const worker of this.workerMap) {
                        if (worker.worker_role === 'deserializer' && worker.worker_id !== parseInt(msg.worker_id)) {
                            worker.wref.send({
                                event: 'update_abi',
                                abi: msg.data
                            });
                        }
                    }
                }
            },
            'completed': (msg: any) => {
                if (msg.id === this.doctorId.toString()) {
                    hLog('repair worker completed', msg);
                    hLog('queue size [before]:', this.missingRanges.length);
                    if (this.missingRanges.length > 0) {
                        const range_data = this.missingRanges.shift();
                        hLog('New repair range', range_data);
                        hLog('queue size [after]:', this.missingRanges.length);
                        this.doctorIdle = false;
                        messageAllWorkers(cluster, {
                            event: 'new_range',
                            target: msg.id,
                            data: {
                                first_block: range_data.start,
                                last_block: range_data.end
                            }
                        });
                    } else {
                        this.doctorIdle = true;
                    }
                } else {
                    this.activeReadersCount--;
                    if (this.activeReadersCount < this.max_readers && this.lastAssignedBlock < this.head && this.allowMoreReaders) {
                        // Assign next range
                        const start = this.lastAssignedBlock;
                        let end = this.lastAssignedBlock + this.maxBatchSize;
                        if (end > this.head) {
                            end = this.head;
                        }
                        this.lastAssignedBlock += this.maxBatchSize;
                        const def = {
                            first_block: start,
                            last_block: end
                        };
                        this.activeReadersCount++;
                        messageAllWorkers(cluster, {
                            event: 'new_range',
                            target: msg.id,
                            data: def
                        });
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
                const str = JSON.stringify(msg.data);
                this.dsErrorStream.write(str + '\n');
            },
            'read_block': (msg: any) => {
                if (!msg.live) {
                    this.pushedBlocks++;
                } else {
                    this.livePushedBlocks++;
                }
            },
            'new_schedule': (msg: any) => {
                this.onScheduleUpdate(msg);
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
                const ping_response: ApiResponse = await ingestClient.ping();
                if (ping_response.body) {
                    hLog(`Ingest client ready at ${ping_response.meta.connection.id}`);
                }
            } catch (e) {
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
        if (table_feats.userres) {
            indicesList.push({name: 'tableUserres', type: 'table-userres'});
            index_queues.push({type: 'table-userres', name: index_queue_prefix + "_table_userres"});
        }
    }

    private async getCurrentSchedule() {
        try {
            this.currentSchedule = await this.rpc.get_producer_schedule();
            if (!this.currentSchedule) {
                console.error('empty producer schedule, something went wrong!');
                process.exit(1);
            }
        } catch (e) {
            console.error('failed to connect to api');
            process.exit(1);
        }
    }

    private async applyUpdateScript() {
        const script_status = await this.client.putScript({
            id: "updateByBlock",
            body: {
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
            }
        });
        if (!script_status.body['acknowledged']) {
            hLog('Failed to load script updateByBlock. Aborting!');
            process.exit(1);
        } else {
            hLog('Painless Update Script loaded!');
        }
    }

    private async addLifecyclePolicies(indexConfig) {
        if (indexConfig.ILPs) {
            for (const ILP of indexConfig.ILPs) {
                try {
                    await this.client.ilm.getLifecycle({
                        policy: ILP.policy
                    });
                } catch (e) {
                    hLog(e);
                    try {
                        const ilm_status: ApiResponse = await this.client.ilm.putLifecycle(ILP);
                        if (!ilm_status.body['acknowledged']) {
                            hLog(`Failed to create ILM Policy`);
                        }
                    } catch (e) {
                        hLog(`[FATAL] :: Failed to create ILM Policy`);
                        hLog(e);
                        process.exit(1);
                    }
                }
            }
        }
    }

    private async appendExtraMappings(indexConfig) {
        // Modify mappings
        for (const exM of this.mLoader.extraMappings) {
            if (exM['action']) {
                for (const key in exM['action']) {
                    if (exM['action'].hasOwnProperty(key)) {
                        indexConfig['action']['mappings']['properties'][key] = exM['action'][key];
                        hLog(`Mapping added for ${key}`);
                    }
                }
            }
        }
    }

    private async updateIndexTemplates(indicesList: { name: string, type: string }[], indexConfig) {
        for (const index of indicesList) {
            try {
                const creation_status: ApiResponse = await this.client['indices'].putTemplate({
                    name: `${this.conf.settings.chain}-${index.type}`,
                    body: indexConfig[index.name]
                });
                if (!creation_status || !creation_status['body']['acknowledged']) {
                    hLog(`Failed to create template: ${this.conf.settings.chain}-${index}`);
                }
            } catch (e) {
                hLog(e);
                if (e.meta) {
                    hLog(e.meta.body);
                }
                process.exit(1);
            }
        }
        hLog('Index templates updated');
    }

    private async createIndices(indicesList: { name: string, type: string }[]) {
        // Create indices
        const queue_prefix = this.conf.settings.chain;
        if (this.conf.settings.index_version) {
            // Create indices
            let version;
            if (this.conf.settings.index_version === 'true') {
                version = 'v1';
            } else {
                version = this.conf.settings.index_version;
            }
            for (const index of indicesList) {
                const new_index = `${queue_prefix}-${index.type}-${version}-000001`;
                const exists = await this.client.indices.exists({
                    index: new_index
                });
                if (!exists.body) {
                    hLog(`Creating index ${new_index}...`);
                    await this.client['indices'].create({
                        index: new_index
                    });
                    hLog(`Creating alias ${queue_prefix}-${index.type} >> ${new_index}`);
                    await this.client.indices.putAlias({
                        index: new_index,
                        name: `${queue_prefix}-${index.type}`
                    });
                }
            }
        }

        // Check for indexes
        for (const index of indicesList) {
            const status = await this.client.indices.existsAlias({
                name: `${queue_prefix}-${index.type}`
            });
            if (!status) {
                hLog('Alias ' + `${queue_prefix}-${index.type}` + ' not found! Aborting!');
                process.exit(1);
            }
        }
    }

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
                        lastIndexedBlockOnRange = await getLastIndexedBlockByDeltaFromRange(this.client, this.chain, this.starting_block, this.head);
                    } else {
                        lastIndexedBlockOnRange = await getLastIndexedBlockFromRange(this.client, this.chain, this.starting_block, this.head);
                    }
                    if (lastIndexedBlockOnRange > this.starting_block) {
                        hLog('WARNING! Data present on target range!');
                        hLog('Changing initial block num. Use REWRITE = true to bypass.');
                        this.starting_block = lastIndexedBlockOnRange;
                    }
                }
            }
            hLog(' |>> First Block: ' + this.starting_block);
            hLog(' >>| Last  Block: ' + this.head);
        }
    }

    private static printWorkerMap(wmp) {
        hLog('---------------- PROPOSED WORKER LIST ----------------------');
        for (const w of wmp) {
            const str = [];
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
        let qIdx = 0;
        this.IndexingQueues.forEach((q) => {
            let n = this.conf.scaling.indexing_queues;
            if (q.type === 'abi') {
                n = 1;
            }
            qIdx = 0;
            for (let i = 0; i < n; i++) {
                let m = 1;
                if (q.type === 'action' || q.type === 'delta') {
                    m = this.conf.scaling.ad_idx_queues;
                }
                for (let j = 0; j < m; j++) {
                    this.addWorker({
                        worker_role: 'ingestor',
                        queue: q.name + ":" + (qIdx + 1),
                        type: q.type
                    });
                    qIdx++;
                }
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

    private addWorker(def: any) {
        this.worker_index++;
        def.worker_id = this.worker_index;
        this.workerMap.push(def);
    }

    private async setupDSPool() {
        for (let i = 0; i < this.conf.scaling.ds_pool_size; i++) {
            this.addWorker({
                worker_role: 'ds_pool_worker',
                local_id: i
            });
        }
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

    setupDSElogs() {
        const logPath = './logs/' + this.chain;
        if (!existsSync(logPath)) mkdirSync(logPath, {recursive: true});
        const dsLogFileName = (new Date().toISOString()) + "_ds_err_" + this.starting_block + "_" + this.head + ".log";
        const dsErrorsLog = logPath + '/' + dsLogFileName;
        if (existsSync(dsErrorsLog)) unlinkSync(dsErrorsLog);
        const symbolicLink = logPath + '/deserialization_errors.log';
        if (existsSync(symbolicLink)) unlinkSync(symbolicLink);
        symlinkSync(dsLogFileName, symbolicLink);
        this.dsErrorStream = createWriteStream(dsErrorsLog, {flags: 'a'});
        hLog(`📣️  Deserialization errors are being logged in:\n ${join(__dirname, symbolicLink)}`);
    }

    onLiveBlock(msg) {
        if (msg.block_num === this.lastProducedBlockNum + 1 || this.lastProducedBlockNum === 0) {
            const prod = msg.producer;

            if (this.conf.settings.bp_logs) {
                hLog(`Received block ${msg.block_num} from ${prod}`);
            }
            if (this.producedBlocks[prod]) {
                this.producedBlocks[prod]++;
            } else {
                this.producedBlocks[prod] = 1;
            }
            if (this.lastProducer !== prod) {
                this.handoffCounter++;
                if (this.lastProducer && this.handoffCounter > 2) {
                    const activeProds = this.currentSchedule.active.producers;
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
            this.lastProducedBlockNum = msg.block_num;
        } else {
            this.blockMsgQueue.push(msg);
            this.blockMsgQueue.sort((a, b) => a.block_num - b.block_num);
            while (this.blockMsgQueue.length > 0) {
                if (this.blockMsgQueue[0].block_num === this.lastProducedBlockNum + 1) {
                    this.onLiveBlock(this.blockMsgQueue.shift());
                } else {
                    break;
                }
            }
        }
    }

    handleMessage(msg) {
        if (this.conf.settings.ipc_debug_rate && this.conf.settings.ipc_debug_rate >= 1000) {
            this.totalMessages++;
        }
        if (this.msgHandlerMap[msg.event]) {
            this.msgHandlerMap[msg.event](msg);
        } else {
            if (msg.type) {
                if (msg.type === 'axm:monitor') {
                    if (process.env['AXM_DEBUG'] === 'true') {
                        hLog(`----------- axm:monitor ------------`);
                        for (const key in msg.data) {
                            if (msg.data.hasOwnProperty(key)) {
                                hLog(`${key}: ${msg.data[key].value}`);
                            }
                        }
                    }
                }
            }
        }
    }

    private async setupReaders() {
        // Setup Readers
        this.lastAssignedBlock = this.starting_block;
        this.activeReadersCount = 0;
        if (!this.conf.indexer.repair_mode) {
            if (!this.conf.indexer.live_only_mode) {
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
            // Setup Serial reader worker
            if (this.conf.indexer.live_reader) {
                const _head = this.chain_data.head_block_num;
                hLog(`Setting live reader at head = ${_head}`);
                // live block reader
                this.addWorker({
                    worker_role: 'continuous_reader',
                    worker_last_processed_block: _head,
                    ws_router: ''
                });
                // live deserializer
                this.addWorker({
                    worker_role: 'deserializer',
                    worker_queue: this.chain + ':live_blocks',
                    live_mode: 'true'
                });
            }
        }
    }

    private reportMissedBlocks(missingProd: any, lastProducedBlockNum: number, size: number) {
        hLog(`${missingProd} missed ${size} ${size === 1 ? "block" : "blocks"} after ${lastProducedBlockNum}`);
        this.client.index({
            index: this.chain + '-logs',
            body: {
                type: 'missed_blocks',
                '@timestamp': new Date().toISOString(),
                'missed_blocks': {
                    'producer': missingProd,
                    'last_block': lastProducedBlockNum,
                    'size': size,
                    'schedule_version': this.currentSchedule.schedule_version
                }
            }
        }).catch(hLog);
    }

    // private startRepairMode() {
    //     let doctorStarted = false;
    //     let doctorId = 0;
    //     doctor.run(this.missingRanges as any).then(() => {
    //         hLog('repair completed!');
    //     });
    //     setInterval(() => {
    //         if (this.missingRanges.length > 0 && !doctorStarted) {
    //             doctorStarted = true;
    //             hLog('repair worker launched');
    //             const range_data = this.missingRanges.shift();
    //             this.worker_index++;
    //             const def = {
    //                 worker_id: this.worker_index,
    //                 worker_role: 'reader',
    //                 first_block: range_data.start,
    //                 last_block: range_data.end
    //             };
    //             const self = cluster.fork(def);
    //             doctorId = def.worker_id;
    //             hLog('repair id =', doctorId);
    //             self.on('message', (msg) => {
    //                 this.handleMessage(msg);
    //             });
    //         } else {
    //             if (this.missingRanges.length > 0 && this.doctorIdle) {
    //                 const range_data = this.missingRanges.shift();
    //                 messageAllWorkers(cluster, {
    //                     event: 'new_range',
    //                     target: doctorId.toString(),
    //                     data: {
    //                         first_block: range_data.start,
    //                         last_block: range_data.end
    //                     }
    //                 });
    //             }
    //         }
    //     }, 1000);
    // }

    updateWorkerAssignments() {
        const pool_size = this.conf.scaling.ds_pool_size;
        const worker_max_pct = 1 / pool_size;
        const worker_shares = {};
        for (let i = 0; i < pool_size; i++) {
            worker_shares[i] = 0.0;
        }
        for (const code in this.globalUsageMap) {
            if (this.globalUsageMap.hasOwnProperty(code)) {
                const _pct = this.globalUsageMap[code][0] / this.totalContractHits;
                let used_pct = 0;
                const proposedWorkers = [];
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
                    }
                }
                this.globalUsageMap[code][1] = _pct;
                if (JSON.stringify(this.globalUsageMap[code][2]) !== JSON.stringify(proposedWorkers)) {
                    // hLog(this.globalUsageMap[code][2], ">>", proposedWorkers);
                    proposedWorkers.forEach(w => {
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
                            this.dsPoolMap.get(w_id).send({
                                event: "remove_contract",
                                contract: code
                            });
                        }
                    });
                    this.globalUsageMap[code][2] = proposedWorkers;
                }
            }
        }
    }

    private startContractMonitoring() {
        // Monitor Global Contract Usage
        setInterval(() => {

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
                    w.wref.send({
                        event: 'update_pool_map',
                        data: this.globalUsageMap
                    });
                }
            }

            // clearUsageMap();
        }, 5000);
    }

    private monitorIndexingQueues() {
        const limit = this.conf.scaling.auto_scale_trigger;
        const autoscaleConsumers = {};
        setInterval(async () => {
            const testedQueues = new Set();
            for (const worker of this.workerMap) {
                if (worker.worker_role === 'ingestor') {
                    const queue = worker.queue;
                    if (!testedQueues.has(queue)) {
                        testedQueues.add(queue);
                        const size = await this.manager.checkQueueSize(queue);
                        if (size > limit) {
                            if (!autoscaleConsumers[queue]) {
                                autoscaleConsumers[queue] = 0;
                            }
                            if (autoscaleConsumers[queue] < this.conf.scaling.max_autoscale) {
                                hLog(`${queue} is above the limit (${size}/${limit}). Launching consumer...`);
                                this.addWorker({
                                    queue: queue,
                                    type: worker.type,
                                    worker_role: 'ingestor'
                                });
                                this.launchWorkers();
                                autoscaleConsumers[queue]++;
                            } else {
                                // hLog(`WARN: Max consumer limit reached on ${queue}!`);
                            }
                        }
                    }
                }
            }
        }, 20000);
    }

    private onPm2Stop() {
        pm2io.action('stop', (reply) => {
            this.allowMoreReaders = false;
            console.info('Stop signal received. Shutting down readers immediately!');
            hLog('Waiting for queues...');
            messageAllWorkers(cluster, {
                event: 'stop'
            });
            reply({ack: true});
            setInterval(() => {
                if (this.allowShutdown) {

                    // TODO: check last indexed block, print to console and save on a temporary file
                    getLastIndexedBlockFromRange(this.client, this.chain, this.starting_block, this.head).then((lastblock) => {
                        hLog(`Last Indexed Block: ${lastblock}`);
                        writeFileSync(`./chains/.${this.chain}_lastblock.txt`, lastblock.toString());
                        hLog('Shutting down master...');
                        process.exit(1);
                    });

                }
            }, 500);
        });
    }

    private startIndexMonitoring() {
        const reference_time = Date.now();
        setInterval(() => {
            const _workers = Object.keys(cluster.workers).length;
            const tScale = (this.log_interval / 1000);
            this.total_read += this.pushedBlocks;
            this.total_blocks += this.consumedBlocks;
            this.total_actions += this.deserializedActions;
            this.total_deltas += this.deserializedDeltas;
            this.total_indexed_blocks += this.indexedObjects;
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
            const log_msg = [];
            log_msg.push(`W:${_workers}`);
            log_msg.push(`R:${(this.pushedBlocks + this.livePushedBlocks) / tScale}`);
            log_msg.push(`C:${(this.liveConsumedBlocks + this.consumedBlocks) / tScale}`);
            log_msg.push(`A:${(this.deserializedActions) / tScale}`);
            log_msg.push(`D:${(this.deserializedDeltas) / tScale}`);
            log_msg.push(`I:${this.indexedObjects / tScale}`);

            if (this.total_blocks < this.total_range && !this.conf.indexer.live_only_mode) {
                const remaining = this.total_range - this.total_blocks;
                const estimated_time = Math.round(remaining / avg_consume_rate);
                const time_string = moment().add(estimated_time, 'seconds').fromNow(false);
                const pct_parsed = ((this.total_blocks / this.total_range) * 100).toFixed(1);
                const pct_read = ((this.total_read / this.total_range) * 100).toFixed(1);
                log_msg.push(`${this.total_blocks}/${this.total_read}/${this.total_range}`);
                log_msg.push(`syncs ${time_string} (${pct_parsed}% ${pct_read}%)`);
            }

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
        --------------------------------------------\n`);
                this.range_completed = true;
            }

            // print monitoring log
            if (this.conf.settings.rate_monitoring) {
                hLog(log_msg.join(' | '));
            }

            if (this.indexedObjects === 0 && this.deserializedActions === 0 && this.consumedBlocks === 0) {

                // Allow 10s threshold before shutting down the process
                this.shutdownTimer = setTimeout(() => {
                    this.allowShutdown = true;
                }, 10000);

                // Auto-Stop
                if (this.pushedBlocks === 0) {
                    this.idle_count++;
                    if (this.auto_stop > 0 && (tScale * this.idle_count) >= this.auto_stop) {
                        hLog("Reached limit for no blocks processed, stopping now...");
                        process.exit(1);
                    } else {
                        hLog(`No blocks processed! Indexer will stop in ${this.auto_stop - (tScale * this.idle_count)} seconds!`);
                    }
                }
            } else {
                if (this.idle_count > 1) {
                    hLog('Processing resumed!');
                }
                this.idle_count = 0;
                if (this.shutdownTimer) {
                    clearTimeout(this.shutdownTimer);
                    this.shutdownTimer = null;
                }
            }

            // reset counters
            this.resetMonitoringCounters();


            if (_workers === 0) {
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

    private onScheduleUpdate(msg: any) {
        if (msg.live === 'true') {
            hLog(`Producer schedule updated at block ${msg.block_num}`);
            this.currentSchedule.active.producers = msg.new_producers.producers
        }
    }

    private launchWorkers() {
        this.workerMap.forEach((conf) => {
            if (!conf.wref) {
                conf['wref'] = cluster.fork(conf);
                conf['wref'].on('message', (msg) => {
                    this.handleMessage(msg);
                });
                if (conf.worker_role === 'ds_pool_worker') {
                    this.dsPoolMap.set(conf.local_id, conf['wref']);
                }
            }
        });
    }

    async runMaster() {

        this.printMode();

        // Preview mode - prints only the proposed worker map
        let preview = this.conf.settings.preview;
        const queue_prefix = this.conf.settings.chain;

        await this.purgeQueues();

        // Chain API
        this.rpc = this.manager.nodeosJsonRPC;
        if (this.conf.settings.bp_monitoring) {
            await this.getCurrentSchedule();
            hLog(`${this.currentSchedule.active.producers.length} active producers`);
        }

        // ELasticsearch
        this.client = this.manager.elasticsearchClient;
        try {
            const esInfo = await this.client.info();
            hLog(`Elasticsearch: ${esInfo.body.version.number} | Lucene: ${esInfo.body.version.lucene_version}`);
        } catch (e) {
            hLog('Failed to check elasticsearch version!');
            process.exit();
        }
        await this.verifyIngestClients();
        this.max_readers = this.conf.scaling.readers;
        if (this.conf.indexer.disable_reading) {
            this.max_readers = 1;
        }

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

        const indexConfig = await import('../definitions/index-templates');

        const indicesList = [
            {name: "action", type: "action"},
            {name: "block", type: "block"},
            {name: "abi", type: "abi"},
            {name: "delta", type: "delta"},
            {name: "logs", type: "logs"},
            {name: 'permissionLink', type: 'link'}
        ];

        this.addStateTables(indicesList, this.IndexingQueues);
        await this.applyUpdateScript();
        await this.addLifecyclePolicies(indexConfig);
        await this.appendExtraMappings(indexConfig);
        await this.updateIndexTemplates(indicesList, indexConfig);
        await this.createIndices(indicesList);

        // Prepare Workers
        this.workerMap = [];
        this.worker_index = 0;
        this.maxBatchSize = this.conf.scaling.batch_size;

        // Auto-stop
        if (this.conf.settings.auto_stop) {
            this.auto_stop = this.conf.settings.auto_stop;
        }

        // Find last indexed block
        let lastIndexedBlock;
        if (this.conf.features.index_deltas) {
            lastIndexedBlock = await getLastIndexedBlockByDelta(this.client, queue_prefix);
            hLog('Last indexed block (deltas):', lastIndexedBlock);
        } else {
            lastIndexedBlock = await getLastIndexedBlock(this.client, queue_prefix);
            hLog('Last indexed block (blocks):', lastIndexedBlock);
        }

        // Start from the last indexed block
        this.starting_block = 1;

        // Fecth chain lib
        try {
            this.chain_data = await this.rpc.get_info();
        } catch (e) {
            console.log(e.message);
            console.error('failed to connect to chain api');
            process.exit(1);
        }
        this.head = this.chain_data.head_block_num;

        if (lastIndexedBlock > 0) {
            this.starting_block = lastIndexedBlock;
        }

        if (this.conf.indexer.stop_on !== 0) {
            this.head = this.conf.indexer.stop_on;
        }

        this.lastIndexedABI = await getLastIndexedABI(this.client, queue_prefix);
        await this.defineBlockRange();
        this.total_range = this.head - this.starting_block;
        await this.setupReaders();
        await this.setupDeserializers();
        await this.setupIndexers();
        await this.setupStreaming();
        await this.setupDSPool();

        // Quit App if on preview mode
        if (preview) {
            HyperionMaster.printWorkerMap(this.workerMap);
            await this.waitForLaunch();
        }

        // Setup Error Logging
        this.setupDSElogs();

        // Start Monitoring
        this.startIndexMonitoring();

        cluster.on('disconnect', (worker) => {
            hLog(`The worker #${worker.id} has disconnected`);
        });

        // Launch all workers
        this.launchWorkers();

        if (this.conf.settings.ipc_debug_rate > 0 && this.conf.settings.ipc_debug_rate < 1000) {
            hLog(`settings.ipc_debug_rate was set too low (${this.conf.settings.ipc_debug_rate}) using 1000 instead!`);
            this.conf.settings.ipc_debug_rate = 1000;
        }

        if (this.conf.settings.ipc_debug_rate && this.conf.settings.ipc_debug_rate >= 1000) {
            const rate = this.conf.settings.ipc_debug_rate;
            this.totalMessages = 0;
            setInterval(() => {
                hLog(`IPC Messaging Rate: ${(this.totalMessages / (rate / 1000)).toFixed(2)} msg/s`);
                this.totalMessages = 0;
            }, rate);
        }

        // TODO: reimplement the indexer repair mode in typescript modules
        // if (this.conf.indexer.repair_mode) {
        //     this.startRepairMode();
        // }

        this.startContractMonitoring();
        this.monitorIndexingQueues();
        this.onPm2Stop();

        pm2io.action('get_heap', (reply) => {
            const requests = [];
            for (const id in cluster.workers) {
                if (cluster.workers.hasOwnProperty(id)) {
                    const worker: Worker = cluster.workers[id];
                    requests.push(new Promise((resolve) => {
                        const _timeout = setTimeout(() => {
                            worker.removeListener('message', _listener);
                            resolve([id, null]);
                        }, 1000);
                        const _listener = (msg) => {
                            if (msg.event === 'v8_heap_report') {
                                clearTimeout(_timeout);
                                worker.removeListener('message', _listener);
                                resolve([msg.id, msg.data]);
                            }
                        };
                        worker.on('message', _listener);
                        worker.send({event: 'request_v8_heap_stats'});
                    }));
                }
            }

            Promise.all(requests).then((results) => {
                const responses = {};
                for (const result of results) {
                    if (result[1]) {
                        responses[result[0]] = result[1];
                    }
                }
                reply(responses);
            });
        });
    }
}

