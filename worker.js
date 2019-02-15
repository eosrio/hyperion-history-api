const amqp = require('amqplib');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const {Api, JsonRpc, Serialize} = require('eosjs');
const asyncTimedCargo = require('async-timed-cargo');
const {routes} = require("./elastic-routes");
const zlib = require('zlib');
const _ = require('lodash');
const elasticsearch = require("elasticsearch");
const {action_blacklist} = require('./blacklists');
const prettyjson = require('prettyjson');

const eos_endpoint = process.env.NODEOS_HTTP;
const rpc = new JsonRpc(eos_endpoint, {fetch});

let ch, api, abi, ws, types, client, cch;
let tables = new Map();
let chainID = null;
let act_emit_idx = 1;
let tx_emit_idx = 1;
let block_emit_idx = 1;
let local_block_num = 0;
let currentIdx = 1;

const queue_prefix = process.env.CHAIN;
const queue = queue_prefix + ':blocks';
const index_queue_prefix = queue_prefix + ':index';
const index_queues = [
    {type: 'action', name: index_queue_prefix + "_actions"},
    {type: 'transaction', name: index_queue_prefix + "_transactions"},
    {type: 'block', name: index_queue_prefix + "_blocks"}
];

const n_deserializers = process.env.DESERIALIZERS;
const n_ingestors_per_queue = process.env.ES_INDEXERS_PER_QUEUE;

// Stage 1 reader prefetch
const maxMessagesInFlight = parseInt(process.env.READ_PREFETCH, 10);
// Stage 2 consumer prefecth
const dSprefecthCount = parseInt(process.env.BLOCK_PREFETCH, 10);
// Stage 3 consumer prefetch
const indexingPrefecthCount = parseInt(process.env.INDEX_PREFETCH, 10);

// Async Cargos
const blockReadingQueue = asyncTimedCargo(processIncomingBlockArray, maxMessagesInFlight, 200);

const indexQueue = asyncTimedCargo((payload, callback) => {
    routes[process.env.type](payload, callback, ch);
}, indexingPrefecthCount, 1000);

const consumerQueue = asyncTimedCargo(processPayload, dSprefecthCount, 1000);

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
    const status = [];
    for (const message of messages) {
        const ds_msg = deserialize('result', message.content);
        const res = ds_msg[1];
        let block, traces = [], deltas = [];
        if (res.block && res.block.length) {
            block = deserialize('signed_block', res.block);
            // block.transactions.forEach((trx) => {
            //     if (trx.status !== 0) {
            //         console.log(trx.status, trx.trx[1].toLowerCase());
            //     }
            // });
        }
        if (res['traces'] && res['traces'].length) {
            traces = deserialize('transaction_trace[]', zlib.unzipSync(res['traces']));
        }
        if (res['deltas'] && res['deltas'].length) {
            deltas = deserialize('table_delta[]', zlib.unzipSync(res['deltas']));
        }

        const result = await processBlock(res, block, traces, deltas);
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
        status.push(true);
    }
    return status;
}

async function processTrx(ts, trx_trace, block_num) {
    const trx = {
        id: trx_trace['id'].toLowerCase(),
        timestamp: ts,
        block_num: block_num
    };
    // Distribute light transactions to indexer queues
    const q = index_queue_prefix + "_transactions:" + (tx_emit_idx);
    ch.sendToQueue(q, Buffer.from(JSON.stringify(trx)));
    tx_emit_idx++;
    if (tx_emit_idx > n_ingestors_per_queue) {
        tx_emit_idx = 1;
    }
    return true;
}

// Stage 2 - Action handler
async function processAction(ts, action, trx_id, block_num, prod, parent, depth) {
    const code = action['act']['account'];
    const name = action['act']['name'];
    if (!action_blacklist.includes(`${code}:${name}`)) {
        action['receipt'] = action['receipt'][1];
        let g_seq;
        if (parent !== null) {
            g_seq = parent;
        } else {
            g_seq = action['receipt']['global_sequence'];
        }
        let act = action['act'];
        const original_act = Object.assign({}, act);
        act.data = new Uint8Array(Object.values(act.data));
        const actions = [];
        actions.push(act);
        let ds_act;
        try {
            ds_act = await api.deserializeActions(actions);
            action['act'] = ds_act[0];

            // Process extra data indices
            if (action['act']['name'] === 'transfer') {
                const qtd = action['act']['data']['quantity'].split(' ');
                action['@data'] = {
                    'transfer': {
                        'from': action['act']['data']['from'],
                        'to': action['act']['data']['to'],
                        'amount': parseFloat(qtd[0]),
                        'symbol': qtd[1]
                    }
                };
            }

            // New account
            if (action['act']['name'] === 'newaccount' && action['act']['account'] === 'eosio') {
                action['@data'] = {
                    'newaccount': {
                        'newact': action['act']['data']['newact']
                    }
                };
            }

        } catch (e) {
            // console.log('----------------------------');
            // console.log('Deserialization Error:', e.message);
            action['act'] = original_act;
            action['act']['data'] = Buffer.from(action['act']['data']).toString('hex');
            // console.log(action['act']);
            // console.log('----------------------------');
        }
        process.send({event: 'ds_action'});
        action['timestamp'] = ts;
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
        if (action['inline_traces'].length > 0) {
            g_seq = action['receipt']['global_sequence'];
            for (const inline_trace of action['inline_traces']) {
                await processAction(ts, inline_trace[1], trx_id, block_num, prod, g_seq, depth + 1);
            }
        }
        delete action['inline_traces'];

        // Distribute actions to indexer queues
        const q = index_queue_prefix + "_actions:" + (act_emit_idx);
        ch.sendToQueue(q, Buffer.from(JSON.stringify(action)));
        act_emit_idx++;
        if (act_emit_idx > n_ingestors_per_queue) {
            act_emit_idx = 1;
        }
        return true;
    } else {
        return false;
    }
}

async function processDeferred(data, block_num) {
    if (data['packed_trx']) {
        const sb_trx = new Serialize.SerialBuffer({
            textEncoder: new TextEncoder,
            textDecoder: new TextDecoder,
            array: Serialize.hexToUint8Array(data['packed_trx'])
        });
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

async function processDeltas(deltas, block_num) {

    const deltaStruct = {};
    for (const table_delta of deltas) {
        if (table_delta[0] === "table_delta_v0") {
            deltaStruct[table_delta[1].name] = table_delta[1].rows;
        }
    }

    // Generated transactions
    if (deltaStruct['generated_transaction']) {
        const rows = deltaStruct['generated_transaction'];
        for (const gen_trx of rows) {
            const serialBuffer = new Serialize.SerialBuffer({
                textEncoder: new TextEncoder,
                textDecoder: new TextDecoder,
                array: gen_trx.data
            });
            const data = types.get('generated_transaction').deserialize(serialBuffer);
            await processDeferred(data[1], block_num);
        }
    }

    // Contract Rows
    if (deltaStruct['contract_row']) {
        const rows = deltaStruct['contract_row'];
        for (const row of rows) {
            const sb = new Serialize.SerialBuffer({
                textEncoder: new TextEncoder,
                textDecoder: new TextDecoder,
                array: new Uint8Array(Object.values(row.data))
            });
            try {
                const jsonRow = await processContractRow({
                    row_version: sb.get(),
                    code: sb.getName(),
                    scope: sb.getName(),
                    table: sb.getName(),
                    primary_key: sb.getUint64AsNumber(),
                    payer: sb.getName(),
                    data_raw: sb.getBytes()
                }, block_num);
                if (jsonRow['code'] === 'eosio') {
                    if (!table_blacklist.includes(jsonRow['table'])) {
                        console.log(jsonRow);
                    }
                }
            } catch (e) {
                console.log(e);
            }
        }
    }
}

const table_blacklist = ['global', 'global2', 'global3', 'producers'];

async function processContractRow(row) {
    const row_sb = new Serialize.SerialBuffer({
        textEncoder: new TextEncoder,
        textDecoder: new TextDecoder,
        array: row['data_raw']
    });
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

let local_block_count = 0;

// Stage 2 - Block handler
async function processBlock(res, block, traces, deltas) {
    if (!res['this_block']) {
        console.log(res);
        return null;
    } else {
        const producer = block['producer'];
        const ts = block['timestamp'];
        const block_num = res['this_block']['block_num'];
        const light_block = {
            block_num: res['this_block']['block_num'],
            producer: block['producer'],
            new_producers: block['new_producers'],
            timestamp: block['timestamp'],
            schedule_version: block['schedule_version']
        };
        const q = index_queue_prefix + "_blocks:" + (block_emit_idx);
        ch.sendToQueue(q, Buffer.from(JSON.stringify(light_block)));
        block_emit_idx++;
        if (block_emit_idx > n_ingestors_per_queue) {
            block_emit_idx = 1;
        }

        local_block_count++;

        if (deltas && process.env.FETCH_DELTAS === 'true') {
            await processDeltas(deltas, res['this_block']['block_num']);
        }

        if (traces.length > 0) {
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

        return {
            block_num: res['this_block']['block_num'],
            size: traces.length
        };
    }
}

function processIncomingBlockArray(payload, cb) {
    processIncomingBlocks(payload).then(() => {
        cb();
    }).catch((err) => {
        console.log('FATAL ERROR READING BLOCKS', err);
        process.exit(1);
    })
}

async function processIncomingBlocks(block_array) {
    if (abi) {
        send(['get_blocks_ack_request_v0', {num_messages: block_array.length}]);
    }
    for (const block of block_array) {
        await onMessage(block);
    }
    return true;
}

// State history message handler
const range_size = parseInt(process.env.last_block) - parseInt(process.env.first_block);
let local_distributed_count = 0;

async function onMessage(data) {
    if (!abi) {
        abi = JSON.parse(data);
        types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), abi);
        abi.tables.map(table => tables.set(table.name, table.type));
        switch (process.env['worker_role']) {
            case 'reader':
                requestBlocks(0);
                break;
            case 'deserializer':
                ch.prefetch(dSprefecthCount);
                ch.consume(process.env['worker_queue'], (data) => {
                    consumerQueue.push(data);
                });
                break;
            case 'continuous_reader':
                requestBlocks(parseInt(process.env['worker_last_processed_block'], 10));
                break;
        }
        send(['get_blocks_ack_request_v0', {num_messages: 1}]);
        return 1;
    } else {
        if (process.env['worker_role']) {
            const res = deserialize('result', data)[1];
            if (res['this_block']) {
                const blk_num = res['this_block']['block_num'];
                if (blk_num > local_block_num) {
                    local_block_num = blk_num;
                }
                stageOneDistQueue.push(data);
                if (local_distributed_count === range_size) {
                    console.log('Range finished!');
                    process.exit(1);
                } else {
                    return 1;
                }
            } else {
                if (process.env['worker_role'] === 'reader') {
                    // console.log(process.env['worker_role'], process.env['worker_id'], 'Last read block', local_block_num);
                    if (local_distributed_count === range_size) {
                        console.log('Range finished!');
                        process.exit(1);
                    }
                }
                return 0;
            }
        } else {
            console.log('something went wrong!');
            process.exit(1);
        }
    }
}

function send(req_data) {
    ws.send(serialize('request', req_data));
}

// State history request builder
function requestBlocks(start) {
    const first_block = start > 0 ? start : process.env.first_block;
    const last_block = start > 0 ? 0xffffffff : process.env.last_block;
    const request = {
        start_block_num: parseInt(first_block > 0 ? first_block : '1', 10),
        end_block_num: parseInt(last_block, 10),
        max_messages_in_flight: maxMessagesInFlight,
        have_positions: [],
        irreversible_only: false,
        fetch_block: true,
        fetch_traces: true,
        fetch_deltas: process.env.FETCH_DELTAS === 'true'
    };
    send(['get_blocks_request_v0', request]);
}

const stageOneDistQueue = asyncTimedCargo(distribute, 20, 2000);
const qStatusMap = {};

async function distribute(data, cb) {
    recusiveDistribute(data, cb).catch((err) => {
        console.log(err);
    });
}

let drainCount = 0;

async function recusiveDistribute(data, cb) {
    if (data.length > 0) {
        const q = queue + ":" + currentIdx;
        // Set unknown status as true
        if (!qStatusMap[q]) {
            qStatusMap[q] = true;
        }
        if (qStatusMap[q] === true) {
            const d = data.pop();
            const result = await cch.sendToQueue(q, d);
            local_distributed_count++;
            process.send({event: 'read_block'});
            currentIdx++;
            if (currentIdx > n_deserializers) {
                currentIdx = 1;
            }
            if (!result) {
                // Send failed
                qStatusMap[q] = false;
                drainCount++;
                console.log(`[${process.env['worker_id']}]:[${drainCount}] Block with ${d.length} bytes waiting for queue [${q}] to drain!`);
                setTimeout(() => {
                    recusiveDistribute(data, cb).catch((err) => {
                        console.log(err);
                    })
                }, 200)
            } else {
                recusiveDistribute(data, cb).catch((err) => {
                    console.log(err);
                })
            }
        } else {
            console.log(`waiting for [${q}] to drain!`);
        }
    } else {
        cb();
    }
}

function serialize(type, value) {
    const buffer = new Serialize.SerialBuffer({textEncoder: new TextEncoder, textDecoder: new TextDecoder});
    Serialize.getType(types, type).serialize(buffer, value);
    return buffer.asUint8Array();
}

function deserialize(type, array) {
    const buffer = new Serialize.SerialBuffer({textEncoder: new TextEncoder, textDecoder: new TextDecoder, array});
    return Serialize.getType(types, type).deserialize(buffer, new Serialize.SerializerState({bytesAsUint8Array: true}));
}

async function main() {
    const chain_data = await rpc.get_info();
    chainID = chain_data.chain_id;
    api = new Api({
        "rpc": rpc,
        signatureProvider: null,
        chainId: chain_data.chain_id,
        textDecoder: new TextDecoder(),
        textEncoder: new TextEncoder(),
    });

    // Connect to RabbitMQ (amqplib)
    const amqp_username = process.env.AMQP_USER;
    const amqp_password = process.env.AMQP_PASS;
    const amqp_host = process.env.AMQP_HOST;
    const amqp_vhost = 'hyperion';
    const amqp_url = `amqp://${amqp_username}:${amqp_password}@${amqp_host}/%2F${amqp_vhost}`;
    const connection = await amqp.connect(amqp_url);
    ch = await connection.createChannel();
    cch = await connection.createConfirmChannel();

    // Assert stage 1 and 2 queues
    if (process.env['worker_role'] === 'reader' || process.env['worker_role'] === 'deserializer') {
        for (let i = 0; i < n_deserializers; i++) {
            ch.assertQueue(queue + ":" + (i + 1), {durable: true});
            ch.on('drain', function () {
                qStatusMap[queue + ":" + (i + 1)] = true;
            })
        }
    }

    // Assert stage 3 queues
    if (process.env['worker_role'] === 'deserializer') {
        index_queues.forEach((q) => {
            for (let i = 0; i < n_ingestors_per_queue; i++) {
                ch.assertQueue(q.name + ":" + (i + 1), {durable: true});
            }
        });
    }

    // Assert stage 4 queues
    if (process.env['worker_role'] === 'ingestor') {
        ch.assertQueue(process.env['queue'], {durable: true});
    }

    // Connect to StateHistory via WebSocket
    if (process.env['worker_role'] !== 'ingestor') {
        ws = new WebSocket(process.env.NODEOS_WS, null, {perMessageDeflate: false});
        ws.on('message', blockReadingQueue.push);
    } else {
        // Connect to elasticsearch
        client = new elasticsearch.Client({
            host: process.env.ES_HOST
        });
        try {
            ch.prefetch(indexingPrefecthCount);
            ch.consume(process.env['queue'], indexQueue.push);
        } catch (e) {
            console.error('elasticsearch cluster is down!');
            process.exit(1);
        }
    }
}

module.exports = {main};
