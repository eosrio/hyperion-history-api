const pmx = require('pmx');
const async = require('async');
const {Api, Serialize} = require('eosjs');
const {deserialize, serialize} = require('../helpers/functions');
const {debugLog} = require("../helpers/functions");

const {ConnectionManager} = require('../connections/manager');
const manager = new ConnectionManager();

const txDec = new TextDecoder();
const txEnc = new TextEncoder();

let ch, api, abi, ship, types, cch, rpc;
let cch_ready = false;
let tables = new Map();
let chainID = null;
let local_block_num = parseInt(process.env.first_block) - 1;
let currentIdx = 1;
let drainCount = 0;
let local_distributed_count = 0;
let lastPendingCount = 0;
let reconnectCount = 0;
let completionSignaled = false;
let completionMonitoring = null;

let allowRequests = true;
let pendingRequest = null;

let recovery = false;
let local_last_block = 0;

const qStatusMap = {};
const queue_prefix = process.env.CHAIN;
const queue = queue_prefix + ':blocks';
const n_deserializers = process.env.DESERIALIZERS;
const maxMessagesInFlight = parseInt(process.env.READ_PREFETCH, 10);
let range_size = parseInt(process.env.last_block) - parseInt(process.env.first_block);

const blockReadingQueue = async.cargo(async.ensureAsync(processIncomingBlockArray), maxMessagesInFlight);
const stageOneDistQueue = async.cargo(async.ensureAsync(distribute), maxMessagesInFlight);

const baseRequest = {
    max_messages_in_flight: maxMessagesInFlight,
    have_positions: [],
    irreversible_only: false,
    fetch_block: process.env.FETCH_BLOCK === 'true',
    fetch_traces: process.env.FETCH_TRACES === 'true',
    fetch_deltas: true
};

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
    if (!completionSignaled) {
        completionSignaled = true;
        debugLog('reader ' + process.env['worker_id'] + ' signaled completion', range_size, local_distributed_count);
        local_distributed_count = 0;
        completionMonitoring = setInterval(() => {
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
                debugLog('reader ' + process.env['worker_id'] + ' completed', range_size, local_distributed_count);
                clearInterval(completionMonitoring);
                process.send({
                    event: 'completed',
                    id: process.env['worker_id']
                });
            }
        }, 200);
    }
}

function send(req_data) {
    ship.send(serialize('request', req_data, txEnc, txDec, types));
}

// State history request builder
function requestBlocks(start) {
    const first_block = start > 0 ? start : process.env.first_block;
    const last_block = start > 0 ? 0xffffffff : process.env.last_block;
    const request = baseRequest;
    request.start_block_num = parseInt(first_block > 0 ? first_block : '1', 10);
    request.end_block_num = parseInt(last_block, 10);
    console.log(request);
    send(['get_blocks_request_v0', request]);
}

function requestBlockRange(start, finish) {
    const request = baseRequest;
    request.start_block_num = parseInt(start, 10);
    request.end_block_num = parseInt(finish, 10);
    console.log(request);
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
        ship.close();
        process.exit(1);
    }
}

async function onMessage(data) {
    if (abi) {
        if (recovery) {
            let first = local_block_num;
            let last = local_last_block;
            if (last === 0) {
                last = process.env.last_block;
            }
            last = last - 1;
            if (first === 0) {
                first = process.env.first_block;
            }
            console.log(`Resuming stream from block ${first} to ${last}...`);
            if (last - first > 0) {
                requestBlockRange(first, last);
                recovery = false;
            } else {
                console.log('Invalid range!');
            }
        } else {
            if (process.env['worker_role']) {
                const res = deserialize('result', data, txEnc, txDec, types)[1];
                if (res['this_block']) {
                    const blk_num = res['this_block']['block_num'];
                    if (blk_num === local_block_num + 1) {
                        local_block_num = blk_num;
                        if (res['block'] || res['traces'] || res['deltas']) {
                            stageOneDistQueue.push({
                                num: blk_num,
                                content: data
                            });
                            return 1;
                        } else {
                            if (blk_num === 1) {
                                stageOneDistQueue.push({
                                    num: blk_num,
                                    content: data
                                });
                                return 1;
                            } else {
                                return 0;
                            }
                        }
                    } else {
                        console.log('missing block: ' + (local_block_num + 1) + ' last block:' + blk_num);
                        console.log(local_distributed_count);
                        ship.close();
                        process.exit(1);
                    }
                } else {
                    // console.log(res);
                    // console.log('no block from ' + process.env['worker_role']);
                    // if (process.env['worker_role'] === 'reader') {
                    //     if (local_distributed_count === range_size) {
                    //         signalReaderCompletion();
                    //     }
                    // }
                    return 0;
                }
            } else {
                console.log('something went wrong!');
                ship.close();
                process.exit(1);
            }
        }
    } else {
        processFirstABI(data);
        return 1;
    }
}

function distribute(data, cb) {
    recursiveDistribute(data, cch, cb);
}

function recursiveDistribute(data, channel, cb) {
    if (data.length > 0) {
        const q = queue + ":" + currentIdx;
        if (!qStatusMap[q]) {
            qStatusMap[q] = true;
        }
        if (qStatusMap[q] === true) {
            if (cch_ready) {
                const d = data.pop();
                const result = channel.sendToQueue(q, d.content, {
                    persistent: true,
                    mandatory: true,
                }, function (err) {
                    if (err !== null) {
                        console.log('Message nacked!');
                        console.log(err.message);
                    } else {
                        process.send({event: 'read_block'});
                    }
                });
                local_distributed_count++;
                debugLog(`Block Number: ${d.num} - Range progress: ${local_distributed_count}/${range_size}`);
                if (local_distributed_count === range_size) {
                    signalReaderCompletion();
                }
                currentIdx++;
                if (currentIdx > n_deserializers) {
                    currentIdx = 1;
                }
                if (result) {
                    if (data.length > 0) {
                        recursiveDistribute(data, channel, cb);
                    } else {
                        cb();
                    }
                } else {
                    // Send failed
                    qStatusMap[q] = false;
                    drainCount++;
                    // console.log(`[${process.env['worker_id']}]:[${drainCount}] Block with ${d.length} bytes waiting for queue [${q}] to drain!`);
                    setTimeout(() => {
                        recursiveDistribute(data, channel, cb);
                    }, 500);
                }
            } else {
                console.log('channel is not ready!');
            }
        } else {
            console.log(`waiting for [${q}] to drain!`);
        }
    } else {
        // console.log('no data');
        cb();
    }
}

function handleLostConnection() {
    recovery = true;
    ship.close();
    console.log(`Retrying connection in 5 seconds... [attempt: ${reconnectCount + 1}]`);
    debugLog('PENDING REQUESTS:', pendingRequest);
    debugLog('LOCAL BLOCK:', local_block_num);
    setTimeout(() => {
        reconnectCount++;
        startWS();
    }, 5000);
}

function startWS() {
    ship.connect(blockReadingQueue.push, handleLostConnection);
}

function onPmxStop(reply) {
    if (process.env['worker_role'] === 'continuous_reader') {
        console.log('[LIVE READER] Closing Websocket');
        reply({ack: true});
        ship.close();
        setTimeout(() => {
            console.log('[LIVE READER] Process killed');
            process.exit(1);
        }, 5000);
    }
}

function onIpcMessage(msg) {
    if (msg.event === 'new_range') {
        if (msg.target === process.env.worker_id) {
            debugLog(`new_range [${msg.data.first_block},${msg.data.last_block}]`);
            local_distributed_count = 0;
            clearInterval(completionMonitoring);
            completionMonitoring = null;
            completionSignaled = false;
            local_last_block = msg.data.last_block;
            range_size = parseInt(msg.data.last_block) - parseInt(msg.data.first_block);
            if (allowRequests) {
                requestBlockRange(msg.data.first_block, msg.data.last_block);
                pendingRequest = null;
            } else {
                pendingRequest = [msg.data.first_block, msg.data.last_block];
            }
        }
    }
}

function startQueueWatcher() {
    setInterval(() => {
        let checkArr = [];
        for (let i = 0; i < n_deserializers; i++) {
            const q = queue + ":" + (i + 1);
            checkArr.push(manager.checkQueueSize(q));
        }
        Promise.all(checkArr).then(data => {
            if (data.some(el => el > process.env.QUEUE_THRESH)) {
                allowRequests = false;
            } else {
                allowRequests = true;
                if (pendingRequest) {
                    processPending();
                }
            }
        });
    }, 5000);
}

function assertQueues() {
    for (let i = 0; i < n_deserializers; i++) {
        ch.assertQueue(queue + ":" + (i + 1), {
            durable: true
        });
        ch.on('drain', function () {
            console.log('drain...');
            qStatusMap[queue + ":" + (i + 1)] = true;
        })
    }
    if (cch) {
        cch_ready = true;
        stageOneDistQueue.resume();
        cch.on('close', () => {
            cch_ready = false;
            stageOneDistQueue.pause();
        });
    }
}

function processPending() {
    requestBlockRange(pendingRequest[0], pendingRequest[1]);
    pendingRequest = null;
}

function createNulledApi(chainID) {
    return new Api({
        "rpc": rpc,
        signatureProvider: null,
        chainId: chainID,
        textDecoder: txDec,
        textEncoder: txEnc,
    });
}

async function run() {

    pmx['action']('stop', onPmxStop);

    rpc = manager.nodeosJsonRPC;
    const chain_data = await rpc.get_info();
    chainID = chain_data.chain_id;
    api = createNulledApi(chainID);

    // Connect to RabbitMQ (amqplib) ch = Channel; cch = ConfirmChannel
    [ch, cch] = await manager.createAMQPChannels((channels) => {
        [ch, cch] = channels;
        assertQueues();
    });

    // Assert stage 1
    assertQueues();

    // Queue size watcher
    startQueueWatcher();

    // Connect to StateHistory via WebSocket
    ship = manager.shipClient;
    startWS();

    // Handle IPC Messages
    process.on('message', onIpcMessage);
}

module.exports = {run};
