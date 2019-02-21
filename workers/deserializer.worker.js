const {Api, Serialize} = require('eosjs');
const _ = require('lodash');
const {action_blacklist} = require('../definitions/blacklists');
const prettyjson = require('prettyjson');
const {AbiDefinitions} = require("../definitions/abi_def");
const {deserialize, unzipAsync} = require('../helpers/functions');

const async = require('async');
const {amqpConnect} = require("../connections/rabbitmq");
const {connectRpc} = require("../connections/chain");

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

const ds_blacklist = new Set();
const table_blacklist = ['global', 'global2', 'global3', 'producers'];

const queue_prefix = process.env.CHAIN;
const queue = queue_prefix + ':blocks';
const index_queue_prefix = queue_prefix + ':index';
const index_queues = require('../definitions/index-queues').index_queues;
const n_deserializers = process.env.DESERIALIZERS;
const n_ingestors_per_queue = process.env.ES_INDEXERS_PER_QUEUE;
const action_indexing_ratio = process.env.ES_ACT_QUEUES;

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

        // return {block_num: res['this_block']['block_num'],size: traces.length};

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
                        const status = await processAction(ts, action, trx_id, block_num, producer, null, 0);
                        if (status) {
                            action_count++;
                        }
                    }
                }
                if (action_count > 0) {
                    await processTrx(ts, transaction_trace, block_num);
                }
            }
        }
        return {block_num: res['this_block']['block_num'], size: traces.length};
    }
}

async function processTrx(ts, trx_trace, block_num) {
    const trx = {
        id: trx_trace['id'].toLowerCase(),
        '@timestamp': ts,
        block_num: block_num
    };
    if (process.env.ENABLE_INDEXING === 'true') {
        // Distribute light transactions to indexer queues
        const q = index_queue_prefix + "_transactions:" + (tx_emit_idx);
        const status = ch.sendToQueue(q, Buffer.from(JSON.stringify(trx)));
        if (!status) {
            // console.log('Transaction Indexing:', status);
        }
        tx_emit_idx++;
        if (tx_emit_idx > n_ingestors_per_queue) {
            tx_emit_idx = 1;
        }
    }
    return true;
}

async function processAction(ts, action, trx_id, block_num, prod, parent, depth, parent_act) {
    const code = action['act']['account'];
    const name = action['act']['name'];
    if (!action_blacklist.has(`${code}:${name}`)) {
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
        const actionCode = original_act['account'] + ":" + original_act['name'];
        try {
            if (ds_blacklist.has(actionCode)) {
                process.send({
                    event: 'ds_error',
                    gs: action['receipt']['global_sequence']
                });
                action['act'] = original_act;
                action['act']['data'] = Buffer.from(action['act']['data']).toString('hex');
            } else {
                ds_act = await api.deserializeActions(actions);
                action['act'] = ds_act[0];
                if (name === 'setabi' && code === 'eosio') {
                    const abi_hex = action['act']['data']['abi'];
                    const _types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), AbiDefinitions);
                    const buffer = createSerialBuffer(Serialize.hexToUint8Array(abi_hex));
                    const abiJSON = JSON.stringify(_types.get('abi_def').deserialize(buffer));
                    await client['index']({
                        index: process.env.CHAIN + '-abi',
                        type: '_doc',
                        body: {
                            block: block_num,
                            code: action['act']['data']['account'],
                            abi: abiJSON,
                            '@timestamp': ts
                        }
                    });
                }
                attachActionExtras(action);
            }
        } catch (e) {
            // console.log(e);
            ds_blacklist.add(actionCode);
            process.send({
                t: 'ds_fail',
                v: {
                    gs: action['receipt']['global_sequence']
                }
            });
            // Revert to defaults
            action['act'] = original_act;
            action['act']['data'] = Buffer.from(action['act']['data']).toString('hex');
        }
        process.send({event: 'ds_action'});
        action['@timestamp'] = ts;
        action['block_num'] = block_num;
        action['producer'] = prod;
        action['trx_id'] = trx_id;
        action['depth'] = depth;
        if (parent !== null) {
            action['parent'] = {
                root: false,
                seq: g_seq
            };
        } else {
            action['parent'] = {
                root: true
            };
        }

        delete action['console'];

        const actDataString = JSON.stringify(action['act']['data']);

        if (action['inline_traces'].length > 0) {
            g_seq = action['receipt']['global_sequence'];
            for (const inline_trace of action['inline_traces']) {
                const notified = await processAction(ts, inline_trace[1], trx_id, block_num, prod, g_seq, depth + 1, actDataString);
                // Merge notifications with the parent action
                for (const acct of notified) {
                    notifiedAccounts.add(acct);
                }
            }
        }

        delete action['inline_traces'];
        delete action['except'];
        delete action['context_free'];

        action['global_sequence'] = parseInt(action['receipt']['global_sequence'], 10);
        delete action['receipt'];

        action['elapsed'] = parseInt(action['elapsed'], 10);

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
                // ch.publish('', queue_prefix + ':stream', payload, {
                //     headers: {
                //         account: action['act']['account'],
                //         name: action['act']['name']
                //     }
                // });
            }
        }

        if (parent !== null) {
            return notifiedAccounts;
        } else {
            return true;
        }
    } else {
        return false;
    }
}

function attachActionExtras(action) {

    // Transfer actions
    if (action['act']['name'] === 'transfer') {
        const qtd = action['act']['data']['quantity'].split(' ');

        action['act']['data']['from'] = String(action['act']['data']['from']);
        action['act']['data']['to'] = String(action['act']['data']['to']);
        action['act']['data']['amount'] = parseFloat(qtd[0]);
        action['act']['data']['symbol'] = qtd[1];

    } else if (action['act']['name'] === 'newaccount' && action['act']['account'] === 'eosio') {
        let name = null;
        if (action['act']['data']['newact']) {
            name = action['act']['data']['newact'];
        } else if (action['act']['data']['name']) {
            name = action['act']['data']['name'];
            delete action['act']['data']['name'];
        }
        if (name) {
            action['act']['data']['newact'] = String(name);
            action['@newaccount'] = {
                active: action['act']['data']['active'],
                owner: action['act']['data']['owner']
            }
        }
        // await handleNewAccount(action['act']['data'], action, ts);
    } else if (action['act']['name'] === 'updateauth' && action['act']['account'] === 'eosio') {
        // await handleUpdateAuth(action['act']['data'], action, ts);
    }
}

async function processDeltas(deltas, block_num) {

    const deltaStruct = {};
    for (const table_delta of deltas) {
        if (table_delta[0] === "table_delta_v0") {
            deltaStruct[table_delta[1].name] = table_delta[1].rows;
        }
    }

    // if (deltaStruct['account']) {
    //     const rows = deltaStruct['account'];
    //     for (const account_raw of rows) {
    //         const serialBuffer = createSerialBuffer(account_raw.data);
    //         const data = types.get('account').deserialize(serialBuffer);
    //         const account = data[1];
    //         if (account['abi'] !== '') {
    //             const new_abi_object = {
    //                 account: account['name'],
    //                 block: block_num,
    //                 abi: account['abi']
    //             };
    //             // console.log(new_abi_object.block, new_abi_object.account);
    //             const q = index_queue_prefix + "_abis:1";
    //             ch.sendToQueue(q, Buffer.from(JSON.stringify(new_abi_object)));
    //             process.send({
    //                 event: 'save_abi',
    //                 data: new_abi_object
    //             });
    //         }
    //     }
    // }

    if (process.env.ABI_CACHE_MODE === 'false') {
        // Generated transactions
        if (deltaStruct['generated_transaction']) {
            const rows = deltaStruct['generated_transaction'];
            for (const gen_trx of rows) {
                const serialBuffer = createSerialBuffer(gen_trx.data);
                const data = types.get('generated_transaction').deserialize(serialBuffer);
                await processDeferred(data[1], block_num);
            }
        }

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
                            // console.log(jsonRow);
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
        if (data['delay_sec'] > 0) {
            console.log(`-------------- ${block_num} -----------------`);
            console.log(prettyjson.render(data));
        }
    }
}

async function run() {

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

    // Connect to RabbitMQ (amqplib)
    [ch, cch] = await amqpConnect();

    // Assert stage 1
    for (let i = 0; i < n_deserializers; i++) {
        ch.assertQueue(queue + ":" + (i + 1), {
            durable: true
        });
    }

    index_queues.forEach((q) => {
        for (let i = 0; i < n_ingestors_per_queue; i++) {
            ch.assertQueue(q.name + ":" + (i + 1), {durable: true});
        }
    });

    process.on('message', (msg) => {
        if (msg.event === 'initialize_abi') {
            abi = JSON.parse(msg.data);
            types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), abi);
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
