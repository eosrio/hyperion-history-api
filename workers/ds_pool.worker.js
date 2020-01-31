const {checkDebugger} = require("../helpers/functions");
const {ConnectionManager} = require('../connections/manager');
const HyperionModuleLoader = require('../modules/index').HyperionModuleLoader;
const AbiEos = require('../addons/node-abieos/abieos.node');
const {Serialize} = require('../eosjs-native');
const config = require(`../${process.env.CONFIG_JSON}`);
const async = require('async');
const chain = config.settings.chain;
const index_queue_prefix = chain + ':index';
const n_ingestors_per_queue = config['scaling']['indexing_queues'];

const action_indexing_ratio = config['scaling']['ad_idx_queues'];

const abi_remapping = {
    "_Bool": "bool"
};

class DeserializationWorker {

    abi;
    types;
    tables = new Map();

    onReady;
    ch;
    cch;
    manager;

    ch_ready;
    local_queue;

    consumerQueue;
    preIndexingQueue;

    temp_ds_counter = 0;
    act_emit_idx = 1;
    allowStreaming = false;

    // module loader instance
    mLoader;

    // common functions
    common;

    totalHits = 0;

    // contract usage map (temporary)
    contractUsage = {};
    esClient;

    contracts = new Map();
    txDec = new TextDecoder();
    txEnc = new TextEncoder();

    constructor(onReady) {

        this.onReady = onReady;
        this.manager = new ConnectionManager();

        // Load Modules
        this.mLoader = new HyperionModuleLoader(config.settings.parser);

        // Create elasticsearch client
        this.esClient = this.manager.elasticsearchClient;

        // Create EOSJS Rpc
        this.rpc = this.manager.nodeosJsonRPC;

        this.consumerQueue = async.cargo(async.ensureAsync((payload, cb) => {
            this.processMessages(payload).then(() => {
                cb();
            }).catch((err) => {
                console.log('NACK ALL', err);
                if (this.ch_ready) {
                    this.ch.nackAll();
                }
            });
        }), config.prefetch.block);

        this.preIndexingQueue = async.queue(async.ensureAsync((data, cb) => {
            if (this.ch_ready) {
                this.ch.sendToQueue(data.queue, data.content);
                cb();
            } else {
                console.log('Channel is not ready!');
            }
        }), 1);

        // Define Common Functions
        this.common = {
            attachActionExtras: this.attachActionExtras,
            deserializeActionAtBlockNative: this.deserializeActionAtBlockNative
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

    async fetchAbiHexAtBlockElastic(contract_name, last_block, get_json) {
        try {
            const _includes = ["actions", "tables"];
            if (get_json) {
                _includes.push("abi");
            } else {
                _includes.push("abi_hex");
            }
            // const t_start = process.hrtime.bigint();
            const queryResult = await this.esClient.search({
                index: `${chain}-abi-*`,
                body: {
                    size: 1,
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
                // console.log(`fetch abi from elastic took: ${duration} ms`);
                return results[0]._source;
            } else {
                return null;
            }
        } catch (e) {
            console.log(e);
            return null;
        }
    }

    async verifyLocalType(contract, type, block_num, field) {
        let _status;
        let resultType = AbiEos['get_type_for_' + field](contract, type);
        // console.log(contract, type, resultType);
        if (resultType === "NOT_FOUND") {
            // console.log(`${field} not found for ${type} on ${contract}`);
            const savedAbi = await this.fetchAbiHexAtBlockElastic(contract, block_num, false);
            if (savedAbi) {
                if (savedAbi[field + 's'].includes(type)) {
                    if (savedAbi.abi_hex) {
                        _status = AbiEos['load_abi_hex'](contract, savedAbi.abi_hex);
                    }
                    // console.log('🔄  reloaded abi');
                    if (_status) {
                        resultType = AbiEos['get_type_for_' + field](contract, type);
                        // console.log(`verifying ${field} type: ${resultType}`);
                        if (resultType === "NOT_FOUND") {
                            _status = false;
                        } else {
                            // console.log(`✅️  ${contract} abi cache updated at block ${block_num}`);
                            _status = true;
                            return [_status, resultType];
                        }
                    }
                }
                // else {
                //     // console.log(`⚠️ ⚠️  ${field} "${type}" not found on saved abi for ${contract} at block ${block_num}!`);
                // }
            }
            // console.log(`Abi not indexed at or before block ${block_num} for ${contract}`);
            const currentAbi = await this.rpc.getRawAbi(contract);
            // console.log('Retrying with the current revision...');
            if (currentAbi.abi.byteLength > 0) {
                const abi_hex = Buffer.from(currentAbi.abi).toString('hex');
                _status = AbiEos['load_abi_hex'](contract, abi_hex);
            } else {
                _status = false;
            }
            if (_status === true) {
                resultType = AbiEos['get_type_for_' + field](contract, type);
                _status = resultType !== "NOT_FOUND"
                // if (resultType === "NOT_FOUND") {
                //     // console.log(`⚠️ ⚠️  Current ABI version for ${contract} doesn't contain the ${field} type ${type}`);
                //     _status = false;
                // } else {
                //     // console.log(`✅️  ${contract} abi cache updated at block ${block_num}`);
                //     _status = true;
                // }
            }
        } else {
            _status = true;
        }
        return [_status, resultType];
    }

    async deserializeActionAtBlockNative(self, _action, block_num) {
        self.recordContractUsage(_action.account);
        const [_status, actionType] = await self.verifyLocalType(_action.account, _action.name, block_num, "action");
        if (_status) {
            const result = AbiEos['bin_to_json'](_action.account, actionType, Buffer.from(_action.data, 'hex'));
            switch (result) {
                case 'PARSING_ERROR': {
                    console.log(result, block_num, _action);
                    break;
                }
                case 'NOT_FOUND': {
                    console.log(result, block_num, _action);
                    break;
                }
                case 'invalid string size': {
                    console.log(result, _action.data);
                    console.log(_action);
                    break;
                }
                case 'read past end': {
                    console.log(result, _action.data);
                    console.log(_action);
                    break;
                }
                default: {
                    try {
                        return JSON.parse(result);
                    } catch (e) {
                        console.log(e.message);
                        console.log('string >>', result);
                    }
                }
            }
        }

        const fallbackResult = await self.deserializeActionAtBlock(_action, block_num);
        if (!fallbackResult) {
            console.log(`action fallback result: ${fallbackResult} @ ${block_num}`);
            console.log(_action);
        }
        return fallbackResult;
    }

    async getAbiFromHeadBlock(code) {
        let _abi;
        try {
            _abi = (await this.rpc.get_abi(code)).abi;
        } catch (e) {
            console.log(e);
        }
        return {abi: _abi, valid_until: null, valid_from: null};
    }

    async getContractAtBlock(accountName, block_num, check_action) {
        if (this.contracts.has(accountName)) {
            let _sc = this.contracts.get(accountName);
            if ((_sc['valid_until'] > block_num && block_num > _sc['valid_from']) || _sc['valid_until'] === -1) {
                if (_sc['contract'].actions.has(check_action)) {
                    console.log('cached abi');
                    return [_sc['contract'], null];
                }
            }
        }
        let savedAbi, abi;
        savedAbi = await this.fetchAbiHexAtBlockElastic(accountName, block_num, true);
        if (savedAbi === null || !savedAbi.actions.includes(check_action)) {
            // console.log(`no ABI indexed for ${accountName}`);
            savedAbi = await this.getAbiFromHeadBlock(accountName);
            if (!savedAbi) {
                return null;
            }
            abi = savedAbi.abi;
        } else {
            try {
                abi = JSON.parse(savedAbi.abi);
            } catch (e) {
                console.log(e);
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
                    console.log('failed after remapping abi');
                    console.log(accountName, block_num, check_action);
                    console.log(e);
                }
            } else {
                console.log(accountName, block_num);
                console.log(e);
            }
        }
        const actions = new Map();
        for (const {name, type} of abi.actions) {
            actions.set(name, Serialize.getType(types, type));
        }
        const result = {types, actions, tables: abi.tables};
        if (check_action) {
            // console.log(actions);
            if (actions.has(check_action)) {
                // console.log(check_action, 'check type', actions.get(check_action).name);
                // console.log(abi);
                try {
                    AbiEos['load_abi'](accountName, JSON.stringify(abi));
                } catch (e) {
                    console.log(e);
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
                    );
                } catch (e) {
                    console.log(e);
                    return null;
                }
            } else {
                return null;
            }
        } else {
            return null;
        }
    }

    async processMessages(msg_array) {
        for (const data of msg_array) {
            const parsedData = JSON.parse(Buffer.from(data.content).toString());
            await this.processTraces(parsedData, data.properties.headers);
            // ack message
            if (this.ch_ready) {
                this.ch.ack(data);
            }
        }
    }

    async processTraces(transaction_trace, extra) {
        const {cpu_usage_us, net_usage_words} = transaction_trace;
        const {block_num, producer, ts} = extra;
        if (transaction_trace.status === 0) {
            let action_count = 0;
            const trx_id = transaction_trace['id'].toLowerCase();
            const _actDataArray = [];
            const _processedTraces = [];
            const action_traces = transaction_trace['action_traces'];
            const trx_data = {
                trx_id,
                block_num,
                producer,
                cpu_usage_us,
                net_usage_words,
                ts
            };
            for (const action_trace of action_traces) {
                if (action_trace[0] === 'action_trace_v0') {
                    const ds_status = await this.mLoader.actionParser(this, ts, action_trace[1], trx_data, _actDataArray, _processedTraces, transaction_trace);
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
            // console.log(_finalTraces.length);
            for (const uniqueAction of _finalTraces) {
                const payload = Buffer.from(JSON.stringify(uniqueAction));
                this.pushToActionsQueue(payload);
                this.pushToActionStreamingQueue(payload, uniqueAction);
            }
        }
    }

    pushToActionsQueue(payload) {
        if (!config.indexer['disable_indexing']) {
            const q = index_queue_prefix + "_actions:" + (this.act_emit_idx);
            this.preIndexingQueue.push({
                queue: q,
                content: payload
            });
            this.act_emit_idx++;
            if (this.act_emit_idx > (n_ingestors_per_queue * action_indexing_ratio)) {
                this.act_emit_idx = 1;
            }
        }
    }

    pushToActionStreamingQueue(payload, uniqueAction) {
        if (this.allowStreaming && config.features['streaming'].traces) {
            const notifArray = new Set();
            uniqueAction.act.authorization.forEach(auth => {
                notifArray.add(auth.actor);
            });
            uniqueAction.notified.forEach(acc => {
                notifArray.add(acc);
            });
            const headers = {
                event: 'trace',
                account: uniqueAction['act']['account'],
                name: uniqueAction['act']['name'],
                notified: [...notifArray].join(",")
            };
            this.ch.publish('', chain + ':stream', payload, {headers});
        }
    }

    async initQueues() {
        [this.ch, this.cch] = await this.manager.createAMQPChannels((channels) => {
            [this.ch, this.cch] = channels;
            this.assertQueues();
            this.initConsumer();
        });
        this.assertQueues();
        this.initConsumer();
    }

    assertQueues() {
        const queue_prefix = config.settings.chain;
        this.local_queue = queue_prefix + ':ds_pool:' + process.env.local_id;
        if (this.ch) {
            this.ch_ready = true;
            this.ch.assertQueue(this.local_queue, {
                durable: true
            });
        }
    }

    initConsumer() {
        if (this.ch_ready) {
            this.ch.prefetch(config.prefetch.block);
            this.ch.consume(this.local_queue, (data) => {
                this.consumerQueue.push(data);
            });
            console.log(`DS Pool Worker ${process.env.local_id} consuming from ${this.local_queue}`);
        }
    }

    deleteCache(contract) {
        // delete cache contract on abieos context
        const status = AbiEos['delete_contract'](contract);
        if (!status) {
            console.log('Contract not found on cache!');
        } else {
            console.log(`🗑️ Contract Successfully removed from cache!`);
        }
    }

    onIpcMessage(msg) {
        switch (msg.event) {
            case 'initialize_abi': {
                this.initializeShipAbi(msg.data);
                // abi = JSON.parse(msg.data);
                // abieos['load_abi']("0", msg.data);
                // const initialTypes = Serialize.createInitialTypes();
                // types = Serialize.getTypesFromAbi(initialTypes, abi);
                // abi.tables.map(table => tables.set(table.name, table.type));
                // initConsumer();
                break;
            }
            case 'remove_contract': {
                console.log(`[${process.env.local_id}] Delete contract: ${msg.contract}`);
                this.deleteCache(msg.contract);
                break;
            }
            case 'connect_ws': {
                this.allowStreaming = true;
                break;
            }
        }
    }

    startMonitoring() {
        // Monitor Contract Usage
        setInterval(() => {
            process.send({
                event: 'contract_usage_report',
                data: this.contractUsage,
                total_hits: this.totalHits
            });
            this.contractUsage = {};
            this.totalHits = 0;
        }, 1000);
    }

    initializeShipAbi(data) {
        console.log(`state history abi ready on ds_worker ${process.env.local_id}`);
        this.abi = JSON.parse(data);
        AbiEos['load_abi']("0", data);
        const initialTypes = Serialize.createInitialTypes();
        this.types = Serialize.getTypesFromAbi(initialTypes, this.abi);
        this.abi.tables.map(table => this.tables.set(table.name, table.type));
        this.onReady();
        this.initQueues().catch(console.log);
        this.startMonitoring();
    }
}

module.exports = {
    run: async () => {
        checkDebugger();
        console.log(`Standalone deserializer launched with id: ${process.env.local_id}`);
        const dsWorker = new DeserializationWorker(() => {
            process.send({
                event: 'ds_ready',
                id: process.env.local_id
            });
        });
        process.on("message", (msg) => {
            dsWorker.onIpcMessage(msg);
        });
    }
};
