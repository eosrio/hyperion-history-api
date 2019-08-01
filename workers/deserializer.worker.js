const {Api, Serialize} = require('eosjs');

const _ = require('lodash');
const {action_blacklist} = require('../definitions/blacklists');
const prettyjson = require('prettyjson');
const {AbiDefinitions} = require("../definitions/abi_def");
const {deserialize, unzipAsync} = require('../helpers/functions');

const async = require('async');
const {amqpConnect} = require("../connections/rabbitmq");
const {connectRpc} = require("../connections/chain");
const {elasticsearchConnect} = require("../connections/elasticsearch");

const {TextEncoder, TextDecoder} = require('util');

const redis = require('redis');
const {promisify} = require('util');
const rClient = redis.createClient();
const getAsync = promisify(rClient.get).bind(rClient);

const txDec = new TextDecoder();
const txEnc = new TextEncoder();

let ch, api, types, client, cch, rpc, abi;
let tables = new Map();
let chainID = null;
let act_emit_idx = 1;
let delta_emit_idx = 1;
let block_emit_idx = 1;
let tbl_acc_emit_idx = 1;
let tbl_vote_emit_idx = 1;
let tbl_votes_emit_idx = 1;
let local_block_count = 0;
let allowStreaming = false;
let cachedMap;
let contracts = new Map();

const queue_prefix = process.env.CHAIN;
const queue = queue_prefix + ':blocks';
const index_queue_prefix = queue_prefix + ':index';
const index_queues = require('../definitions/index-queues').index_queues;
const n_deserializers = process.env.DESERIALIZERS;
const n_ingestors_per_queue = parseInt(process.env.ES_INDEXERS_PER_QUEUE, 10);
const action_indexing_ratio = parseInt(process.env.ES_ACT_QUEUES, 10);

// Stage 2 consumer prefecth
const dSprefecthCount = parseInt(process.env.BLOCK_PREFETCH, 10);
const consumerQueue = async.cargo(async.ensureAsync(processPayload), dSprefecthCount);

// Stage 2 - Deserialization handler
function processPayload(payload, cb) {
    processMessages(payload).then(() => {
        cb();
    }).catch((err) => {
        ch.nackAll();
        console.log('NACK ALL', err);
    })
}

function debugLog(msg) {
    if (process.env.DEBUG === 'true') {
        console.log(msg);
    }
}

// Stage 2 - Deserialization function
async function processMessages(messages) {
    for (const message of messages) {
        const ds_msg = deserialize('result', message.content, txEnc, txDec, types);
        const res = ds_msg[1];
        let block, traces = [], deltas = [];
        if (res.block && res.block.length) {
            block = deserialize('signed_block', res.block, txEnc, txDec, types);
            if (block === null) {
                console.log(res);
            }
        }
        if (res['traces'] && res['traces'].length) {
            traces = deserialize('transaction_trace[]', res['traces'], txEnc, txDec, types);
        }
        if (res['deltas'] && res['deltas'].length) {
            deltas = deserialize('table_delta[]', res['deltas'], txEnc, txDec, types);
        }
        let result;
        try {
            const t0 = Date.now();
            result = await processBlock(res, block, traces, deltas);
            const elapsedTime = Date.now() - t0;
            if (elapsedTime > 10) {
                debugLog(`[WARNING] Deserialization time for block ${result['block_num']} was too high, time elapsed ${elapsedTime}ms`);
            }
            if (result) {
                process.send({
                    event: 'consumed_block',
                    block_num: result['block_num']
                });
            } else {
                console.log('Empty message. No block');
                console.log(_.omit(res, ['block', 'traces', 'deltas']));
            }
            ch.ack(message);
        } catch (e) {
            console.log(e);
            ch.nack(message);
        }
    }
}

// Stage 2 - Block handler
async function processBlock(res, block, traces, deltas) {
    if (!res['this_block']) {
        console.log(res);
        return null;
    } else {
        let producer = '';
        let ts = '';
        const block_num = res['this_block']['block_num'];
        if (process.env.FETCH_BLOCK === 'true') {
            if (!block) {
                console.log(res);
            }
            producer = block['producer'];
            ts = block['timestamp'];
            const light_block = {
                block_num: res['this_block']['block_num'],
                producer: block['producer'],
                new_producers: block['new_producers'],
                '@timestamp': block['timestamp'],
                schedule_version: block['schedule_version']
            };

            if (process.env.ENABLE_INDEXING === 'true') {
                const q = index_queue_prefix + "_blocks:" + (block_emit_idx);
                const status = ch.sendToQueue(q, Buffer.from(JSON.stringify(light_block)));
                if (!status) {
                    // console.log('Block Indexing:', status);
                }
                block_emit_idx++;
                if (block_emit_idx > n_ingestors_per_queue) {
                    block_emit_idx = 1;
                }
            }

            local_block_count++;
        }

        if (deltas && process.env.PROC_DELTAS === 'true') {
            const t1 = Date.now();
            await processDeltas(deltas, block_num);
            const elapsed_time = Date.now() - t1;
            if (elapsed_time > 10) {
                debugLog(`[WARNING] Delta processing took ${elapsed_time}ms on block ${block_num}`);
            }
        }

        if (traces.length > 0 && process.env.FETCH_TRACES === 'true') {
            const t2 = Date.now();
            for (const trace of traces) {
                const transaction_trace = trace[1];
                if (transaction_trace.status === 0) {
                    let action_count = 0;
                    const trx_id = transaction_trace['id'].toLowerCase();
                    const _actDataArray = [];
                    const _processedTraces = [];
                    const action_traces = transaction_trace['action_traces'];
                    // console.log(transaction_trace['partial']);
                    const t3 = Date.now();
                    for (const action_trace of action_traces) {
                        if (action_trace[0] === 'action_trace_v0') {
                            const action = action_trace[1];
                            if (action_blacklist.has(`${queue_prefix}::${action['act']['account']}::*`)) {
                                // blacklisted
                                // console.log(`${action['act']['account']} account blacklisted (action: ${action['act']['name']})`);
                            } else if (action_blacklist.has(`${queue_prefix}::${action['act']['account']}::${action['act']['name']}`)) {
                                // blacklisted
                                // console.log(`${queue_prefix}::${action['act']['account']}::${action['act']['name']} action blacklisted`);
                            } else {
                                const status = await processAction(ts, action, trx_id, block_num, producer, _actDataArray, _processedTraces, transaction_trace);
                                if (status) {
                                    action_count++;
                                }
                            }
                        }
                    }
                    const _finalTraces = [];

                    if (_processedTraces.length > 0) {
                        const digestMap = new Map();
                        // console.log(`----------- TRX ${trx_id} ------------------`);
                        for (let i = 0; i < _processedTraces.length; i++) {
                            const receipt = _processedTraces[i].receipt;
                            const act_digest = receipt['act_digest'];
                            if (digestMap.has(act_digest)) {
                                digestMap.get(act_digest).push(receipt);
                            } else {
                                const _arr = [];
                                _arr.push(receipt);
                                digestMap.set(act_digest, _arr);
                            }
                        }
                        _processedTraces.forEach(data => {
                            const digest = data['receipt']['act_digest'];
                            if (digestMap.has(digest)) {
                                // Apply notified accounts to first trace instance
                                const tempTrace = data;
                                tempTrace['receipts'] = [];
                                tempTrace['notified'] = [];
                                digestMap.get(digest).forEach(val => {

                                    tempTrace['notified'].push(val.receiver);
                                    tempTrace['code_sequence'] = val.code_sequence;
                                    tempTrace['abi_sequence'] = val.abi_sequence;

                                    delete val['code_sequence'];
                                    delete val['abi_sequence'];
                                    delete val['act_digest'];

                                    tempTrace['receipts'].push(val);
                                });
                                delete tempTrace['receipt'];
                                delete tempTrace['receiver'];
                                _finalTraces.push(tempTrace);
                                digestMap.delete(digest);
                            }
                        });
                        // console.log(prettyjson.render(_finalTraces));
                        // console.log(`---------------------------------------------`);
                    }

                    // Submit Actions after deduplication
                    for (const uniqueAction of _finalTraces) {
                        const payload = Buffer.from(JSON.stringify(uniqueAction));
                        if (process.env.ENABLE_INDEXING === 'true') {
                            // Distribute actions to indexer queues
                            const q = index_queue_prefix + "_actions:" + (act_emit_idx);
                            const status = ch.sendToQueue(q, payload);
                            if (!status) {
                                // console.log('Action Indexing:', status);
                            }
                            act_emit_idx++;
                            if (act_emit_idx > (n_ingestors_per_queue * action_indexing_ratio)) {
                                act_emit_idx = 1;
                            }
                        }
                        if (allowStreaming) {
                            ch.publish('', queue_prefix + ':stream', payload, {
                                headers: {
                                    account: uniqueAction['act']['account'],
                                    name: uniqueAction['act']['name']
                                }
                            });
                        }
                    }

                    const act_elapsed_time = Date.now() - t3;
                    if (act_elapsed_time > 100) {
                        debugLog(`[WARNING] Actions processing took ${act_elapsed_time}ms on trx ${trx_id}`);
                        // console.log(action_traces);
                    }
                }
            }
            const traces_elapsed_time = Date.now() - t2;
            if (traces_elapsed_time > 10) {
                debugLog(`[WARNING] Traces processing took ${traces_elapsed_time}ms on block ${block_num}`);
            }
        }
        return {block_num: res['this_block']['block_num'], size: traces.length};
    }
}

async function getContractAtBlock(accountName, block_num) {
    if (contracts.has(accountName)) {
        let savedContract = contracts.get(accountName);
        const validUntil = savedContract['valid_until'];
        if (validUntil > block_num || validUntil === -1) {
            return [savedContract['contract'], null];
        }
    }
    const savedAbi = await getAbiAtBlock(accountName, block_num);
    const abi = savedAbi.abi;
    const initialTypes = Serialize.createInitialTypes();
    let types;
    try {
        types = Serialize.getTypesFromAbi(initialTypes, abi);
    } catch (e) {
        console.log(accountName, block_num);
        console.log(e);
    }
    const actions = new Map();
    for (const {name, type} of abi.actions) {
        actions.set(name, Serialize.getType(types, type));
    }
    const result = {types, actions};
    contracts.set(accountName, {
        contract: result,
        valid_until: savedAbi.valid_until
    });
    return [result, abi];
}

async function deserializeActionsAtBlock(actions, block_num) {
    return Promise.all(actions.map(async ({account, name, authorization, data}) => {
        const contract = (await getContractAtBlock(account, block_num))[0];
        return Serialize.deserializeAction(
            contract, account, name, authorization, data, txEnc, txDec);
    }));
}

async function processAction(ts, action, trx_id, block_num, prod, _actDataArray, _processedTraces, full_trace) {
    let act = action['act'];
    const original_act = Object.assign({}, act);
    act.data = new Uint8Array(Object.values(act.data));
    const actions = [];
    actions.push(act);
    let ds_act;
    try {
        ds_act = await deserializeActionsAtBlock(actions, block_num);
        action['act'] = ds_act[0];
        attachActionExtras(action);
    } catch (e) {
        process.send({
            t: 'ds_fail',
            v: {gs: action['receipt']['global_sequence']}
        });
        action['act'] = original_act;
        action['act']['data'] = Buffer.from(action['act']['data']).toString('hex');
    }
    process.send({event: 'ds_action'});
    action['@timestamp'] = ts;
    action['block_num'] = block_num;
    action['producer'] = prod;
    action['trx_id'] = trx_id;
    if (action['account_ram_deltas'].length === 0) {
        delete action['account_ram_deltas'];
    }
    if (action['console'] === '') {
        delete action['console'];
    }
    if (action['except'] === null) {
        if (!action['receipt']) {
            console.log(full_trace.status);
            console.log(action);
        }
        action['receipt'] = action['receipt'][1];
        action['global_sequence'] = parseInt(action['receipt']['global_sequence'], 10);
        _processedTraces.push(action);
    } else {
        console.log(action);
    }
    return true;
}

function attachActionExtras(action) {
    // Transfer actions
    if (action['act']['name'] === 'transfer') {

        let qtd = null;
        if (action['act']['data']['quantity']) {
            qtd = action['act']['data']['quantity'].split(' ');
            delete action['act']['data']['quantity'];
        } else if (action['act']['data']['value']) {
            qtd = action['act']['data']['value'].split(' ');
            delete action['act']['data']['value'];
        }

        if (qtd) {
            action['@transfer'] = {
                from: String(action['act']['data']['from']),
                to: String(action['act']['data']['to']),
                amount: parseFloat(qtd[0]),
                symbol: qtd[1]
            };
            delete action['act']['data']['from'];
            delete action['act']['data']['to'];

            if (process.env.INDEX_TRANSFER_MEMO === 'true') {
                action['@transfer']['memo'] = action['act']['data']['memo'];
                delete action['act']['data']['memo'];
            }
        }

    } else if (action['act']['name'] === 'newaccount' && action['act']['account'] === 'eosio') {

        let name = null;
        if (action['act']['data']['newact']) {
            name = action['act']['data']['newact'];
        } else if (action['act']['data']['name']) {
            name = action['act']['data']['name'];
            delete action['act']['data']['name'];
        }
        if (name) {
            action['@newaccount'] = {
                active: action['act']['data']['active'],
                owner: action['act']['data']['owner'],
                newact: name
            }
        }
        // await handleNewAccount(action['act']['data'], action, ts);
    } else if (action['act']['name'] === 'updateauth' && action['act']['account'] === 'eosio') {
        // await handleUpdateAuth(action['act']['data'], action, ts);
        const _auth = action['act']['data']['auth'];
        if (_auth['accounts'].length === 0) delete _auth['accounts'];
        if (_auth['keys'].length === 0) delete _auth['keys'];
        if (_auth['waits'].length === 0) delete _auth['waits'];
        action['@updateauth'] = {
            permission: action['act']['data']['permission'],
            parent: action['act']['data']['parent'],
            auth: _auth
        };
    } else if (action['act']['name'] === 'unstaketorex' && action['act']['account'] === 'eosio') {
        let cpu_qtd = null;
        let net_qtd = null;
        if (action['act']['data']['from_net'] && action['act']['data']['from_cpu']) {
            cpu_qtd = parseFloat(action['act']['data']['from_cpu'].split(' ')[0]);
            net_qtd = parseFloat(action['act']['data']['from_net'].split(' ')[0]);
        }
        action['@unstaketorex'] = {
            amount: cpu_qtd + net_qtd,
            owner: action['act']['data']['owner'],
            receiver: action['act']['data']['receiver']
        };
    } else if (action['act']['name'] === 'buyrex' && action['act']['account'] === 'eosio') {
        let qtd = null;
        if (action['act']['data']['amount']) {
            qtd = parseFloat(action['act']['data']['amount'].split(' ')[0]);
        }
        action['@buyrex'] = {
            amount: qtd,
            from: action['act']['data']['from']
        };
    }
}

const ignoredDeltas = new Set(['contract_table', 'contract_row', 'generated_transaction', 'resource_usage', 'resource_limits_state', 'resource_limits_config', 'contract_index64', 'contract_index128', 'contract_index256']);

async function processDeltas(deltas, block_num) {
    const deltaStruct = {};
    for (const table_delta of deltas) {
        if (table_delta[0] === "table_delta_v0") {
            deltaStruct[table_delta[1].name] = table_delta[1].rows;
        }
    }

    // if (deltaStruct[key]) {
    //     const rows = deltaStruct[key];
    //     for (const table_raw of rows) {
    //         const serialBuffer = createSerialBuffer(table_raw.data);
    //         const data = types.get(key).deserialize(serialBuffer);
    //         const table = data[1];
    //         console.log(table);
    //     }
    // }

    // for (const key of Object.keys(deltaStruct)) {
    //     if (!ignoredDeltas.has(key)) {
    //         console.log(`----------- ${key} --------------`);
    //         if (deltaStruct[key]) {
    //             const rows = deltaStruct[key];
    //             for (const table_raw of rows) {
    //                 const serialBuffer = createSerialBuffer(table_raw.data);
    //                 const data = types.get(key).deserialize(serialBuffer);
    //                 const table = data[1];
    //                 console.log(table);
    //             }
    //         }
    //     }
    // }

    // Check account deltas for ABI changes
    if (deltaStruct['account']) {
        const rows = deltaStruct['account'];
        for (const account_raw of rows) {
            const serialBuffer = createSerialBuffer(account_raw.data);
            const data = types.get('account').deserialize(serialBuffer);
            const account = data[1];
            if (account['abi'] !== '') {
                try {
                    const initialTypes = Serialize.createInitialTypes();
                    const abiDefTypes = Serialize.getTypesFromAbi(initialTypes, AbiDefinitions).get('abi_def');
                    const jsonABIString = JSON.stringify(abiDefTypes.deserialize(createSerialBuffer(Serialize.hexToUint8Array(account['abi']))));
                    const new_abi_object = {
                        account: account['name'],
                        block: block_num,
                        abi: jsonABIString
                    };
                    const q = index_queue_prefix + "_abis:1";
                    ch.sendToQueue(q, Buffer.from(JSON.stringify(new_abi_object)));
                    process.send({
                        event: 'save_abi',
                        data: new_abi_object
                    });
                } catch (e) {
                    console.log(e);
                    console.log(account['abi'], block_num, account['name']);
                }
            }
        }
    }

    if (process.env.ABI_CACHE_MODE === 'false' && process.env.PROC_DELTAS === 'true') {

        // Generated transactions
        if (process.env.PROCESS_GEN_TX === 'true') {
            if (deltaStruct['generated_transaction']) {
                const rows = deltaStruct['generated_transaction'];
                for (const gen_trx of rows) {
                    const serialBuffer = createSerialBuffer(gen_trx.data);
                    const data = types.get('generated_transaction').deserialize(serialBuffer);
                    await processDeferred(data[1], block_num);
                }
            }
        }

        // Contract Rows
        if (deltaStruct['contract_row']) {
            const rows = deltaStruct['contract_row'];
            for (const row of rows) {
                const sb = createSerialBuffer(new Uint8Array(Object.values(row.data)));
                try {
                    let allowProcessing = false;
                    const payload = {
                        present: sb.get(),
                        code: sb.getName(),
                        scope: sb.getName(),
                        table: sb.getName(),
                        primary_key: sb.getUint64AsNumber(),
                        payer: sb.getName(),
                        data_raw: sb.getBytes()
                    };

                    if (process.env.INDEX_ALL_DELTAS === 'true') {
                        allowProcessing = true;
                    } else if (payload.code === 'eosio' || payload.table === 'accounts') {
                        allowProcessing = true;
                    }

                    if (allowProcessing) {
                        const jsonRow = await processContractRow(payload, block_num);
                        if (jsonRow['data']) {
                            await processTableDelta(jsonRow, block_num);
                        }
                        if (allowStreaming) {
                            const payload = Buffer.from(JSON.stringify(jsonRow));
                            ch.publish('', queue_prefix + ':stream', payload, {
                                headers: {
                                    event: 'delta'
                                }
                            });
                        }
                    }
                } catch (e) {
                    console.log(e);
                }
            }
        }
    }
}

async function processContractRow(row, block) {
    const row_sb = createSerialBuffer(row['data_raw']);
    const tableType = await getTableType(row['code'], row['table'], block);
    if (tableType) {
        let rowData = null;
        try {
            rowData = (tableType).deserialize(row_sb);
        } catch (e) {
            // console.log(e);
        }
        row['data'] = rowData;
    }
    return _.omit(row, ['data_raw']);
}

async function getTableType(code, table, block) {
    let abi, contract;
    [contract, abi] = await getContractAtBlock(code, block);
    if (!abi) {
        abi = (await getAbiAtBlock(code, block)).abi;
    }
    let this_table, type;
    for (let t of abi.tables) {
        if (t.name === table) {
            this_table = t;
            break;
        }
    }
    if (this_table) {
        type = this_table.type
    } else {
        // console.error(`Could not find table "${table}" in the abi for ${code} at block ${block}`);
        return;
    }
    let cType = contract.types.get(type);
    if (!cType) {

        if (types.has(type)) {
            cType = types.get(type);
        } else {
            if (type === 'self_delegated_bandwidth') {
                cType = contract.types.get('delegated_bandwidth')
            }
        }

        if (!cType) {
            console.log(code, block);
            console.log(`code:${code} | table:${table} | block:${block} | type:${type}`);
            console.log(Object.keys(contract));
            console.log(Object.keys(abi));
        }
    }
    return cType;
}

const tableHandlers = {
    'eosio:voters': async (delta) => {
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
        if (process.env.VOTERS_STATE === 'true') {
            await storeVoter(delta);
        }
    },
    'eosio:global': async (delta) => {
        const data = delta['data'];
        delta['@global.data'] = {
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
    },
    'eosio:producers': async (delta) => {
        const data = delta['data'];
        delta['@producers'] = {
            total_votes: parseFloat(data['total_votes']),
            is_active: data['is_active'],
            unpaid_blocks: data['unpaid_blocks']
        };
        delete delta['data'];
    },
    'eosio:userres': async (delta) => {
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
        // console.log(delta);
    },
    'eosio:delband': async (delta) => {
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
        // console.log(delta);
    },
    // 'eosio:rammarket': async (delta) => {
    //     console.log(delta);
    // },
    '*:accounts': async (delta) => {
        if (typeof delta['data']['balance'] === 'string') {
            try {
                const [amount, symbol] = delta['data']['balance'].split(" ");
                delta['@accounts'] = {
                    amount: parseFloat(amount),
                    symbol: symbol
                };
            } catch (e) {
                console.log(delta);
                console.log(e);
            }
        }
        if (process.env.ACCOUNT_STATE === 'true') {
            await storeAccount(delta);
        }
    }
};

async function storeVoter(data) {
    const voterDoc = {
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

    // console.log('-------------- VOTER --------------');
    // console.log(prettyjson.render(data));

    if (process.env.ENABLE_INDEXING === 'true') {
        const q = index_queue_prefix + "_table_voters:" + (tbl_vote_emit_idx);
        const status = ch.sendToQueue(q, Buffer.from(JSON.stringify(voterDoc)));
        if (!status) {
            // console.log('Voter Indexing:', status);
        }
        tbl_vote_emit_idx++;
        if (tbl_vote_emit_idx > (n_ingestors_per_queue * action_indexing_ratio)) {
            tbl_vote_emit_idx = 1;
        }

        if (process.env.VOTES_HISTORY === 'true') {
            const q = index_queue_prefix + "_table_votes:" + (tbl_votes_emit_idx);
            const status = ch.sendToQueue(q, Buffer.from(JSON.stringify(voterDoc)));
            if (!status) {
                // console.log('Voter Indexing:', status);
            }
            tbl_votes_emit_idx++;
            if (tbl_votes_emit_idx > (n_ingestors_per_queue * action_indexing_ratio)) {
                tbl_votes_emit_idx = 1;
            }
        }
    }
}

async function storeAccount(data) {
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

    // console.log('-------------- ACCOUNT --------------');
    // console.log(prettyjson.render(accountDoc));

    if (process.env.ENABLE_INDEXING === 'true') {
        const q = index_queue_prefix + "_table_accounts:" + (tbl_acc_emit_idx);
        const status = ch.sendToQueue(q, Buffer.from(JSON.stringify(accountDoc)));
        if (!status) {
            // console.log('Account Indexing:', status);
        }
        tbl_acc_emit_idx++;
        if (tbl_acc_emit_idx > (n_ingestors_per_queue * action_indexing_ratio)) {
            tbl_acc_emit_idx = 1;
        }
    }
}

async function processTableDelta(data, block_num) {
    if (data['table']) {

        data['block_num'] = block_num;
        data['primary_key'] = String(data['primary_key']);

        let allowIndex = true;
        let handled = false;
        const key = `${data.code}:${data.table}`;

        if (tableHandlers[key]) {
            await tableHandlers[key](data);
            handled = true;
        }

        if (tableHandlers[`${data.code}:*`]) {
            await tableHandlers[`${data.code}:*`](data);
            handled = true;
        }

        if (tableHandlers[`*:${data.table}`]) {
            await tableHandlers[`*:${data.table}`](data);
            handled = true;
        }

        if (!handled && process.env.INDEX_ALL_DELTAS === 'true') {
            allowIndex = true;
        } else if (handled) {
            allowIndex = true;
        }

        if (process.env.ENABLE_INDEXING === 'true' && allowIndex && process.env.INDEX_DELTAS === 'true') {
            const q = index_queue_prefix + "_deltas:" + (delta_emit_idx);
            const status = ch.sendToQueue(q, Buffer.from(JSON.stringify(data)));
            if (!status) {
                // console.log('Delta Indexing:', status);
            }
            delta_emit_idx++;
            if (delta_emit_idx > n_ingestors_per_queue) {
                delta_emit_idx = 1;
            }
        }
    }
}

function createSerialBuffer(inputArray) {
    return new Serialize.SerialBuffer({
        textEncoder: txEnc,
        textDecoder: txDec,
        array: inputArray
    });
}

async function processDeferred(data, block_num) {
    if (data['packed_trx']) {
        const sb_trx = createSerialBuffer(Serialize.hexToUint8Array(data['packed_trx']));
        const data_trx = types.get('transaction').deserialize(sb_trx);
        data = _.omit(_.merge(data, data_trx), ['packed_trx']);
        data['actions'] = await api.deserializeActions(data['actions']);
        data['trx_id'] = data['trx_id'].toLowerCase();
        if (data['delay_sec'] > 0) {
            console.log(`-------------- DELAYED ${block_num} -----------------`);
            console.log(prettyjson.render(data));
        }
    }
}

async function getAbiAtBlock(code, block_num) {
    const refs = cachedMap[code];
    if (refs) {
        if (refs.length > 0) {
            let lastblock = 0;
            let validity = -1;
            for (const block of refs) {
                if (block > block_num) {
                    validity = block;
                    break;
                } else {
                    lastblock = block;
                }
            }
            const cachedAbiAtBlock = await getAsync(process.env.CHAIN + ":" + lastblock + ":" + code);
            let abi;
            if (!cachedAbiAtBlock) {
                console.log('remote abi fetch [1]', code, block_num);
                abi = await api.getAbi(code);
            } else {
                abi = JSON.parse(cachedAbiAtBlock);
            }
            return {
                abi: abi,
                valid_until: validity
            }
        } else {
            console.log('remote abi fetch [2]', code, block_num);
            return {
                abi: await api.getAbi(code),
                valid_until: null
            };
        }
    } else {
        const ref_time = Date.now();
        const _abi = await api.getAbi(code);
        const elapsed_time = (Date.now() - ref_time);
        if (elapsed_time > 10) {
            console.log('remote abi fetch [3]', code, block_num, elapsed_time);
        }
        return {
            abi: _abi,
            valid_until: null
        };
    }
}

async function run() {
    cachedMap = JSON.parse(await getAsync(process.env.CHAIN + ":" + 'abi_cache'));
    rpc = connectRpc();
    const chain_data = await rpc.get_info();
    chainID = chain_data.chain_id;
    api = new Api({
        "rpc": rpc,
        signatureProvider: null,
        chainId: chain_data.chain_id,
        textDecoder: txDec,
        textEncoder: txEnc,
    });

    client = elasticsearchConnect();

    // Connect to RabbitMQ (amqplib)
    [ch, cch] = await amqpConnect();

    // Assert stage 1
    for (let i = 0; i < n_deserializers; i++) {
        ch.assertQueue(queue + ":" + (i + 1), {
            durable: true
        });
    }

    index_queues.forEach((q) => {
        let n = n_ingestors_per_queue;
        if (q.type === 'abi') n = 1;
        let qIdx = 0;
        for (let i = 0; i < n; i++) {
            let m = 1;
            if (q.type === 'action') m = action_indexing_ratio;
            for (let j = 0; j < m; j++) {
                ch.assertQueue(q.name + ":" + (qIdx + 1), {durable: true});
                qIdx++;
            }
        }
    });

    process.on('message', (msg) => {
        if (msg.event === 'initialize_abi') {
            abi = JSON.parse(msg.data);
            const initialTypes = Serialize.createInitialTypes();
            types = Serialize.getTypesFromAbi(initialTypes, abi);
            abi.tables.map(table => tables.set(table.name, table.type));
            // console.log('setting up deserializer on ' + process.env['worker_queue']);
            ch.prefetch(dSprefecthCount);
            ch.consume(process.env['worker_queue'], (data) => {
                consumerQueue.push(data);
            });
        }
        if (msg.event === 'connect_ws') {
            allowStreaming = true;
        }
    });
}

module.exports = {run};
