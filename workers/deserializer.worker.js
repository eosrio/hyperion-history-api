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
let tx_emit_idx = 1;
let block_emit_idx = 1;
let local_block_count = 0;
let allowStreaming = false;
let cachedMap;
let contracts = new Map();

const table_blacklist = ['global', 'global2', 'global3', 'producers'];

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

// Stage 2 - Deserialization function
async function processMessages(messages) {
    for (const message of messages) {
        const ds_msg = deserialize('result', message.content, txEnc, txDec, types);
        const res = ds_msg[1];
        let block, traces = [], deltas = [];
        if (res.block && res.block.length) {
            block = deserialize('signed_block', res.block, txEnc, txDec, types);
        }
        if (res['traces'] && res['traces'].length) {
            const unpackedTraces = await unzipAsync(res['traces']);
            traces = deserialize('transaction_trace[]', unpackedTraces, txEnc, txDec, types);
        }
        if (res['deltas'] && res['deltas'].length) {
            const unpackedDeltas = await unzipAsync(res['deltas']);
            deltas = deserialize('table_delta[]', unpackedDeltas, txEnc, txDec, types);
        }
        let result;
        try {
            // const t0 = Date.now();
            result = await processBlock(res, block, traces, deltas);
            // console.log(`processBlock elapsed ${Date.now() - t0}ms`);
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

        if (deltas && process.env.FETCH_DELTAS === 'true') {
            await processDeltas(deltas, res['this_block']['block_num']);
        }

        if (traces.length > 0 && process.env.FETCH_TRACES === 'true') {
            for (const trace of traces) {
                const transaction_trace = trace[1];
                let action_count = 0;
                const trx_id = transaction_trace['id'].toLowerCase();
                const action_traces = transaction_trace['action_traces'];
                for (const action_trace of action_traces) {
                    if (action_trace[0] === 'action_trace_v0') {
                        const action = action_trace[1];
                        const key = `${queue_prefix}::${action['act']['account']}::${action['act']['name']}`;
                        if (!action_blacklist.has(key)) {
                            const status = await processAction(ts, action, trx_id, block_num, producer, null, 0);
                            if (status) {
                                action_count++;
                            }
                        }
                    }
                }
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
            return savedContract['contract'];
        }
    }
    const savedAbi = await getAbiAtBlock(accountName, block_num);
    const abi = savedAbi.abi;
    const initialTypes = Serialize.createInitialTypes();
    const types = Serialize.getTypesFromAbi(initialTypes, abi);
    const actions = new Map();
    for (const {name, type} of abi.actions) {
        actions.set(name, Serialize.getType(types, type));
    }
    const result = {types, actions};
    contracts.set(accountName, {
        contract: result,
        valid_until: savedAbi.valid_until
    });
    return result;
}

async function deserializeActionsAtBlock(actions, block_num) {
    return await Promise.all(actions.map(async ({account, name, authorization, data}) => {
        const contract = await getContractAtBlock(account, block_num);
        return Serialize.deserializeAction(
            contract, account, name, authorization, data, txEnc, txDec);
    }));
}

async function processAction(ts, action, trx_id, block_num, prod, parent, parent_act) {
    action['receipt'] = action['receipt'][1];
    let g_seq;
    let notifiedAccounts = new Set();
    notifiedAccounts.add(action['receipt']['receiver']);
    if (parent !== null) {
        // Inline Mode
        g_seq = parent;
        // console.log(`inline - (${g_seq})`);
    } else {
        // Parent Mode
        g_seq = action['receipt']['global_sequence'];
        // console.log(`parent - (${g_seq})`);
    }
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
    if (parent !== null) {
        action['parent'] = g_seq;
    } else {
        action['parent'] = 0;
    }

    if (action['account_ram_deltas'].length === 0) {
        delete action['account_ram_deltas'];
    }

    delete action['console'];

    const actDataString = JSON.stringify(action['act']['data']);

    if (action['inline_traces'].length > 0) {
        g_seq = action['receipt']['global_sequence'];
        for (const inline_trace of action['inline_traces']) {
            const key = `${queue_prefix}::${action['act']['account']}::${action['act']['name']}`;
            if (!action_blacklist.has(key)) {
                const notified = await processAction(ts, inline_trace[1], trx_id, block_num, prod, g_seq, actDataString);
                // Merge notifications with the parent action
                for (const acct of notified) {
                    notifiedAccounts.add(acct);
                }
            }
        }
    }

    delete action['inline_traces'];
    delete action['except'];
    delete action['context_free'];

    action['global_sequence'] = parseInt(action['receipt']['global_sequence'], 10);
    delete action['receipt'];

    delete action['elapsed'];

    if (parent_act !== actDataString) {
        action['notified'] = Array.from(notifiedAccounts);
        const payload = Buffer.from(JSON.stringify(action));
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
                    account: action['act']['account'],
                    name: action['act']['name']
                }
            });
        }
    }

    if (parent !== null) {
        return notifiedAccounts;
    } else {
        return true;
    }
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
    }
}

async function processDeltas(deltas, block_num) {

    const deltaStruct = {};
    for (const table_delta of deltas) {
        if (table_delta[0] === "table_delta_v0") {
            deltaStruct[table_delta[1].name] = table_delta[1].rows;
        }
    }

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
                    // console.log(new_abi_object.block, new_abi_object.account);
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

    if (process.env.ABI_CACHE_MODE === 'false') {
        // Generated transactions

        // if (deltaStruct['generated_transaction']) {
        //     const rows = deltaStruct['generated_transaction'];
        //     for (const gen_trx of rows) {
        //         const serialBuffer = createSerialBuffer(gen_trx.data);
        //         const data = types.get('generated_transaction').deserialize(serialBuffer);
        //         await processDeferred(data[1], block_num);
        //     }
        // }

        // Contract Rows
        if (deltaStruct['contract_row']) {
            const rows = deltaStruct['contract_row'];
            for (const row of rows) {
                const sb = createSerialBuffer(new Uint8Array(Object.values(row.data)));
                try {
                    const jsonRow = await processContractRow({
                        present: sb.get(),
                        code: sb.getName(),
                        scope: sb.getName(),
                        table: sb.getName(),
                        primary_key: sb.getUint64AsNumber(),
                        payer: sb.getName(),
                        data_raw: sb.getBytes()
                    }, block_num);
                    if (jsonRow['code'] === 'eosio') {
                        if (!table_blacklist.includes(jsonRow['table'])) {
                            if (allowStreaming) {
                                const payload = Buffer.from(JSON.stringify(jsonRow));
                                ch.publish('', queue_prefix + ':stream', payload, {
                                    headers: {
                                        event: 'delta'
                                    }
                                });
                            }
                        }
                    }
                } catch (e) {
                    console.log(e);
                }
            }
        }
    }
}

async function processContractRow(row) {
    const row_sb = createSerialBuffer(row['data_raw']);
    row['data'] = (await getTableType(
        row['code'],
        row['table']
    )).deserialize(row_sb);
    return _.omit(row, ['data_raw']);
}

async function getTableType(code, table) {
    const contract = await api.getContract(code);
    const abi = await api.getAbi(code);
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
        console.error(`Could not find table "${table}" in the abi`);
        return;
    }
    return contract.types.get(type);
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
        // if (data['delay_sec'] > 0) {
        //     console.log(`-------------- ${block_num} -----------------`);
        //     console.log(prettyjson.render(data));
        // }
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
            const abi = JSON.parse(cachedAbiAtBlock);
            return {
                abi: abi,
                valid_until: validity
            }
        } else {
            return {
                abi: await api.getAbi(code),
                valid_until: null
            };
        }
    } else {
        return {
            abi: await api.getAbi(code),
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
            console.log('setting up deserializer on ' + process.env['worker_queue']);
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
