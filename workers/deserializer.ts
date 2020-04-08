import {HyperionWorker} from "./hyperionWorker";
import {Api} from "eosjs/dist";
import {ApiResponse} from "@elastic/elasticsearch";
import {AsyncCargo, AsyncQueue, cargo, queue} from 'async';
import * as AbiEOS from "@eosrio/node-abieos";
import {Serialize} from "../addons/eosjs-native";
import {Type} from "../addons/eosjs-native/eosjs-serialize";
import {hLog} from "../helpers/common_functions";

const index_queues = require('../definitions/index-queues').index_queues;
const {debugLog} = require("../helpers/functions");
const {AbiDefinitions} = require("../definitions/abi_def");
const abi_remapping = {
    "_Bool": "bool"
};

interface QueuePayload {
    queue: string;
    content: Buffer;
    headers?: any;
}

function extractDeltaStruct(deltas) {
    const deltaStruct = {};
    for (const table_delta of deltas) {
        if (table_delta[0] === "table_delta_v0") {
            deltaStruct[table_delta[1].name] = table_delta[1].rows;
        }
    }
    return deltaStruct;
}

export default class MainDSWorker extends HyperionWorker {

    ch_ready = false;
    private consumerQueue: AsyncCargo;
    private preIndexingQueue: AsyncQueue<QueuePayload>;
    private abi: any;
    private types: Map<string, Type>;
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
    tbl_acc_emit_idx = 1;
    tbl_vote_emit_idx = 1;
    tbl_prop_emit_idx = 1;
    delta_emit_idx = 1;
    temp_delta_counter = 0;
    private monitoringLoop: NodeJS.Timeout;

    constructor() {

        super();

        this.consumerQueue = cargo((payload, cb) => {
            this.processMessages(payload).then(() => {
                cb();
            }).catch((err) => {
                hLog('NACK ALL', err);
                if (this.ch_ready) {
                    this.ch.nackAll();
                }
            });
        }, this.conf.prefetch.block);

        this.preIndexingQueue = queue((data, cb) => {
            if (this.ch_ready) {
                this.ch.sendToQueue(data.queue, data.content, {headers: data.headers});
                cb();
            } else {
                hLog('Channel is not ready!');
            }
        }, 1);

        this.api = new Api({
            rpc: this.rpc,
            signatureProvider: null,
            chainId: this.chainId,
            textDecoder: this.txDec,
            textEncoder: this.txEnc,
        });

        this.populateTableHandlers();
    }

    async run(): Promise<void> {
        this.startReports();
        return undefined;
    }

    onIpcMessage(msg: any): void {
        switch (msg.event) {
            case 'initialize_abi': {
                this.abi = JSON.parse(msg.data);
                AbiEOS.load_abi("0", msg.data);
                const initialTypes = Serialize.createInitialTypes();
                this.types = Serialize.getTypesFromAbi(initialTypes, this.abi);
                this.abi.tables.map(table => this.tables.set(table.name, table.type));
                this.initConsumer();
                break;
            }
            case 'update_abi': {
                if (msg.abi) {
                    if (msg.abi.abi_hex) {
                        AbiEOS.load_abi_hex(msg.abi.account, msg.abi.abi_hex);
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
            default: {
                hLog('-----------> IPC Message <--------------');
                hLog(msg);
                hLog('----------------------------------------');
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
        }

        if (process.env['live_mode'] === 'false') {
            for (let i = 0; i < this.conf.scaling.ds_queues; i++) {
                this.ch.assertQueue(this.chain + ":blocks:" + (i + 1), {
                    durable: true
                });
            }
        }

        let qIdx = 0;
        index_queues.forEach((q) => {
            let n = this.conf.scaling.indexing_queues;
            if (q.type === 'abi') n = 1;
            qIdx = 0;
            for (let i = 0; i < n; i++) {
                let m = 1;
                if (q.type === 'action' || q.type === 'delta') {
                    m = this.conf.scaling.ad_idx_queues;
                }
                for (let j = 0; j < m; j++) {
                    this.ch.assertQueue(q.name + ":" + (qIdx + 1), {durable: true});
                    qIdx++;
                }
            }
        });

        this.initConsumer();
    }

    attachActionExtras(self, action) {
        self.mLoader.processActionData(action);
    }

    sendDsCounterReport() {
        // send ds counters
        if (this.temp_delta_counter > 0) {
            process.send({
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

    async processMessages(messages) {
        await this.mLoader.parser.parseMessage(this, messages);
    }

    private initConsumer() {
        if (this.ch_ready) {
            this.ch.prefetch(this.conf.prefetch.block);
            this.ch.consume(process.env['worker_queue'], (data) => {
                this.consumerQueue.push(data);
            });
        }
    }

    async processBlock(res, block, traces, deltas) {
        if (!res['this_block']) {
            // missing current block data
            hLog(res);
            return null;
        } else {
            let producer = '';
            let ts = '';
            const block_num = res['this_block']['block_num'];
            let block_ts = res['this_time'];
            let light_block;
            if (this.conf.indexer.fetch_block) {
                if (!block) {
                    return null;
                }
                producer = block['producer'];
                ts = block['timestamp'];
                block_ts = ts;

                // Collect total CPU and NET usage
                let total_cpu = 0;
                let total_net = 0;
                block.transactions.forEach((trx) => {
                    total_cpu += trx['cpu_usage_us'];
                    total_net += trx['net_usage_words'];
                });

                // const cpu_pct = ((total_cpu / 200000) * 100).toFixed(2);
                // const net_pct = ((total_net / 1048576) * 100).toFixed(2);
                // hLog(`Block: ${res['this_block']['block_num']} | CPU: ${total_cpu} μs (${cpu_pct} %) | NET: ${total_net} bytes (${net_pct} %)`);

                light_block = {
                    '@timestamp': block['timestamp'],
                    block_num: res['this_block']['block_num'],
                    producer: block['producer'],
                    new_producers: block['new_producers'],
                    schedule_version: block['schedule_version'],
                    cpu_usage: total_cpu,
                    net_usage: total_net
                };

                if (light_block.new_producers) {
                    process.send({
                        event: 'new_schedule',
                        block_num: light_block.block_num,
                        new_producers: light_block.new_producers,
                        live: process.env.live_mode
                    });
                }
            }

            // Process Delta Traces
            if (deltas && this.conf.indexer.process_deltas) {
                const t1 = Date.now();
                await this.processDeltas(deltas, block_num, block_ts);
                const elapsed_time = Date.now() - t1;
                if (elapsed_time > 1000) {
                    hLog(`[WARNING] Delta processing took ${elapsed_time} ms on block ${block_num}`);
                }
            }

            // Process Action Traces
            let _traces = traces;
            if (traces["valueForKeyPath"]) {
                _traces = traces['valueForKeyPath'](".");
            }
            if (_traces.length > 0 && this.conf.indexer.fetch_traces) {
                const t2 = Date.now();
                for (const trace of _traces) {
                    const transaction_trace = trace[1];
                    if (transaction_trace.action_traces.length > 0) {
                        // route trx trace to pool based on first action

                        if (this.conf.indexer.max_inline && transaction_trace.action_traces.length > this.conf.indexer.max_inline) {
                            transaction_trace.action_traces = transaction_trace.action_traces.slice(0, this.conf.indexer.max_inline);
                        }

                        this.routeToPool(transaction_trace, {block_num, producer, ts});
                    } else {
                        // hLog(transaction_trace, transaction_trace.partial[1].transaction_extensions);
                    }
                }
                const traces_elapsed_time = Date.now() - t2;
                if (traces_elapsed_time > 10) {
                    debugLog(`[WARNING] Traces processing took ${traces_elapsed_time}ms on block ${block_num}`);
                }
            }

            // Send light block to indexer
            if (this.conf.indexer.fetch_block) {
                this.pushToBlocksQueue(light_block);
            }
            return {block_num: res['this_block']['block_num'], size: traces.length};
        }
    }

    pushToBlocksQueue(light_block) {
        if (!this.conf.indexer.disable_indexing) {
            const data = Buffer.from(JSON.stringify(light_block));
            const q = this.chain + ":index_blocks:" + (this.block_emit_idx);
            this.preIndexingQueue.push({
                queue: q,
                content: data
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
        if (trace['action_traces'][0].length === 2) {
            first_action = trace['action_traces'][0][1];
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
            if (!this.checkWhitelist(first_action.act)) {
                return false;
            }
        }

        let selected_q = 0;
        const _code = first_action.act.account;
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
        const pool_queue = `${this.chain}:ds_pool:${selected_q}`;
        // hLog('sent to ->', pool_queue);
        if (this.ch_ready) {
            this.ch.sendToQueue(pool_queue, Buffer.from(JSON.stringify(trace)), {headers});
            return true;
        } else {
            return false;
        }
    }

    createSerialBuffer(inputArray) {
        return new Serialize.SerialBuffer({textEncoder: this.txEnc, textDecoder: this.txDec, array: inputArray});
    }

    async fetchAbiHexAtBlockElastic(contract_name, last_block, get_json) {
        try {
            const _includes = ["actions", "tables"];
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
            const queryResult: ApiResponse = await this.client.search({
                index: `${this.chain}-abi-*`,
                body: {
                    size: 1, query,
                    sort: [{block: {order: "desc"}}],
                    _source: {includes: _includes}
                }
            });
            const results = queryResult.body.hits.hits;
            return results.length > 0 ? results[0]._source : null;
        } catch (e) {
            hLog(e);
            return null;
        }
    }

    async verifyLocalType(contract, type, block_num, field) {
        let _status;
        let resultType;
        try {
            resultType = AbiEOS['get_type_for_' + field](contract, type);
            _status = true;
        } catch {
            _status = false;
        }
        if (!_status) {
            const savedAbi = await this.fetchAbiHexAtBlockElastic(contract, block_num, false);
            if (savedAbi) {
                if (savedAbi[field + 's'].includes(type)) {
                    if (savedAbi.abi_hex) {
                        _status = AbiEOS.load_abi_hex(contract, savedAbi.abi_hex);
                    }
                    if (_status) {
                        try {
                            resultType = AbiEOS['get_type_for_' + field](contract, type);
                            _status = true;
                            return [_status, resultType];
                        } catch (e) {
                            hLog(`(abieos/cached) >> ${e.message}`);
                            _status = false;
                        }
                    }
                }
            }
            const currentAbi = await this.rpc.getRawAbi(contract);
            if (currentAbi.abi.byteLength > 0) {
                const abi_hex = Buffer.from(currentAbi.abi).toString('hex');
                _status = AbiEOS.load_abi_hex(contract, abi_hex);
            } else {
                _status = false;
            }
            if (_status === true) {
                try {
                    resultType = AbiEOS['get_type_for_' + field](contract, type);
                    _status = true;
                } catch (e) {
                    // hLog(`(abieos/current) >> ${e.message}`);
                    _status = false;
                }
            }
        }
        return [_status, resultType];
    }

    async processContractRowNative(row, block) {
        const [_status, tableType] = await this.verifyLocalType(row['code'], row['table'], block, "table");
        if (_status) {
            let result;
            try {
                if (typeof row.value === 'string') {
                    result = AbiEOS.hex_to_json(row['code'], tableType, row.value);
                } else {
                    result = AbiEOS.bin_to_json(row['code'], tableType, row.value);
                }
                row['data'] = result;
                delete row.value;
                return row;
            } catch {
            }
        }
        return await this.processContractRow(row, block);
        ;
    }

    async getAbiFromHeadBlock(code) {
        let _abi;
        try {
            _abi = (await this.rpc.get_abi(code)).abi;
        } catch (e) {
            hLog(e);
        }
        return {abi: _abi, valid_until: null, valid_from: null};
    }

    async getContractAtBlock(accountName: string, block_num: number, check_action?: string) {
        let savedAbi, abi;
        savedAbi = await this.fetchAbiHexAtBlockElastic(accountName, block_num, true);
        if (savedAbi === null || !savedAbi.actions.includes(check_action)) {
            savedAbi = await this.getAbiFromHeadBlock(accountName);
            if (!savedAbi) return null;
            abi = savedAbi.abi;
        } else {
            try {
                abi = JSON.parse(savedAbi.abi);
            } catch (e) {
                hLog(e);
                return null;
            }
        }
        if (!abi) return null;
        const initialTypes = Serialize.createInitialTypes();
        let types;
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
        for (const {name, type} of abi.actions) {
            actions.set(name, Serialize.getType(types, type));
        }
        const result = {types, actions, tables: abi.tables};
        if (check_action) {
            if (actions.has(check_action)) {
                try {
                    AbiEOS['load_abi'](accountName, JSON.stringify(abi));
                } catch (e) {
                    hLog(e);
                }
            }
        }
        return [result, abi];
    }

    async getTableType(code, table, block) {
        let abi, contract, abi_tables;
        [contract, abi] = await this.getContractAtBlock(code, block);
        if (!contract.tables) {
            // abi = (await this.getAbiAtBlock(code, block)).abi;
            // abi_tables = abi.tables;
            return;
        } else {
            abi_tables = contract.tables
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
            // console.error(`Could not find table "${table}" in the abi for ${code} at block ${block}`);
            // retry with the current abi
            const currentABI = await this.getAbiFromHeadBlock(code);
            if (!currentABI) {
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

    async processContractRow(row, block) {
        const row_sb = this.createSerialBuffer(Serialize.hexToUint8Array(row['value']));
        const tableType: Type = await this.getTableType(row['code'], row['table'], block);
        let error;
        if (tableType) {
            try {
                row['data'] = tableType.deserialize(row_sb);
                delete row.value;
                return row;
            } catch (e) {
                error = e.message;
            }
        }

        process.send({
            event: 'ds_error',
            data: {
                type: 'delta_ds_error',
                block: block,
                code: row['code'],
                table: row['table'],
                message: error
            }
        });

        return row;
    }

    async processTableDelta(data) {
        if (data['table']) {
            data['primary_key'] = String(data['primary_key']);
            let allowIndex;
            let handled = false;
            const key = `${data.code}:${data.table}`;
            if (this.tableHandlers[key]) {
                await this.tableHandlers[key](data);
                handled = true;
            }
            if (this.tableHandlers[`${data.code}:*`]) {
                await this.tableHandlers[`${data.code}:*`](data);
                handled = true;
            }
            if (this.tableHandlers[`*:${data.table}`]) {
                await this.tableHandlers[`*:${data.table}`](data);
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

    async processDeltaContractRow(row, block_num, block_ts) {
        try {
            const payload = this.deserializeNative('contract_row', row.data)[1];
            payload['@timestamp'] = block_ts;
            payload['present'] = row.present;
            payload['block_num'] = block_num;

            if (this.conf.features.index_all_deltas || (payload.code === this.conf.settings.eosio_alias || payload.table === 'accounts')) {
                const jsonRow = await this.processContractRowNative(payload, block_num);
                if (jsonRow) {
                    const indexableData = await this.processTableDelta(jsonRow);
                    if (indexableData) {
                        if (!this.conf.indexer.disable_indexing && this.conf.features.index_deltas) {
                            const payload = Buffer.from(JSON.stringify(jsonRow));
                            this.pushToDeltaQueue(payload);
                            this.temp_delta_counter++;
                            this.pushToDeltaStreamingQueue(payload, jsonRow);
                        }
                    }
                }
            }
        } catch (e) {
            hLog(block_num, e);
        }
    }

    pushToDeltaStreamingQueue(payload, jsonRow) {
        if (this.allowStreaming && this.conf.features.streaming.deltas) {
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

    pushToDeltaQueue(bufferdata) {
        const q = this.chain + ":index_deltas:" + (this.delta_emit_idx);
        this.preIndexingQueue.push({queue: q, content: bufferdata});
        this.delta_emit_idx++;
        if (this.delta_emit_idx > (this.conf.scaling.indexing_queues * this.conf.scaling.ad_idx_queues)) {
            this.delta_emit_idx = 1;
        }
    }

    pushToIndexQueue(data: any, type: string) {
        const q = this.chain + ":index_generic:" + (this.emit_idx);
        this.preIndexingQueue.push({
            queue: q,
            content: Buffer.from(JSON.stringify(data)),
            headers: {type}
        });
        this.emit_idx++;
        if (this.emit_idx > this.conf.scaling.indexing_queues) {
            this.emit_idx = 1;
        }
    }

    async processDeltas(deltas, block_num, block_ts) {
        const deltaStruct = extractDeltaStruct(deltas);

        // if (Object.keys(deltaStruct).length > 4) {
        //     hLog(Object.keys(deltaStruct));
        // }

        // Check account deltas for ABI changes
        if (deltaStruct['account']) {
            const rows = deltaStruct['account'];
            for (const account_raw of rows) {
                const data = this.deserializeNative('account', account_raw.data);
                const account = data[1];
                if (account['abi'] !== '') {
                    try {
                        const abiHex = account['abi'];
                        const abiBin = new Uint8Array(Buffer.from(abiHex, 'hex'));
                        const initialTypes = Serialize.createInitialTypes();
                        const abiDefTypes: Type = Serialize.getTypesFromAbi(initialTypes, AbiDefinitions).get('abi_def');
                        const abiObj = abiDefTypes.deserialize(this.createSerialBuffer(abiBin));
                        const jsonABIString = JSON.stringify(abiObj);
                        const abi_actions = abiObj.actions.map(a => a.name);
                        const abi_tables = abiObj.tables.map(t => t.name);
                        hLog(`📝  New code for ${account['name']} at block ${block_num} with ${abi_actions.length} actions`);
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
                        this.preIndexingQueue.push({
                            queue: q,
                            content: Buffer.from(JSON.stringify(new_abi_object))
                        });

                        // update locally cached abi
                        if (process.env['live_mode'] === 'true') {
                            hLog('Abi changed during live mode, updating local version...');
                            const abi_update_status = AbiEOS['load_abi_hex'](account['name'], abiHex);
                            if (!abi_update_status) {
                                hLog(`Reload status: ${abi_update_status}`);
                            }
                        }

                        process.send({
                            event: 'save_abi',
                            data: new_abi_object,
                            live_mode: process.env['live_mode'],
                            worker_id: process.env.worker_id
                        });

                    } catch (e) {
                        hLog(e);
                        hLog(account['abi'], block_num, account['name']);
                    }
                } else {
                    if (account.name === 'eosio') {
                        hLog(`---------- ${block_num} ----------------`);
                        hLog(account);
                    }
                }
            }
        }

        if (!this.conf.indexer.abi_scan_mode && this.conf.indexer.process_deltas) {

            // // Generated transactions
            // if (process.env.PROCESS_GEN_TX === 'true') {
            //     if (deltaStruct['generated_transaction']) {
            //         const rows = deltaStruct['generated_transaction'];
            //         for (const gen_trx of rows) {
            //             const serialBuffer = createSerialBuffer(gen_trx.data);
            //             const data = types.get('generated_transaction').deserialize(serialBuffer);
            //             await processDeferred(data[1], block_num);
            //         }
            //     }
            // }

            // Contract Rows
            if (deltaStruct['contract_row']) {
                for (const row of deltaStruct['contract_row']) {
                    await this.processDeltaContractRow(row, block_num, block_ts);
                }
            }

            if (deltaStruct['permission_link']) {
                if (deltaStruct['permission_link'].length > 0) {
                    for (const link of deltaStruct['permission_link']) {
                        const data = this.deserializeNative('permission_link', link.data);
                        const payload = {
                            "@timestamp": block_ts,
                            block_num: block_num,
                            present: link.present,
                            account: data[1].account,
                            code: data[1].code,
                            action: data[1]['message_type'],
                            permission: data[1]['required_permission']
                        };
                        this.pushToIndexQueue(payload, 'permission_link');
                    }
                }
            }

            // if (deltaStruct['permission']) {
            //     if (deltaStruct['permission'].length > 0) {
            //         for (const permission of deltaStruct['permission']) {
            //             const serialBuffer = createSerialBuffer(permission.data);
            //             const data = types.get('permission').deserialize(serialBuffer);
            //             hLog(prettyjson.render(data));
            //         }
            //     }
            // }

            // if (deltaStruct['contract_index64']) {
            //     if (deltaStruct['contract_index64'].length > 0) {
            //         for (const contract_index64 of deltaStruct['contract_index64']) {
            //             const serialBuffer = createSerialBuffer(contract_index64.data);
            //             const data = types.get('contract_index64').deserialize(serialBuffer);
            //             hLog(prettyjson.render(data));
            //         }
            //     }
            // }
            //
            // if (deltaStruct['contract_index128']) {
            //     if (deltaStruct['contract_index128'].length > 0) {
            //         for (const contract_index128 of deltaStruct['contract_index128']) {
            //             const serialBuffer = createSerialBuffer(contract_index128.data);
            //             const data = types.get('contract_index128').deserialize(serialBuffer);
            //             hLog(prettyjson.render(data));
            //         }
            //     }
            // }

            // if (deltaStruct['account_metadata']) {
            //     if (deltaStruct['account_metadata'].length > 0) {
            //         for (const account_metadata of deltaStruct['account_metadata']) {
            //             const serialBuffer = createSerialBuffer(account_metadata.data);
            //             const data = types.get('account_metadata').deserialize(serialBuffer);
            //             hLog(prettyjson.render(data));
            //         }
            //     }
            // }

            // if (deltaStruct['resource_limits']) {
            //     if (deltaStruct['resource_limits'].length > 0) {
            //         for (const resource_limits of deltaStruct['resource_limits']) {
            //             const serialBuffer = createSerialBuffer(resource_limits.data);
            //             const data = types.get('resource_limits').deserialize(serialBuffer);
            //             hLog(prettyjson.render(data));
            //         }
            //     }
            // }

            // if (deltaStruct['resource_usage']) {
            //     if (deltaStruct['resource_usage'].length > 0) {
            //         for (const resource_usage of deltaStruct['resource_usage']) {
            //             const serialBuffer = createSerialBuffer(resource_usage.data);
            //             const data = types.get('resource_usage').deserialize(serialBuffer);
            //             hLog(prettyjson.render(data));
            //         }
            //     }
            // }

            // if (deltaStruct['resource_limits_state']) {
            //     if (deltaStruct['resource_limits_state'].length > 0) {
            //         for (const resource_limits_state of deltaStruct['resource_limits_state']) {
            //             const serialBuffer = createSerialBuffer(resource_limits_state.data);
            //             const data = types.get('resource_limits_state').deserialize(serialBuffer);
            //             hLog(prettyjson.render(data));
            //         }
            //     }
            // }

            // if (deltaStruct['contract_table']) {
            //     if (deltaStruct['contract_table'].length > 0) {
            //         for (const contract_table of deltaStruct['contract_table']) {
            //             const serialBuffer = createSerialBuffer(contract_table.data);
            //             const data = types.get('contract_table').deserialize(serialBuffer);
            //             hLog(prettyjson.render(data));
            //         }
            //     }
            // }
        }
    }

    deserializeNative(datatype: string, array: any): any {
        try {
            const parser = typeof array === 'string' ? 'hex_to_json' : 'bin_to_json';
            return AbiEOS[parser]("0", datatype, array);
        } catch (e) {
            hLog(e);
        }
        return null;
    }

    async deserializeActionAtBlockNative(_action, block_num): Promise<any> {
        const [_status, actionType] = await this.verifyLocalType(_action.account, _action.name, block_num, "action");
        if (_status) {
            try {
                return AbiEOS.bin_to_json(_action.account, actionType, Buffer.from(_action.data, 'hex'));
            } catch (e) {
                hLog(e);
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
            executed: data.present === false,
            primary_key: data['primary_key'],
            block_num: data['block_num']
        };
        // if (proposalDoc.executed) {
        //     hLog(proposalDoc);
        // }
        if (!this.conf.indexer.disable_indexing) {
            const q = this.chain + ":index_table_proposals:" + (this.tbl_prop_emit_idx);
            this.preIndexingQueue.push({
                queue: q,
                content: Buffer.from(JSON.stringify(proposalDoc))
            });
            this.tbl_prop_emit_idx++;
            if (this.tbl_prop_emit_idx > (this.conf.scaling.indexing_queues)) {
                this.tbl_prop_emit_idx = 1;
            }
        }
    }

    async storeVoter(data) {
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
            this.preIndexingQueue.push({
                queue: q,
                content: Buffer.from(JSON.stringify(voterDoc))
            });
            this.tbl_vote_emit_idx++;
            if (this.tbl_vote_emit_idx > (this.conf.scaling.indexing_queues)) {
                this.tbl_vote_emit_idx = 1;
            }
        }
    }

    async storeAccount(data) {
        const accountDoc = {
            "code": data['code'],
            "scope": data['scope'],
            "primary_key": data['primary_key'],
            "block_num": data['block_num']
        };
        if (data['@accounts']) {
            accountDoc['amount'] = data['@accounts']['amount'];
            accountDoc['symbol'] = data['@accounts']['symbol'];
        }
        if (!this.conf.indexer.disable_indexing) {
            const q = this.chain + ":index_table_accounts:" + (this.tbl_acc_emit_idx);
            this.preIndexingQueue.push({
                queue: q,
                content: Buffer.from(JSON.stringify(accountDoc))
            });
            this.tbl_acc_emit_idx++;
            if (this.tbl_acc_emit_idx > (this.conf.scaling.indexing_queues)) {
                this.tbl_acc_emit_idx = 1;
            }
        }
    }

    private populateTableHandlers() {
        const EOSIO_ALIAS = this.conf.settings.eosio_alias;

        this.tableHandlers[EOSIO_ALIAS + ':voters'] = async (delta) => {
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
            delta['@voters']['staked'] = parseInt(delta.data['staked'], 10) / 10000;
            delete delta.data['staked'];
            if (this.conf.features.tables.voters) {
                await this.storeVoter(delta);
            }
        };

        this.tableHandlers[EOSIO_ALIAS + ':global'] = async (delta) => {
            const data = delta['data'];
            delta['@global'] = {
                last_name_close: data['last_name_close'],
                last_pervote_bucket_fill: data['last_pervote_bucket_fill'],
                last_producer_schedule_update: data['last_producer_schedule_update'],
                perblock_bucket: parseFloat(data['perblock_bucket']) / 10000,
                pervote_bucket: parseFloat(data['perblock_bucket']) / 10000,
                total_activated_stake: parseFloat(data['total_activated_stake']) / 10000,
                total_producer_vote_weight: parseFloat(data['total_producer_vote_weight']),
                total_ram_kb_reserved: parseFloat(data['total_ram_bytes_reserved']) / 1024,
                total_ram_stake: parseFloat(data['total_ram_stake']) / 10000,
                total_unpaid_blocks: data['total_unpaid_blocks']
            };
            delete delta['data'];
        };

        this.tableHandlers[EOSIO_ALIAS + ':producers'] = async (delta) => {
            const data = delta['data'];
            delta['@producers'] = {
                total_votes: parseFloat(data['total_votes']),
                is_active: data['is_active'],
                unpaid_blocks: data['unpaid_blocks']
            };
            delete delta['data'];
        };

        this.tableHandlers[EOSIO_ALIAS + ':userres'] = async (delta) => {
            const data = delta['data'];
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
        };

        this.tableHandlers[EOSIO_ALIAS + ':delband'] = async (delta) => {
            const data = delta['data'];
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
            // hLog(delta);
        };

        this.tableHandlers[EOSIO_ALIAS + '.msig:proposal'] = async (delta) => {
            // decode packed_transaction
            delta['@proposal'] = {
                proposal_name: delta['data']['proposal_name']
            };
            const trx = this.api.deserializeTransaction(Serialize.hexToUint8Array(delta.data['packed_transaction']));
            for (const action of trx.actions) {
                action['hex_data'] = action['data'];
                action['data'] = await this.deserializeActionAtBlockNative(action, delta.block_num);
            }
            delta['@proposal']['transaction'] = trx;
            delete delta['data'];
        };

        this.tableHandlers[EOSIO_ALIAS + '.msig:approvals'] = async (delta) => {
            delta['@approvals'] = {
                proposal_name: delta['data']['proposal_name'],
                requested_approvals: delta['data']['requested_approvals'],
                provided_approvals: delta['data']['provided_approvals']
            };
            delete delta['data'];
            if (this.conf.features.tables.proposals) {
                await this.storeProposal(delta);
            }
        };

        this.tableHandlers[EOSIO_ALIAS + '.msig:approvals2'] = async (delta) => {
            delta['@approvals'] = {
                proposal_name: delta['data']['proposal_name'],
                requested_approvals: delta['data']['requested_approvals'].map((item) => {
                    return {actor: item.level.actor, permission: item.level.permission, time: item.time};
                }),
                provided_approvals: delta['data']['provided_approvals'].map((item) => {
                    return {actor: item.level.actor, permission: item.level.permission, time: item.time};
                })
            };
            if (this.conf.features.tables.proposals) {
                await this.storeProposal(delta);
            }
        };

        this.tableHandlers['*:accounts'] = async (delta) => {
            if (typeof delta['data']['balance'] === 'string') {
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
                await this.storeAccount(delta);
            }
        };
    }
}
