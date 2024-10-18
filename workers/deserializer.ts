import {HyperionWorker} from "./hyperionWorker";
import {Api} from "eosjs/dist";
import {cargo, queue} from 'async';
import {debugLog, hLog} from "../helpers/common_functions";
import {createHash} from "crypto";
import {Message, Options} from "amqplib";

import flatstr from 'flatstr';

import {index_queues, RabbitQueueDef} from "../definitions/index-queues";
import {AbiDefinitions} from "../definitions/abi_def";
import {HyperionDelta} from "../interfaces/hyperion-delta";
import {TableDelta} from "../interfaces/table-delta";
import {HyperionAbi} from "../interfaces/hyperion-abi";
import {TransactionTrace} from "../interfaces/action-trace";
import {Serialize} from "eosjs";
import {Abi} from "eosjs/dist/eosjs-rpc-interfaces";
import {Action, Type as EOSJSType} from "eosjs/dist/eosjs-serialize";
import {JsSignatureProvider} from "eosjs/dist/eosjs-jssig";
import {HyperionSignedBlock} from "../interfaces/signed-block";
import {SearchResponse} from "@elastic/elasticsearch/lib/api/types";


const abi_remapping = {
    "_Bool": "bool"
};

interface QueuePayload {
    queue: string;
    content: Buffer;
    headers?: any;
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
    new_producers: {
        version: number;
        producers: {
            block_signing_key: string;
            producer_name: string;
        }[];
    };
    schedule_version: number;
    cpu_usage: number;
    net_usage: number;
}

function bufferFromJson(data: any, useFlatstr?: boolean) {
    if (useFlatstr) {
        return Buffer.from(flatstr(JSON.stringify(data)));
    } else {
        return Buffer.from(JSON.stringify(data));
    }
}

export default class MainDSWorker extends HyperionWorker {

    ch_ready = false;
    private consumerQueue;
    private preIndexingQueue;
    private abi?: Abi;
    public types: Map<string, EOSJSType> = new Map();
    private tables = new Map();
    private allowStreaming = false;
    private dsPoolMap = {};
    private ds_pool_counters = {};
    private block_emit_idx = 1;
    private local_block_count = 0;
    common: any;
    tableHandlers = {};
    api: Api;

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
    deltaRemovalQueue: string;

    allowedDynamicContracts: Set<string> = new Set<string>();

    backpressureQueue: any[] = [];
    waitToSend = false;

    constructor() {

        super();

        this.deltaRemovalQueue = this.chain + ":delta_rm";

        this.consumerQueue = cargo<Message>((payload, cb) => {
            this.processMessages(payload).then(() => {
                cb();
            }).catch((err) => {
                hLog('NACK ALL', err.message);
                if (this.ch && this.ch_ready) {
                    this.ch.nackAll();
                }
            });
        }, this.conf.prefetch.block);

        this.preIndexingQueue = queue((data: any, cb) => {
            if (this.ch && this.ch_ready) {
                this.ch.sendToQueue(data.queue, data.content, {headers: data.headers});
                cb();
            } else {
                hLog('Channel is not ready!');
            }
        }, 1);

        this.api = new Api({
            rpc: this.rpc,
            signatureProvider: new JsSignatureProvider([]),
            chainId: this.chainId,
            textDecoder: this.txDec,
            textEncoder: this.txEnc,
        });

        // this.allowedDynamicContracts.add('atomicassets');
        // this.allowedDynamicContracts.add('atomicmarket');
        // this.allowedDynamicContracts.add('atomictoolsx');
        // this.allowedDynamicContracts.add('atomicbridge');
        // this.allowedDynamicContracts.add('delphioracle');
        // this.allowedDynamicContracts.add('m.federation');
        // this.allowedDynamicContracts.add('pack.worlds');

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
                this.abi = JSON.parse(msg.data) as Abi;
                this.abieos.loadAbi("0", msg.data);
                const initialTypes = Serialize.createInitialTypes();
                this.types = Serialize.getTypesFromAbi(initialTypes, this.abi);
                this.abi.tables.map(table => this.tables.set(table.name, table.type));
                this.initConsumer();
                break;
            }
            case 'update_abi': {
                if (msg.abi) {
                    if (msg.abi.abi_hex) {
                        this.abieos.loadAbiHex(msg.abi.account, msg.abi.abi_hex);
                        hLog(`Worker ${process.env.worker_id} updated the abi for ${msg.abi.account}`);
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
        }
    }

    assertQueues(): void {

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

        this.ch.assertQueue(this.deltaRemovalQueue, RabbitQueueDef);

        // make sure the input queue is ready if the deserializer launches too early
        this.ch.assertQueue(process.env['worker_queue'], RabbitQueueDef);

        if (process.env['live_mode'] === 'false') {
            for (let i = 0; i < this.conf.scaling.ds_queues; i++) {
                this.ch.assertQueue(this.chain + ":blocks:" + (i + 1), RabbitQueueDef);
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
        if (this.abi) {
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
        await this.mLoader.parser?.parseMessage(this, messages);
    }

    private initConsumer() {
        if (this.ch_ready && this.ch && process.env.worker_queue) {
            this.ch.prefetch(this.conf.prefetch.block);
            this.ch.consume(process.env.worker_queue, (data) => {
                this.consumerQueue.push(data).catch(console.log);
            });
            this.ch.on('drain', () => {
                this.waitToSend = false;
                while (this.backpressureQueue.length > 0) {
                    const msg = this.backpressureQueue.shift();
                    const status = this.controlledSendToQueue(msg.queue, msg.payload, msg.options);
                    if (!status) {
                        break;
                    }
                }
            });
        }
    }

    async processBlock(
        res: any,
        block: HyperionSignedBlock,
        traces: [string, TransactionTrace][] | null,
        deltas: [string, TableDelta][] | null
    ) {
        if (!res['this_block']) {
            // missing current block data
            hLog(res);
            return null;
        } else {
            let producer = '';
            let ts = '';
            const block_num = res['this_block']['block_num'];
            const block_id = res['this_block']['block_id'].toLowerCase();
            let block_ts = res['this_time'];
            let light_block;

            if (this.conf.indexer.fetch_block) {

                if (!block) {
                    return null;
                }

                producer = block['producer'];
                ts = block['timestamp'];
                block_ts = ts;

                let total_cpu = 0;
                let total_net = 0;

                const failedTrx: any[] = [];

                block.transactions.forEach((trx) => {

                    total_cpu += trx['cpu_usage_us'];
                    total_net += trx['net_usage_words'];

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
                });

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

                light_block = {
                    '@timestamp': block['timestamp'],
                    block_num: res['this_block']['block_num'],
                    block_id: res['this_block']['block_id'].toLowerCase(),
                    producer: block['producer'],
                    new_producers: block['new_producers'],
                    schedule_version: block['schedule_version'],
                    cpu_usage: total_cpu,
                    net_usage: total_net
                };

                if (res['prev_block']) {
                    light_block.prev_id = res['prev_block']['block_id'].toLowerCase();
                }

                if (light_block.new_producers) {
                    process.send?.({
                        event: 'new_schedule',
                        block_num: light_block.block_num,
                        new_producers: light_block.new_producers,
                        live: process.env.live_mode
                    });
                }

                // stream light block
                if (this.allowStreaming && this.ch) {
                    this.ch.publish('', this.chain + ':stream', Buffer.from(JSON.stringify(light_block)), {
                        headers: {
                            event: 'block',
                            blockNum: light_block.block_num
                        }
                    });
                }
            }

            // Process Delta Traces (must be done first to catch ABI updates)
            if (deltas && this.conf.indexer.process_deltas) {
                await this.processDeltas(deltas, block_num, block_ts, block_id);
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

                if (_traces.length > 0 && this.conf.indexer.fetch_traces) {
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
                                        block_num: light_block.block_num,
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
                                this.routeToPool(trace[1], {
                                    block_num,
                                    block_id,
                                    producer,
                                    ts,
                                    inline_count,
                                    filtered,
                                    live: process.env['live_mode']
                                });
                            } catch (e) {
                                hLog(e);
                                hLog(block_num);
                                hLog(trace[1]);
                            }
                        }
                    }
                }
            }

            // Send light block to indexer
            if (this.conf.indexer.fetch_block) {
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
            await this.preIndexingQueue.push({
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

    routeToPool(trace, headers) {

        let first_action;
        if (trace['action_traces'][0] && trace['action_traces'][0].length === 2) {
            first_action = trace['action_traces'][0][1];

            // replace first action if the root is eosio.null::nonce
            if (first_action.act.account === this.conf.settings.eosio_alias + '.null' && first_action.act.name === 'nonce') {
                if (trace['action_traces'][1] && trace['action_traces'][1].length === 2) {
                    first_action = trace['action_traces'][1][1];
                }
            }

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
        const payload = bufferFromJson(trace, true);

        if (!this.waitToSend) {
            if (this.ch_ready) {
                this.controlledSendToQueue(pool_queue, payload, {headers});
                return true;
            } else {
                return false;
            }
        } else {
            this.backpressureQueue.push({
                queue: pool_queue,
                payload: payload,
                options: {headers}
            });
            return false;
        }
    }

    controlledSendToQueue(pool_queue: string, payload: Buffer, options: Options.Publish): boolean {
        if (this.ch) {
            const enqueueResult = this.ch.sendToQueue(pool_queue, payload, options);
            if (!enqueueResult) {
                this.waitToSend = true;
            }
            return enqueueResult;
        } else {
            hLog("Channel was not created!");
            return false;
        }
    }

    createSerialBuffer(inputArray: Uint8Array) {
        return new Serialize.SerialBuffer({
            textEncoder: this.txEnc,
            textDecoder: this.txDec,
            array: inputArray
        });
    }

    async fetchAbiHexAtBlockElastic(
        contract_name: string,
        last_block: number,
        get_json: boolean
    ): Promise<HyperionAbi | null> {
        try {
            const _includes = ["actions", "tables", "block"];
            if (get_json) {
                _includes.push("abi");
            } else {
                _includes.push("abi_hex");
            }
            const query = {
                bool: {
                    must: [
                        {term: {account: contract_name}},
                        {range: {block: {lte: last_block}}}
                    ]
                }
            };
            const queryResult: SearchResponse<any, any> = await this.client.search({
                index: `${this.chain}-abi-*`,
                size: 1, query,
                sort: [{block: {order: "desc"}}],
                _source: {includes: _includes}
            });

            console.log(queryResult);

            const results = queryResult.hits.hits;
            if (results.length > 0) {
                const nextRefResponse: SearchResponse<any, any> = await this.client.search({
                    index: `${this.chain}-abi-*`,
                    size: 1,
                    query: {
                        bool: {
                            must: [
                                {term: {account: contract_name}},
                                {range: {block: {gte: last_block}}}
                            ]
                        }
                    },
                    sort: [{block: {order: "asc"}}],
                    _source: {includes: ["block"]}
                });
                const nextRef = nextRefResponse.hits.hits;
                if (nextRef.length > 0) {
                    return {
                        valid_until: nextRef[0]._source.block,
                        ...results[0]._source
                    };
                }
                return results[0]._source;
            } else {
                return null;
            }
        } catch (e) {
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
        const info = {field, type, block, valid_until};
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
    async verifyLocalType(
        contract: string,
        type: string,
        block_num: number,
        field: string
    ): Promise<[boolean, string | undefined, number, number | undefined] | [boolean, string]> {

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

                    if (savedAbi.abi_hex) {
                        abiStatus = this.loadAbiHex(contract, savedAbi.block, savedAbi.abi_hex);
                    }

                    if (abiStatus) {
                        try {
                            resultType = this.getAbiDataType(field, contract, type);
                            // console.log(`getAbiDataType (2) ${type} (${field}) >>> "${resultType}"`);
                            abiStatus = true;
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
            abiStatus = await this.loadCurrentAbiHex(contract);
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

        return [abiStatus, resultType, valid_from, valid_until];
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

        const [_status, tableType, validFrom, validUntil] = await this.verifyLocalType(row['code'], row['table'], block, "table");

        if (_status && tableType) {
            let result: string;
            try {
                if (typeof row.value === 'string') {
                    result = this.abieos.hexToJson(row['code'], tableType, row.value);
                } else {
                    result = this.abieos.binToJson(row['code'], tableType, row.value);
                }
                row['data'] = result;
                delete row.value;
                return row;
            } catch (e) {
                debugLog(e);
            }
        }

        return await this.processContractRow(row, block, validFrom, validUntil);
    }

    async getContractAtBlock(accountName: string, block_num: number, check_action?: string) {
        let savedAbi, abi;
        savedAbi = await this.fetchAbiHexAtBlockElastic(accountName, block_num, true);
        if (savedAbi === null || (savedAbi.actions && !savedAbi.actions.includes(check_action))) {
            savedAbi = await this.getAbiFromHeadBlock(accountName);
            if (!savedAbi) return [null, null];
            abi = savedAbi.abi;
        } else {
            try {
                abi = JSON.parse(savedAbi.abi);
            } catch (e) {
                hLog(e);
                return [null, null];
            }
        }
        if (!abi) return [null, null];
        const initialTypes = Serialize.createInitialTypes();

        let types: Map<string, Serialize.Type> | undefined;

        try {

            types = Serialize.getTypesFromAbi(initialTypes, abi);

        } catch (e) {

            let remapped = false;
            for (const struct of abi.structs) {
                for (const field of struct.fields) {
                    if (abi_remapping[field.type]) {
                        field.type = abi_remapping[field.type];
                        remapped = true;
                    }
                }
            }

            if (remapped) {
                try {
                    types = Serialize.getTypesFromAbi(initialTypes, abi);
                } catch (e) {
                    hLog('failed after remapping abi');
                    hLog(accountName, block_num, check_action);
                    hLog(e);
                }
            } else {
                hLog(accountName, block_num);
                hLog(e);
            }
        }

        const actions = new Map();
        if (types) {
            for (const {name, type} of abi.actions) {
                actions.set(name, Serialize.getType(types, type));
            }
        }

        const result = {types, actions, tables: abi.tables};
        if (check_action) {
            if (actions.has(check_action)) {
                try {
                    this.abieos.loadAbi(accountName, JSON.stringify(abi));
                } catch (e) {
                    hLog(e);
                }
            }
        }
        return [result, abi];
    }

    async getTableType(code, table, block) {
        let abi, contract, abi_tables;

        try {
            const r = await this.getContractAtBlock(code, block);
            if (r) {
                [contract, abi] = r;
            }
            if (contract && contract.tables) {
                abi_tables = contract.tables
            } else {
                return;
            }
        } catch (e: any) {
            hLog(e.message);
            return;
        }

        let this_table, type;
        for (let t of abi_tables) {
            if (t.name === table) {
                this_table = t;
                break;
            }
        }
        if (this_table) {
            type = this_table.type;
        } else {
            const currentABI = await this.getAbiFromHeadBlock(code);
            if (!currentABI || !currentABI.abi) {
                return;
            }
            abi_tables = currentABI.abi.tables;
            for (let t of abi_tables) {
                if (t.name === table) {
                    this_table = t;
                    break;
                }
            }
            if (this_table) {
                type = this_table.type;
                const initialTypes = Serialize.createInitialTypes();
                contract.types = Serialize.getTypesFromAbi(initialTypes, currentABI.abi);
            } else {
                return;
            }
        }
        let cType = contract.types.get(type);
        if (!cType) {
            if (this.types.has(type)) {
                cType = this.types.get(type);
            } else {
                if (type === 'self_delegated_bandwidth') {
                    cType = contract.types.get('delegated_bandwidth')
                }
            }
            if (!cType) {
                hLog(code, block);
                hLog(`code:${code} | table:${table} | block:${block} | type:${type}`);
                hLog(Object.keys(contract));
                hLog(Object.keys(abi));
            }
        }
        return cType;
    }

    async processContractRow(row, block, validFrom, validUntil) {
        const row_sb = this.createSerialBuffer(Serialize.hexToUint8Array(row['value']));
        let error;
        try {
            const tableType: EOSJSType = await this.getTableType(row['code'], row['table'], block);
            if (tableType) {
                try {
                    row['data'] = tableType.deserialize(row_sb);
                    delete row.value;
                    return row;
                } catch (e: any) {
                    error = e.message;
                }
            }
        } catch (e: any) {
            hLog(e.message);
            error = e.message;
        }
        row['ds_error'] = true;
        process.send?.({
            event: 'ds_error',
            data: {
                type: 'delta_ds_error',
                block: block,
                valid_until: validUntil,
                code: row['code'],
                table: row['table'],
                message: error
            }
        });
        this.registerAutoBlacklist(row['code'], "table", row['table'], validFrom, validUntil);
        return row;
    }

    isAsync(fun) {
        return fun.constructor.name === 'AsyncFunction';
    }

    async processTableDelta(contractRowDelta: any) {

        if (contractRowDelta['table'] && contractRowDelta['data']) {
            contractRowDelta['primary_key'] = String(contractRowDelta['primary_key']);
            let allowIndex: boolean;
            let handled = false;

            const key = `${contractRowDelta.code}:${contractRowDelta.table}`;
            const key2 = `${contractRowDelta.code}:*`;
            const key3 = `*:${contractRowDelta.table}`;

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

    pushToDeltaStreamingQueue(payload, jsonRow) {
        if (this.allowStreaming && this.conf.features.streaming.deltas && this.ch) {
            this.ch.publish('', this.chain + ':stream', payload, {
                headers: {
                    event: 'delta',
                    code: jsonRow.code,
                    table: jsonRow.table,
                    scope: jsonRow.scope,
                    payer: jsonRow.payer
                }
            });
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

    pushToDynamicTableQueue(jsonRow) {
        if (this.allowedDynamicContracts.has(jsonRow.code)) {
            const doc = {
                '@timestamp': jsonRow['@timestamp'],
                table: jsonRow.table,
                scope: jsonRow.scope,
                primary_key: jsonRow.primary_key,
                payer: jsonRow.payer,
                block_num: jsonRow.block_num,
                block_id: jsonRow.block_id,
                fields: this.addTablePrefix(jsonRow.table, jsonRow.data)
            };
            this.preIndexingQueue.push({
                queue: this.chain + ":index_dynamic:" + (this.dyn_emit_idx),
                content: bufferFromJson(doc),
                headers: {
                    id: `${jsonRow.table}-${jsonRow.scope}-${jsonRow.primary_key}`,
                    code: jsonRow.code,
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

    async pushToDeltaQueue(bufferData: any, block_num) {
        const q = this.chain + ":index_deltas:" + (this.delta_emit_idx);
        await this.preIndexingQueue.push({
            queue: q,
            content: bufferData,
            headers: {block_num}
        });
        this.delta_emit_idx++;
        if (this.delta_emit_idx > this.conf.scaling.ad_idx_queues) {
            this.delta_emit_idx = 1;
        }
    }

    async pushToIndexQueue(data: any, type: string) {
        const q = this.chain + ":index_generic:" + (this.emit_idx);
        await this.preIndexingQueue.push({
            queue: q,
            content: bufferFromJson(data),
            headers: {type}
        });
        this.emit_idx++;
        if (this.emit_idx > this.conf.scaling.indexing_queues) {
            this.emit_idx = 1;
        }
    }

    private anyFromSender(gen_trx: any) {
        return this.chain + '::' + gen_trx.sender + '::*';
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

        "contract_row": async (payload, block_num, block_ts, row, block_id) => {

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

                        this.pushToDynamicTableQueue(jsonRow);

                        // check for plugin handlers
                        await this.mLoader.processDeltaData(jsonRow);

                        const buff = bufferFromJson(jsonRow);
                        if (process.env['live_mode'] === 'true') {
                            this.pushToDeltaStreamingQueue(buff, jsonRow);
                        }

                        if (typeof row.present !== "undefined") {
                            if (row.present === 0 && !this.conf.indexer.disable_delta_rm) {
                                if (this.ch_ready && this.ch) {
                                    this.ch.sendToQueue(this.deltaRemovalQueue, buff);
                                } else {
                                    hLog('Channel is not ready!');
                                }
                            } else {
                                await this.pushToDeltaQueue(buff, block_num);
                            }
                        }
                        this.temp_delta_counter++;
                    }
                }
            }
        },

        "account": async (account, block_num, block_ts) => {
            if (account['abi'] !== '') {
                try {
                    const abiHex = account['abi'];
                    const abiBin = new Uint8Array(Buffer.from(abiHex, 'hex'));
                    const initialTypes = Serialize.createInitialTypes();
                    const abiDefTypes: EOSJSType | undefined = Serialize.getTypesFromAbi(initialTypes, <Abi>AbiDefinitions).get('abi_def');
                    if (abiDefTypes) {
                        const abiObj = abiDefTypes.deserialize(this.createSerialBuffer(abiBin));
                        const jsonABIString = JSON.stringify(abiObj);
                        const abi_actions = abiObj.actions.map(a => a.name);
                        const abi_tables = abiObj.tables.map(t => t.name);
                        debugLog(`📝  New code for ${account['name']} at block ${block_num} with ${abi_actions.length} actions`);
                        const new_abi_object = {
                            '@timestamp': block_ts,
                            account: account['name'],
                            block: block_num,
                            abi: jsonABIString,
                            abi_hex: abiHex,
                            actions: abi_actions,
                            tables: abi_tables
                        };

                        debugLog(`[Worker ${process.env.worker_id}] read ${account['name']} ABI at block ${block_num}`);
                        const q = this.chain + ":index_abis:1";
                        await this.preIndexingQueue.push({queue: q, content: bufferFromJson(new_abi_object)});

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

        "permission_link": async (link, block_num, block_ts, row) => {
            if (!this.conf.indexer.abi_scan_mode && this.conf.indexer.process_deltas) {
                await this.pushToIndexQueue({
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

        "permission": async (perm, block_num, block_ts, row) => {
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

                await this.pushToIndexQueue({
                    block_num: block_num,
                    present: row.present,
                    ...perm
                }, 'permission');
            }
        },

        // "account_metadata": async (account_metadata, block_num, block_ts, row, block_id) => {
        //     console.log(account_metadata);
        //     if (account_metadata.code) {
        //         hLog(`new code hash ${account_metadata.code.code_hash} on ${account_metadata.name}`);
        //     }
        // },

        // Deferred Transactions
        "generated_transaction": async (generated_transaction: any, block_num, block_ts) => {
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

                const unpackedTrx = this.api.deserializeTransaction(Buffer.from(generated_transaction.packed_trx, 'hex'));
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
        "resource_limits": async (resource_limits, block_num, block_ts) => {
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

        "resource_usage": async (resource_usage, block_num, block_ts) => {
            if (!this.conf.indexer.abi_scan_mode && this.conf.indexer.process_deltas && this.conf.features.resource_usage) {
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
        "global_property": async (global_property, block_num: number, block_ts: string) => {
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

    async processDeltas(deltas: [string, TableDelta][], block_num: number, block_ts: string, block_id: string) {
        const deltaStruct = extractDeltaStruct(deltas);
        for (const key in deltaStruct) {
            if (this.deltaStructHandlers[key] && deltaStruct.hasOwnProperty(key)) {
                if (this.conf.indexer.abi_scan_mode && key !== 'account') {
                    continue;
                }
                if (deltaStruct[key].length > 0) {
                    for (const row of deltaStruct[key]) {
                        let data = this.deserializeNative(key, row.data);
                        if (!data) {
                            try {
                                const type = this.types.get(key);
                                if (type) {
                                    data = type.deserialize(
                                        new Serialize.SerialBuffer({
                                            textEncoder: this.txEnc,
                                            textDecoder: this.txDec,
                                            array: Buffer.from(row.data, 'hex')
                                        }),
                                        new Serialize.SerializerState({
                                            bytesAsUint8Array: true
                                        }));
                                }
                            } catch (e: any) {
                                hLog(`Delta struct [${key}] deserialization error: ${e.message}`);
                                hLog(row.data);
                            }
                        }

                        if (data) {
                            try {
                                // convert present boolean to byte (for pre-2.1 compatibility)
                                if (row.present === true) {
                                    row.present = 1;
                                } else if (row.present === false) {
                                    row.present = 0;
                                }
                                await this.deltaStructHandlers[key](data[1], block_num, block_ts, row, block_id);
                            } catch (e: any) {
                                hLog(`Delta struct [${key}] processing error: ${e.message}`);
                                hLog(e);
                                hLog(data[1]);
                            }
                        }
                    }
                }
            }
        }
    }

    deserializeNative(datatype: string, array: any): any {
        if (this.abi) {
            try {
                if (typeof array === 'string') {
                    return this.abieos.hexToJson("0", datatype, array);
                } else {
                    return this.abieos.binToJson("0", datatype, array);
                }
            } catch (e: any) {
                hLog('deserializeNative >>', datatype, '>>', e.message);
            }
            return null;
        }
    }

    async deserializeActionAtBlockNative(action: Action, block_num: number): Promise<any> {
        const [status, actionType] = await this.verifyLocalType(action.account, action.name, block_num, "action");
        if (status && actionType) {
            try {
                return this.abieos.binToJson(
                    action.account,
                    actionType,
                    Buffer.from(action.data, 'hex')
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
            await this.preIndexingQueue.push({
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
                await this.preIndexingQueue.push({
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
        }

        if (!this.conf.indexer.disable_indexing) {
            const q = this.chain + ":index_table_accounts:" + (this.tbl_acc_emit_idx);
            await this.preIndexingQueue.push({
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
        const EOSIO_ALIAS = this.conf.settings.eosio_alias;
        this.tableHandlers[EOSIO_ALIAS + ':voters'] = (delta: HyperionDelta) => {
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

        this.tableHandlers[EOSIO_ALIAS + ':global'] = (delta: HyperionDelta) => {
            delta['@global'] = delta['data'];
            delete delta['data'];
        };

        this.tableHandlers[EOSIO_ALIAS + ':producers'] = (delta: HyperionDelta) => {
            const data = delta['data'];
            if (data) {
                delta['@producers'] = {
                    total_votes: parseFloat(data['total_votes']),
                    is_active: data['is_active'],
                    unpaid_blocks: data['unpaid_blocks']
                };
                delete delta['data'];
            }
        };

        this.tableHandlers[EOSIO_ALIAS + ':userres'] = (delta: HyperionDelta) => {
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

        this.tableHandlers[EOSIO_ALIAS + ':delband'] = (delta: HyperionDelta) => {
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

        this.tableHandlers[EOSIO_ALIAS + '.msig:proposal'] = async (delta: HyperionDelta) => {
            // decode packed_transaction
            delta['@proposal'] = {
                proposal_name: delta['data']['proposal_name']
            };
            const trx = this.api.deserializeTransaction(Serialize.hexToUint8Array(delta.data['packed_transaction']));
            for (const action of trx.actions) {
                action.hex_data = action.data;
                action.data = await this.deserializeActionAtBlockNative(action, delta.block_num);
            }
            delta['@proposal']['transaction'] = trx;
            delete delta['data'];
        };

        this.tableHandlers[EOSIO_ALIAS + '.msig:approvals'] = (delta: HyperionDelta) => {
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

        this.tableHandlers[EOSIO_ALIAS + '.msig:approvals2'] = (delta: HyperionDelta) => {
            delta['@approvals'] = {
                proposal_name: delta['data']['proposal_name'],
                requested_approvals: delta['data']['requested_approvals'].map((item: any) => {
                    return {actor: item.level.actor, permission: item.level.permission, time: item.time};
                }),
                provided_approvals: delta['data']['provided_approvals'].map((item: any) => {
                    return {actor: item.level.actor, permission: item.level.permission, time: item.time};
                })
            };
            if (this.conf.features.tables.proposals) {
                this.storeProposal(delta);
            }
        };

        this.tableHandlers['simpleassets:sassets'] = (delta: HyperionDelta) => {
            if (delta.data) {
                if (delta.data.mdata) {
                    delta['@sassets'] = {
                        mdata_hash: createHash('sha256')
                            .update(delta.data.mdata)
                            .digest()
                            .toString('hex'),
                        author: delta.data.author,
                        id: delta.data.id,
                        category: delta.data.category
                    }
                }
            }
        }

        this.tableHandlers['*:accounts'] = (delta: HyperionDelta) => {

            if (!delta.data) {
                // attempt forced deserialization
                if (delta.value.length === 32) {
                    try {
                        debugLog(`Attempting forced deserialization for ${delta['code']}::accounts`);
                        const sb = new Serialize.SerialBuffer({
                            textDecoder: new TextDecoder(),
                            textEncoder: new TextEncoder(),
                            array: Buffer.from(delta['value'], 'hex'),
                        });
                        delta['data'] = {
                            balance: sb.getAsset()
                        };
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
