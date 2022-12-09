import {HyperionWorker} from "./hyperionWorker";
import {cargo, queue} from "async";
import * as AbiEOS from "@eosrio/node-abieos";
import {Serialize} from "../addons/eosjs-native";
import {debugLog, hLog} from "../helpers/common_functions";
import {Message} from "amqplib";
import {parseDSPEvent} from "../modules/custom/dsp-parser";
import {join, resolve} from "path";
import {existsSync, readdirSync, readFileSync} from "fs";
import flatstr from 'flatstr';
import IORedis from "ioredis";

const abi_remapping = {
    "_Bool": "bool",
    "account_name": "name",
};

interface CustomAbiDef {
    abi: string;
    startingBlock: number;
    endingBlock: number;
}

function cleanActionTrace(t: any) {
    try {
        if (t.return_value === '') {
            delete t.return_value;
        }
        if (t.context_free === false) {
            delete t.context_free;
        }
        if (t.elapsed === '0') {
            delete t.elapsed;
        }

        // remove act_digest from grouped receipts since it was written to the action
        if (t.receipts && t.receipts.length > 0) {
            t.act_digest = t.receipts[0].act_digest;
            for (let receipt of t.receipts) {
                delete receipt.act_digest;
            }
        } else {
            delete t.receipts;
        }

        delete t.console;
        delete t.receiver;

        // onblock action case
        if (t.signatures && t.signatures.length === 0) {
            delete t.signatures;
        }

        if (t.inline_count === 0) {
            delete t.inline_count;
        }

        if (t.net_usage_words === 0) {
            delete t.net_usage_words;
        }
    } catch (e) {
        console.log(e);
    }
}

export default class DSPoolWorker extends HyperionWorker {

    abi;
    types;
    tables = new Map();
    ch_ready;
    local_queue;
    consumerQueue;
    preIndexingQueue;
    temp_ds_counter = 0;
    act_emit_idx = 1;
    allowStreaming = false;
    // common functions
    common;
    totalHits = 0;
    // contract usage map (temporary)
    contractUsage = {};
    contracts = new Map();
    monitoringLoop: NodeJS.Timeout;
    actionDsCounter = 0;

    customAbiMap: Map<string, CustomAbiDef[]> = new Map();
    private noActionCounter = 0;

    // tx caching layer
    private readonly ioRedisClient: IORedis.Redis;
    txCacheExpiration = 3600;

    constructor() {
        super();

        this.ioRedisClient = new IORedis(this.manager.conn.redis);
        if (this.conf.api.tx_cache_expiration_sec) {
            if (typeof this.conf.api.tx_cache_expiration_sec === 'string') {
                this.txCacheExpiration = parseInt(this.conf.api.tx_cache_expiration_sec, 10);
            } else {
                this.txCacheExpiration = this.conf.api.tx_cache_expiration_sec;
            }
        }

        this.consumerQueue = cargo((payload: any[], cb) => {
            this.processMessages(payload).catch((err) => {
                hLog('NackAll:', err);
                if (this.ch_ready) {
                    try {
                        this.ch.nackAll();
                    } catch (e) {
                        hLog(e.message);
                    }
                }
            }).finally(() => {
                cb();
            });
        }, this.conf.prefetch.block);

        this.preIndexingQueue = queue((data: any, cb) => {
            if (this.ch_ready) {
                try {
                    this.ch.sendToQueue(data.queue, data.content, {headers: data.headers});
                } catch (e) {
                    hLog(e.message);
                }
                cb();
            } else {
                hLog('Channel is not ready!');
            }
        }, 1);

        this.processCustomABI();

        // Define Common Functions
        this.common = {
            attachActionExtras: this.attachActionExtras,
            deserializeActionAtBlockNative: this.deserializeActionAtBlockNative
        }
    }

    processCustomABI() {
        if (this.conf.settings.allow_custom_abi) {

            if (!this.customAbiMap) {
                this.customAbiMap = new Map<string, CustomAbiDef[]>();
            }

            const dir = join(resolve(), "custom-abi", this.chain);
            if (existsSync(dir)) {
                const files = readdirSync(dir);
                for (const abiFile of files) {
                    try {
                        const [code, startingBlock, suffix] = abiFile.split("-");
                        const endingBlock = suffix.split(".")[0];
                        hLog(`Custom ABI for ${code} from ${startingBlock} up to ${endingBlock}`);
                        const parsedAbi = readFileSync(join(dir, abiFile)).toString();
                        const def: CustomAbiDef = {
                            abi: parsedAbi,
                            startingBlock: parseInt(startingBlock),
                            endingBlock: parseInt(endingBlock)
                        };

                        if (!this.customAbiMap.has(code)) {
                            this.customAbiMap.set(code, [def]);
                        } else {
                            this.customAbiMap.get(code).push(def);
                        }

                    } catch (e) {
                        hLog(e);
                    }
                }
            }
        }
    }

    attachActionExtras(self, action) {
        self.mLoader.processActionData(action);
    }

    recordContractUsage(code) {
        this.totalHits++;
        if (this.contractUsage[code]) {
            this.contractUsage[code]++;
        } else {
            this.contractUsage[code] = 1;
        }
    }

    async fetchAbiHexAtBlockElastic(contract_name, last_block, get_json, fetch_offset: number) {
        try {
            const _includes = ["block", "actions", "tables"];
            if (get_json) {
                _includes.push("abi");
            } else {
                _includes.push("abi_hex");
            }
            // const t_start = process.hrtime.bigint();
            const queryResult = await this.client.search({
                index: `${this.chain}-abi-*`,
                body: {
                    size: 1 + fetch_offset,
                    query: {
                        bool: {
                            must: [
                                {term: {account: contract_name}},
                                {range: {block: {lte: last_block}}}
                            ]
                        }
                    },
                    sort: [{block: {order: "desc"}}],
                    _source: {includes: _includes}
                }
            });
            // const t_end = process.hrtime.bigint();
            const results = queryResult.body.hits.hits;
            // const duration = (Number(t_end - t_start) / 1000 / 1000).toFixed(2);
            if (results.length > 0) {
                // hLog(`fetch abi from elastic took: ${duration} ms`);
                return results[fetch_offset]._source;
            } else {
                return null;
            }
        } catch (e) {
            hLog(e);
            return null;
        }
    }

    // noinspection JSUnusedGlobalSymbols
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

            if (this.conf.settings.allow_custom_abi) {
                if (this.customAbiMap.has(contract)) {
                    const list = this.customAbiMap.get(contract);
                    const matchingAbi = list.find(entry => {
                        return entry.startingBlock < block_num && entry.endingBlock > block_num;
                    });
                    if (matchingAbi.abi) {
                        _status = AbiEOS.load_abi(contract, matchingAbi.abi);
                    }
                }
            }


            if (!_status) {
                const savedAbi = await this.fetchAbiHexAtBlockElastic(contract, block_num, false, 0);
                if (savedAbi) {
                    if (savedAbi[field + 's'] && savedAbi[field + 's'].includes(type)) {
                        if (savedAbi.abi_hex) {
                            _status = this.loadAbiHex(contract, savedAbi.block, savedAbi.abi_hex);
                        }
                    }
                }
            }

            // successful load from ES cache
            if (_status) {
                try {
                    resultType = AbiEOS['get_type_for_' + field](contract, type);
                    _status = true;
                    return [_status, resultType];
                } catch (e) {
                    debugLog(`(abieos/cached) >> ${e.message}`);
                    _status = false;
                }
            }


            _status = await this.loadCurrentAbiHex(contract);

            if (_status === true) {
                try {
                    resultType = AbiEOS['get_type_for_' + field](contract, type);
                    _status = true;
                } catch (e) {
                    debugLog(`(abieos/current) >> ${e.message}`);
                    _status = false;
                }
            }
        }
        return [_status, resultType];
    }

    async deserializeActionAtBlockNative(self, _action, block_num): Promise<any> {
        self.recordContractUsage(_action.account);
        const [_status, actionType] = await self.verifyLocalType(_action.account, _action.name, block_num, "action");
        if (_status) {
            try {
                return AbiEOS.bin_to_json(_action.account, actionType, Buffer.from(_action.data, 'hex'));
            } catch (e) {
                debugLog(`(abieos) ${_action.account}::${_action.name} @ ${block_num} >>> ${e.message}`);
            }
        }
        return self.deserializeActionAtBlock(_action, block_num);
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

    async getContractAtBlock(accountName, block_num, check_action) {
        if (this.contracts.has(accountName)) {
            let _sc = this.contracts.get(accountName);
            if ((_sc['valid_until'] > block_num && block_num > _sc['valid_from']) || _sc['valid_until'] === -1) {
                if (_sc['contract'].actions.has(check_action)) {
                    hLog('cached abi');
                    return [_sc['contract'], null];
                }
            }
        }
        let savedAbi, abi;
        savedAbi = await this.fetchAbiHexAtBlockElastic(accountName, block_num, true, 0);
        if (savedAbi === null || (savedAbi.actions && !savedAbi.actions.includes(check_action))) {
            savedAbi = await this.getAbiFromHeadBlock(accountName);
            if (!savedAbi) {
                return null;
            }
            abi = savedAbi.abi;
        } else {
            try {
                abi = JSON.parse(savedAbi.abi);
            } catch (e) {
                hLog('failed to parse abi at getContractAtBlock --> ' + e.message);
                return null;
            }
        }

        if (!abi) {
            return null;
        }

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
                hLog(e.message);
            }
        }

        if (!types) {
            return null;
        }

        const actions = new Map();
        for (const {name, type} of abi.actions) {
            try {
                actions.set(name, Serialize.getType(types, type));
            } catch {
            }
        }

        const result = {types, actions, tables: abi.tables};
        if (check_action) {
            if (actions.has(check_action)) {
                if (!this.failedAbiMap.has(accountName) || !this.failedAbiMap.get(accountName).has(-1)) {
                    try {
                        AbiEOS.load_abi(accountName, JSON.stringify(abi));
                    } catch (e) {
                        hLog(e);
                    }
                } else {
                    debugLog('ignore reloading of current abi for', accountName);
                }
                this.contracts.set(accountName, {
                    contract: result,
                    valid_until: savedAbi.valid_until,
                    valid_from: savedAbi.valid_from
                });
            }
        }
        return [result, abi];
    }

    async deserializeActionAtBlock(action, block_num) {
        const contract = await this.getContractAtBlock(action.account, block_num, action.name);
        if (contract) {
            if (contract[0].actions.has(action.name)) {
                try {
                    return Serialize.deserializeAction(
                        contract[0],
                        action.account,
                        action.name,
                        action.authorization,
                        action.data,
                        this.txEnc,
                        this.txDec
                    ).data;
                } catch (e) {
                    debugLog(`(eosjs) ${action.account}::${action.name} @ ${block_num} >>> ${e.message}`);
                    return null;
                }
            } else {
                return null;
            }
        } else {
            return null;
        }
    }

    async processMessages(msg_array: Message[]) {
        for (const data of msg_array) {
            const parsedData = JSON.parse(Buffer.from(data.content).toString());
            await this.processTraces(parsedData, data.properties.headers);
            // ack message
            if (this.ch_ready) {
                // console.log(data.fields.deliveryTag);
                try {
                    this.ch.ack(data);
                } catch (e) {
                    console.log(e);
                    console.log(parsedData);
                    console.log(data.properties.headers);
                }
            }
        }
    }

    async processTraces(transaction_trace, extra) {
        const {cpu_usage_us, net_usage_words} = transaction_trace;
        const {block_num, block_id, producer, ts, inline_count, filtered, live, signatures} = extra;

        if (transaction_trace.status === 0) {
            let action_count = 0;
            const trx_id = transaction_trace['id'].toLowerCase();
            const _actDataArray = [];
            const _processedTraces = [];
            let action_traces = transaction_trace['action_traces'];
            const trx_data = {
                trx_id,
                block_num,
                block_id,
                producer,
                cpu_usage_us,
                net_usage_words,
                ts,
                inline_count,
                filtered,
                signatures
            };

            const usageIncluded = {status: false};

            // perform action flattening if necessary
            if (this.mLoader.parser.flatten) {
                const trace_counters = {trace_index: 0};
                action_traces = await this.mLoader.parser.flattenInlineActions(action_traces, 0, trace_counters, 0);
                action_traces.sort((a, b) => {
                    return a[1].receipt[1].global_sequence - b[1].receipt[1].global_sequence;
                });
            }

            for (const action_trace of action_traces) {
                if (action_trace[0].startsWith('action_trace_')) {
                    const ds_status = await this.mLoader.parser.parseAction(this,
                        ts,
                        action_trace[1],
                        trx_data,
                        _actDataArray,
                        _processedTraces,
                        transaction_trace,
                        usageIncluded
                    );
                    if (ds_status) {
                        this.temp_ds_counter++;
                        action_count++;
                    }
                }
            }

            const _finalTraces = [];

            if (_processedTraces.length > 1) {
                const act_digests = {};

                // collect digests & receipts
                for (const _trace of _processedTraces) {
                    if (act_digests[_trace.receipt.act_digest]) {
                        act_digests[_trace.receipt.act_digest].push(_trace.receipt);
                    } else {
                        act_digests[_trace.receipt.act_digest] = [_trace.receipt];
                    }
                }

                // Apply notified accounts to first trace instance
                for (const _trace of _processedTraces) {
                    if (act_digests[_trace.receipt.act_digest]) {
                        // const notifiedSet = new Set();
                        _trace['receipts'] = [];
                        for (const _receipt of act_digests[_trace.receipt.act_digest]) {
                            // notifiedSet.add(_receipt.receiver);
                            _trace['code_sequence'] = _receipt['code_sequence'];
                            delete _receipt['code_sequence'];
                            _trace['abi_sequence'] = _receipt['abi_sequence'];
                            delete _receipt['abi_sequence'];
                            _trace['receipts'].push(_receipt);
                        }
                        // _trace['notified'] = [...notifiedSet];
                        delete act_digests[_trace.receipt.act_digest];
                        delete _trace['receipt'];
                        delete _trace['receiver'];
                        _finalTraces.push(_trace);
                    }
                }

            } else if (_processedTraces.length === 1) {

                // single action on trx
                const _trace = _processedTraces[0];
                _trace['code_sequence'] = _trace['receipt'].code_sequence;
                _trace['abi_sequence'] = _trace['receipt'].abi_sequence;
                _trace['act_digest'] = _trace['receipt'].act_digest;

                // notified array is not required since receipts.receiver can be indexed directly
                // _trace['notified'] = [_trace['receipt'].receiver];

                delete _trace['receipt']['code_sequence'];
                delete _trace['receipt']['abi_sequence'];
                _trace['receipts'] = [_trace['receipt']];
                delete _trace['receipt'];
                _finalTraces.push(_trace);
            }

            // Submit Actions after deduplication

            const redisPayload = new Map<string, IORedis.ValueType>();

            for (const uniqueAction of _finalTraces) {
                cleanActionTrace(uniqueAction);
                const payload = Buffer.from(flatstr(JSON.stringify(uniqueAction)));
                redisPayload.set(uniqueAction.global_sequence.toString(), payload);
                this.actionDsCounter++;
                this.pushToActionsQueue(payload, block_num);
                if (live === 'true') {
                    this.pushToActionStreamingQueue(payload, uniqueAction);
                }
            }

            // save payload to redis
            if (this.ioRedisClient && !this.conf.api.disable_tx_cache) {
                try {
                    await this.ioRedisClient.hset('trx_' + trx_data.trx_id, redisPayload);
                    await this.ioRedisClient.expire('trx_' + trx_data.trx_id, this.txCacheExpiration);
                } catch (e) {
                    hLog(e);
                }
            }
        }
    }

    pushToActionsQueue(payload, block_num) {
        if (!this.conf.indexer.disable_indexing) {
            const q = this.chain + ":index_actions:" + (this.act_emit_idx);
            this.preIndexingQueue.push({
                queue: q,
                content: payload,
                headers: {block_num}
            });
            this.act_emit_idx++;
            if (this.act_emit_idx > (this.conf.scaling.ad_idx_queues)) {
                this.act_emit_idx = 1;
            }
        }
    }

    pushToActionStreamingQueue(payload, uniqueAction) {
        if (this.allowStreaming && this.conf.features['streaming'].traces) {
            try {
                const notifArray = new Set();
                uniqueAction.act.authorization.forEach(auth => {
                    notifArray.add(auth.actor);
                });
                uniqueAction.receipts.forEach(rec => {
                    notifArray.add(rec.receiver);
                });
                const headers = {
                    event: 'trace',
                    account: uniqueAction['act']['account'],
                    name: uniqueAction['act']['name'],
                    notified: [...notifArray].join(",")
                };
                this.ch.publish('', this.chain + ':stream', payload, {headers});
            } catch (e) {
                hLog(e);
            }
        }
    }

    initConsumer() {
        if (this.ch_ready) {
            this.ch.prefetch(this.conf.prefetch.block);
            this.ch.consume(this.local_queue, (data) => {
                this.consumerQueue.push(data);
            }, {}, (err, ok) => {
                hLog(err, ok);
            });
            debugLog(`started consuming from ${this.local_queue}`);
        }
    }

    deleteCache(contract) {
        // delete cache contract on abieos context
        const status = AbiEOS.delete_contract(contract);
        if (!status) {
            debugLog('Contract not found on cache!');
        } else {
            debugLog(`🗑️ Contract successfully removed from cache!`);
        }
    }

    startMonitoring() {
        // Monitor Contract Usage
        if (!this.monitoringLoop) {
            this.monitoringLoop = setInterval(() => {
                if (this.totalHits > 0) {
                    process.send({
                        event: 'contract_usage_report',
                        data: this.contractUsage,
                        total_hits: this.totalHits
                    });
                    // hLog(`${this.local_queue} ->> ${this.actionDsCounter} actions`);
                    process.send({
                        event: 'ds_report',
                        actions: this.actionDsCounter
                    });
                    this.noActionCounter = 0;
                } else {
                    if (!this.conf.indexer.abi_scan_mode && !this.conf.indexer.live_reader) {
                        this.noActionCounter++;
                        if (this.noActionCounter > 60) {
                            debugLog(`No actions processed for ${this.noActionCounter} seconds!`);
                        }
                    }
                }
                this.contractUsage = {};
                this.totalHits = 0;
                this.actionDsCounter = 0;
            }, 1000);
        }
    }

    initializeShipAbi(data) {
        debugLog(`state history abi ready on ds_worker ${process.env.local_id}`);
        this.abi = JSON.parse(data);
        AbiEOS.load_abi("0", data);
        const initialTypes = Serialize.createInitialTypes();
        this.types = Serialize.getTypesFromAbi(initialTypes, this.abi);
        this.abi.tables.map(table => this.tables.set(table.name, table.type));
        this.onReady();
        this.startMonitoring();
    }

    assertQueues(): void {
        const queue_prefix = this.conf.settings.chain;
        this.local_queue = queue_prefix + ':ds_pool:' + process.env.local_id;
        if (this.ch) {
            this.ch_ready = true;
            this.ch.assertQueue(this.local_queue, {
                durable: true
            });
            this.initConsumer();
        }
        if (this.conf.settings.dsp_parser) {
            this.ch.assertQueue(`${queue_prefix}:dsp`, {
                durable: true
            });
        }
    }

    onIpcMessage(msg: any): void {
        switch (msg.event) {
            case 'initialize_abi': {
                this.initializeShipAbi(msg.data);
                break;
            }
            case 'remove_contract': {
                // hLog(`[${process.env.local_id}] Delete contract: ${msg.contract}`);
                this.deleteCache(msg.contract);
                break;
            }
            case 'connect_ws': {
                this.allowStreaming = true;
                break;
            }
        }
    }

    onReady() {
        // process.send({
        //     event: 'ds_ready',
        //     id: process.env.local_id
        // });
    }

    async run(): Promise<void> {
        debugLog(`Standalone deserializer launched with id: ${process.env.local_id}`);
    }
}
