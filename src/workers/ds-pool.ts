import {HyperionWorker} from "./hyperionWorker.js";
import {cargo, queue, QueueObject} from "async";
import {debugLog, fetchAbiAtBlock, hLog} from "../helpers/common_functions.js";
import {Message} from "amqplib";
import {join, resolve} from "node:path";
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {default as IORedis, RedisValue} from "ioredis";
import {RpcInterfaces, Serialize} from "enf-eosjs";
import {ActionTrace} from "../interfaces/action-trace.js";
import {HyperionAction, HyperionActionAct} from "../interfaces/hyperion-action.js";

const abi_remapping: Record<string, string> = {
    "_Bool": "bool",
    "account_name": "name",
};

interface CustomAbiDef {
    abi: string;
    startingBlock: number;
    endingBlock: number;
}

export default class DSPoolWorker extends HyperionWorker {

    abi?: RpcInterfaces.Abi;
    types?: Map<string, Serialize.Type>
    tables = new Map();
    local_queue?: string;
    consumerQueue: QueueObject<any>;
    preIndexingQueue: QueueObject<any>;
    temp_ds_counter = 0;
    act_emit_idx = 1;
    allowStreaming = false;
    // common functions
    common;
    totalHits = 0;
    // contract usage map (temporary)
    contractUsage: Record<string, number> = {};
    contracts = new Map();
    monitoringLoop!: NodeJS.Timeout;
    actionDsCounter = 0;

    customAbiMap: Map<string, CustomAbiDef[]> = new Map();
    private noActionCounter = 0;

    // tx caching layer
    private readonly ioRedisClient: IORedis.Redis;
    txCacheExpiration = 3600;

    constructor() {
        super();

        this.ioRedisClient = new IORedis.default(this.manager.conn.redis);
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
                    } catch (e: any) {
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
                } catch (e: any) {
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
                            this.customAbiMap.get(code)?.push(def);
                        }

                    } catch (e: any) {
                        hLog(e);
                    }
                }
            }
        }
    }

    attachActionExtras(self: HyperionWorker, action: ActionTrace) {
        self.mLoader.processActionData(action);
    }

    recordContractUsage(code: string) {
        this.totalHits++;
        if (this.contractUsage[code]) {
            this.contractUsage[code]++;
        } else {
            this.contractUsage[code] = 1;
        }
    }

    // noinspection JSUnusedGlobalSymbols
    async verifyLocalType(contract: string, type: string, block_num: number, field: string): Promise<[boolean, string | undefined]> {
        let _status;
        let resultType;
        try {
            if (field === 'action') {
                resultType = this.abieos.getTypeForAction(contract, type);
            } else {
                resultType = this.abieos.getTypeForTable(contract, type);
            }
            _status = true;
        } catch {
            _status = false;
        }

        if (!_status) {

            if (this.conf.settings.allow_custom_abi) {
                if (this.customAbiMap.has(contract)) {
                    const list = this.customAbiMap.get(contract);
                    if (list) {
                        const matchingAbi = list.find(entry => {
                            return entry.startingBlock < block_num && entry.endingBlock > block_num;
                        });
                        if (matchingAbi && matchingAbi.abi) {
                            _status = this.abieos.loadAbi(contract, matchingAbi.abi);
                        }
                    }
                }
            }


            if (!_status) {
                const savedAbi = await fetchAbiAtBlock(this.client, this.chain, contract, block_num, false);
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
                    if (field === 'action') {
                        resultType = this.abieos.getTypeForAction(contract, type);
                    } else {
                        resultType = this.abieos.getTypeForTable(contract, type);
                    }
                    _status = true;
                    return [_status, resultType];
                } catch (e: any) {
                    debugLog(`(abieos/cached) >> ${e.message}`);
                    _status = false;
                }
            }


            _status = await this.loadCurrentAbiHex(contract);

            if (_status) {
                try {
                    if (field === 'action') {
                        resultType = this.abieos.getTypeForAction(contract, type);
                    } else {
                        resultType = this.abieos.getTypeForTable(contract, type);
                    }
                    _status = true;
                } catch (e: any) {
                    debugLog(`(abieos/current) >> ${e.message}`);
                    _status = false;
                }
            }
        }
        return [_status, resultType];
    }

    async deserializeActionAtBlockNative(self: DSPoolWorker, _action: HyperionActionAct, block_num: number): Promise<any> {
        self.recordContractUsage(_action.account);
        // abieos is having issues to deserialize onblock, lets use eosjs directly here
        if (_action.account === self.conf.settings.eosio_alias && _action.name === 'onblock') {
            return self.deserializeActionAtBlock(_action, block_num);
        }
        const tRef = Date.now();
        const [_status, actionType] = await self.verifyLocalType(_action.account, _action.name, block_num, "action");
        let abieosFailed = false;
        if (_status && actionType) {
            try {
                return self.abieos.binToJson(_action.account, actionType, Buffer.from(_action.data, 'hex'));
            } catch (e: any) {
                abieosFailed = true;
                debugLog(`(abieos.binToJson) ${_action.account}::${_action.name} @ ${block_num} >>> ${e.message}`);
            }
        }
        console.log(`Abieos part took: ${Date.now() - tRef}`);
        const fallbackData = await self.deserializeActionAtBlock(_action, block_num);
        if (abieosFailed && fallbackData) {
            console.log('FALLBACK TO EOSJS OK ->>>> ', fallbackData);
        }
        return fallbackData;
    }

    async getAbiFromHeadBlock(code: string) {
        let _abi;
        try {
            _abi = (await this.rpc.get_abi(code)).abi;
        } catch (e: any) {
            hLog(e);
        }
        return {
            abi: _abi,
            valid_until: null,
            valid_from: null
        };
    }

    async getContractAtBlock(accountName: string, block_num: number, check_action: string) {

        // check in memory cache for contract
        if (this.contracts.has(accountName)) {
            let _sc = this.contracts.get(accountName);
            if ((_sc['valid_until'] > block_num && block_num > _sc['valid_from']) || _sc['valid_until'] === -1) {
                if (_sc['contract'].actions.has(check_action)) {
                    return [_sc['contract'], null];
                }
            }
        }

        let savedAbi, abi;
        savedAbi = await fetchAbiAtBlock(this.client, this.chain, accountName, block_num, true);
        if (savedAbi === null || (savedAbi.actions && !savedAbi.actions.includes(check_action))) {
            savedAbi = await this.getAbiFromHeadBlock(accountName);
            if (!savedAbi) {
                return null;
            }
            abi = savedAbi.abi;
        } else {
            try {
                abi = JSON.parse(savedAbi.abi);
            } catch (e: any) {
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
        } catch (e: any) {
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
                } catch (e2: any) {
                    hLog('failed after remapping abi');
                    hLog(accountName, block_num, check_action);
                    hLog(e2.message);
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
                if (!this.failedAbiMap.has(accountName) || !this.failedAbiMap.get(accountName)?.has(-1)) {
                    try {
                        const abiLoadStatus = this.abieos.loadAbi(accountName, JSON.stringify(abi));
                        if (!abiLoadStatus) {
                            console.log('AbiEOS.load_abi >> ', abiLoadStatus);
                        }
                    } catch (e: any) {
                        hLog(e);
                    }
                } else {
                    debugLog('ignore reloading of current abi for', accountName);
                }
                console.log(`Saving ${accountName}@${block_num} - from: ${savedAbi.valid_from} - until: ${savedAbi.valid_until}`);
                this.contracts.set(accountName, {
                    contract: result,
                    valid_until: savedAbi.valid_until,
                    valid_from: savedAbi.valid_from
                });
            }
        }
        return [result, abi];
    }

    async deserializeActionAtBlock(action: HyperionActionAct, block_num: number): Promise<any> {
        const contract = await this.getContractAtBlock(action.account, block_num, action.name);
        if (contract) {
            if (contract[0].actions.has(action.name)) {
                try {
                    const deserialized_act = Serialize.deserializeAction(
                        contract[0],
                        action.account,
                        action.name,
                        action.authorization,
                        action.data,
                        this.txEnc,
                        this.txDec
                    );
                    if (deserialized_act.data) {
                        return deserialized_act.data;
                    } else {
                        hLog(`(eosjs) - No data object on ${action.account}::${action.name} @ ${block_num}`);
                        return deserialized_act;
                    }
                } catch (e: any) {
                    debugLog(`(eosjs)  ${action.account}::${action.name} @ ${block_num} >>> ${e.message}`);
                    return null;
                }
            } else {
                return null;
            }
        } else {
            return null;
        }
    }

    async processMessages(msg_array: Message[]): Promise<void> {
        for (const data of msg_array) {
            const parsedData = JSON.parse(Buffer.from(data.content).toString());
            await this.processTraces(parsedData, data.properties.headers);
            // ack message
            if (this.ch_ready) {
                // console.log(data.fields.deliveryTag);
                try {
                    this.ch.ack(data);
                } catch (e: any) {
                    console.log(e);
                    console.log(parsedData);
                    console.log(data.properties.headers);
                }
            }
        }
    }

    async processTraces(transaction_trace: any, extra: any) {
        const {cpu_usage_us, net_usage_words} = transaction_trace;
        const {block_num, block_id, producer, ts, inline_count, filtered, live, signatures} = extra;

        if (transaction_trace.status === 0) {
            let action_count = 0;
            const trx_id = transaction_trace['id'].toLowerCase();
            // TODO: add custom types
            const _actDataArray: any[] = [];
            const _processedTraces: any[] = [];

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
                action_traces.sort((a: any[], b: any[]) => {
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

            const _finalTraces: any[] = [];
            if (_processedTraces.length > 1) {
                const act_digests: Record<string, any> = {};

                // collect digests & receipts
                for (const _trace of _processedTraces) {
                    delete _trace.console;
                    if (act_digests[_trace.receipt.act_digest]) {
                        act_digests[_trace.receipt.act_digest].push(_trace.receipt);
                    } else {
                        act_digests[_trace.receipt.act_digest] = [_trace.receipt];
                    }
                }

                // Apply notified accounts to first trace instance
                for (const _trace of _processedTraces) {
                    if (act_digests[_trace.receipt.act_digest]) {
                        const notifiedSet = new Set();
                        _trace['receipts'] = [];
                        for (const _receipt of act_digests[_trace.receipt.act_digest]) {
                            notifiedSet.add(_receipt.receiver);
                            _trace['code_sequence'] = _receipt['code_sequence'];
                            delete _receipt['code_sequence'];
                            _trace['abi_sequence'] = _receipt['abi_sequence'];
                            delete _receipt['abi_sequence'];
                            delete _receipt['act_digest'];
                            _trace['receipts'].push(_receipt);
                        }
                        _trace['notified'] = [...notifiedSet];
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
                _trace['notified'] = [_trace['receipt'].receiver];
                delete _trace['receipt']['code_sequence'];
                delete _trace['receipt']['abi_sequence'];
                delete _trace['receipt']['act_digest'];
                _trace['receipts'] = [_trace['receipt']];
                delete _trace['receipt'];
                _finalTraces.push(_trace);
            }

            // Submit Actions after deduplication

            const redisPayload = new Map<string, RedisValue>();

            for (const uniqueAction of _finalTraces) {
                const payload = Buffer.from(JSON.stringify(uniqueAction));
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
                } catch (e: any) {
                    hLog(e);
                }
            }
        }
    }

    pushToActionsQueue(payload: any, block_num: number) {
        if (!this.conf.indexer.disable_indexing) {
            const q = this.chain + ":index_actions:" + (this.act_emit_idx);
            this.preIndexingQueue.push({
                queue: q,
                content: payload,
                headers: {block_num}
            }).catch(hLog);
            this.act_emit_idx++;
            if (this.act_emit_idx > (this.conf.scaling.ad_idx_queues)) {
                this.act_emit_idx = 1;
            }
        }
    }

    pushToActionStreamingQueue(payload: any, uniqueAction: HyperionAction) {
        if (this.allowStreaming && this.conf.features['streaming'].traces) {
            const notifArray = new Set();
            uniqueAction.act.authorization.forEach((auth: any) => {
                notifArray.add(auth.actor);
            });
            uniqueAction.notified.forEach((acc: string) => {
                notifArray.add(acc);
            });
            const headers = {
                event: 'trace',
                account: uniqueAction['act']['account'],
                name: uniqueAction['act']['name'],
                notified: [...notifArray].join(",")
            };
            this.ch.publish('', this.chain + ':stream', payload, {headers});
        }
    }

    initConsumer() {
        if (this.ch_ready) {
            this.ch.prefetch(this.conf.prefetch.block);
            if (this.local_queue) {
                this.ch.consume(this.local_queue, (data) => {
                    if (data) {
                        this.consumerQueue.push(data).catch(console.log);
                    }
                }, {}, (err, ok) => {
                    hLog(err, ok);
                });
                debugLog(`started consuming from ${this.local_queue}`);
            }
        }
    }

    deleteCache(contract: string) {
        // delete cache contract on abieos context
        const status = this.abieos.deleteContract(contract);
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
                    process.send?.({
                        event: 'contract_usage_report',
                        data: this.contractUsage,
                        total_hits: this.totalHits
                    });
                    // hLog(`${this.local_queue} ->> ${this.actionDsCounter} actions`);
                    process.send?.({
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

    initializeShipAbi(data: string) {

        debugLog(`state history abi ready on ds_worker ${process.env.local_id}`);

        try {
            this.abi = JSON.parse(data);
        } catch (e) {
            hLog('Failed to parse Ship ABI!');
        }

        if (this.abi) {
            this.abieos.loadAbi("0", data);
            const initialTypes = Serialize.createInitialTypes();
            this.types = Serialize.getTypesFromAbi(initialTypes, this.abi);
            this.abi.tables.map(table => this.tables.set(table.name, table.type));
            this.onReady();
            this.startMonitoring();
        }
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
        // process.send?.({
        //     event: 'ds_ready',
        //     id: process.env.local_id
        // });
    }

    async run(): Promise<void> {
        debugLog(`Standalone deserializer launched with id: ${process.env.local_id}`);
    }
}
