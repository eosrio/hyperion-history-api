const async = require('async');
const {connectRpc} = require("../connections/chain");
const {Api, Serialize} = require('eosjs');
const {deserialize, serialize} = require('../helpers/functions');
const {connectStateHistorySocket} = require("../connections/state-history");
const {amqpConnect} = require("../connections/rabbitmq");
const pmx = require('pmx');

const txDec = new TextDecoder();
const txEnc = new TextEncoder();

let ch, api, abi, ws, types, cch, rpc;
let tables = new Map();
let chainID = null;
let local_block_num = 0;
let currentIdx = 1;
let drainCount = 0;
let local_distributed_count = 0;
let lastPendingCount = 0;

const qStatusMap = {};
const queue_prefix = process.env.CHAIN;
const queue = queue_prefix + ':blocks';
const n_deserializers = process.env.DESERIALIZERS;
const maxMessagesInFlight = parseInt(process.env.READ_PREFETCH, 10);
const range_size = parseInt(process.env.last_block) - parseInt(process.env.first_block);

const blockReadingQueue = async.cargo(async.ensureAsync(processIncomingBlockArray), maxMessagesInFlight);
const stageOneDistQueue = async.cargo(async.ensureAsync(distribute), maxMessagesInFlight);

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
        send([
            'get_blocks_ack_request_v0',
            {num_messages: block_array.length}
        ]);
        for (const block of block_array) {
            try {
                await onMessage(block);
            } catch (e) {
                console.log(e);
            }
        }
    } else {
        await onMessage(block_array[0]);
    }
    return true;
}

function signalReaderCompletion() {
    // Monitor pending messages
    setInterval(() => {
        let pending = 0;
        if (cch.unconfirmed.length > 0) {
            cch.unconfirmed.forEach((elem) => {
                if (elem) {
                    pending++;
                }
            });
            if (pending === lastPendingCount && pending > 0) {
                // console.log(`[${process.env['worker_id']}] Pending blocks: ${pending}`);
            } else {
                lastPendingCount = pending;
            }
        }
        if (pending === 0) {
            process.send({
                event: 'completed',
                id: process.env['worker_id']
            });
            ch.close();
            process.exit(1);
        }
    }, 1000);
}

function send(req_data) {
    ws.send(serialize('request', req_data, txEnc, txDec, types));
}

// State history request builder
function requestBlocks(start) {
    const first_block = start > 0 ? start : process.env.first_block;
    const last_block = start > 0 ? 0xffffffff : process.env.last_block;
    // console.log(`REQUEST - ${process.env.first_block} >> ${process.env.last_block}`);
    const request = {
        start_block_num: parseInt(first_block > 0 ? first_block : '1', 10),
        end_block_num: parseInt(last_block, 10),
        max_messages_in_flight: maxMessagesInFlight,
        have_positions: [],
        irreversible_only: false,
        fetch_block: process.env.FETCH_BLOCK === 'true',
        fetch_traces: process.env.FETCH_TRACES === 'true',
        fetch_deltas: true
    };
    send(['get_blocks_request_v0', request]);
}

function processFirstABI(data) {
    abi = JSON.parse(data);
    types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), abi);
    abi.tables.map(table => tables.set(table.name, table.type));
    process.send({
        event: 'init_abi',
        data: data
    });
    if (process.env.DISABLE_READING !== 'true') {
        switch (process.env['worker_role']) {
            case 'reader': {
                requestBlocks(0);
                break;
            }
            case 'continuous_reader': {
                requestBlocks(parseInt(process.env['worker_last_processed_block'], 10));
                break;
            }
        }
    } else {
        ws.close();
        process.exit(1);
    }
}

async function onMessage(data) {
    if (abi) {
        if (process.env['worker_role']) {
            const res = deserialize('result', data, txEnc, txDec, types)[1];
            if (res['this_block']) {
                const blk_num = res['this_block']['block_num'];
                if (blk_num > local_block_num) {
                    local_block_num = blk_num;
                }
                stageOneDistQueue.push(data);
                if (local_distributed_count === range_size) {
                    signalReaderCompletion();
                } else {
                    return 1;
                }
            } else {
                if (process.env['worker_role'] === 'reader') {
                    if (local_distributed_count === range_size) {
                        signalReaderCompletion();
                    }
                }
                return 0;
            }
        } else {
            console.log('something went wrong!');
            process.exit(1);
        }
    } else {
        processFirstABI(data);
        return 1;
    }
}

function distribute(data, cb) {
    recusiveDistribute(data, cch, cb);
}

function recusiveDistribute(data, channel, cb) {
    if (data.length > 0) {
        const q = queue + ":" + currentIdx;
        if (!qStatusMap[q]) {
            qStatusMap[q] = true;
        }
        if (qStatusMap[q] === true) {
            const d = data.pop();
            const result = channel.sendToQueue(q, d, {
                persistent: true,
                mandatory: true,
            }, function (err) {
                if (err !== null) {
                    console.log('Message nacked!');
                    console.log(err);
                } else {
                    process.send({event: 'read_block'});
                }
            });
            local_distributed_count++;
            currentIdx++;
            if (currentIdx > n_deserializers) {
                currentIdx = 1;
            }
            if (result) {
                if (data.length > 0) {
                    recusiveDistribute(data, channel, cb);
                } else {
                    cb();
                }
            } else {
                // Send failed
                qStatusMap[q] = false;
                drainCount++;
                // console.log(`[${process.env['worker_id']}]:[${drainCount}] Block with ${d.length} bytes waiting for queue [${q}] to drain!`);
                setTimeout(() => {
                    recusiveDistribute(data, channel, cb);
                }, 500);
            }
        } else {
            console.log(`waiting for [${q}] to drain!`);
        }
    } else {
        cb();
    }
}

async function run() {

    pmx.action('stop', (reply) => {
        if (process.env['worker_role'] === 'continuous_reader') {
            console.info('[READER] Closing Websocket');
            reply({ack: true});
            ws.close();
        }
    });

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
        ch.on('drain', function () {
            qStatusMap[queue + ":" + (i + 1)] = true;
        })
    }

    // Connect to StateHistory via WebSocket
    ws = connectStateHistorySocket(blockReadingQueue.push);
}

module.exports = {run};
