const async = require('async');
const {Api, Serialize} = require('eosjs');
const {deserialize, serialize} = require('../helpers/functions');
const {debugLog} = require("../helpers/functions");
const {ConnectionManager} = require('../connections/manager');
const manager = new ConnectionManager();
const txDec = new TextDecoder();
const txEnc = new TextEncoder();
const config = require(`../${process.env.CONFIG_JSON}`);

let ch, api, abi, ship, types, cch, rpc;

// elasticsearch client access for fork handling operations
let client;
const index_version = config.settings.index_version;

let cch_ready = false;
let tables = new Map();
let chainID = null;
let local_block_num = parseInt(process.env.first_block, 10) - 1;

const role = process.env['worker_role'];
const isLiveReader = role === 'continuous_reader';

if (isLiveReader) {
    local_block_num = parseInt(process.env.worker_last_processed_block, 10) - 1;
}

let currentIdx = 1;
let drainCount = 0;
let local_distributed_count = 0;
let lastPendingCount = 0;
let reconnectCount = 0;
let completionSignaled = false;
let completionMonitoring = null;
let queueSizeCheckInterval = 5000;
let allowRequests = true;
let pendingRequest = null;
let recovery = false;
let local_last_block = 0;
let future_block = 0;

const qStatusMap = {};
const queue_prefix = config.settings.chain;
const queue = queue_prefix + ':blocks';
const n_deserializers = config.scaling.ds_queues;
const maxMessagesInFlight = config.prefetch.read;
let range_size = parseInt(process.env.last_block) - parseInt(process.env.first_block);

const blockReadingQueue = async.cargo(async.ensureAsync(processIncomingBlockArray), maxMessagesInFlight);
const stageOneDistQueue = async.cargo(async.ensureAsync(distribute), maxMessagesInFlight);

const baseRequest = {
    max_messages_in_flight: maxMessagesInFlight,
    have_positions: [],
    irreversible_only: false,
    fetch_block: config.indexer.fetch_block,
    fetch_traces: config.indexer.fetch_traces,
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

function ackBlockRange(size) {
    send(['get_blocks_ack_request_v0', {num_messages: size}]);
}

async function processIncomingBlocks(block_array) {
    if (abi) {
        for (const block of block_array) {
            try {
                await onMessage(block);
            } catch (e) {
                console.log(e);
            }
        }
        ackBlockRange(block_array.length);
    } else {
        await onMessage(block_array[0]);
    }
    return true;
}

// Monitor pending messages
function signalReaderCompletion() {
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
    debugLog(`Reader ${process.env.worker_id} requestBlocks from: ${request.start_block_num} to: ${request.end_block_num}`);
    send(['get_blocks_request_v0', request]);
}

function requestBlockRange(start, finish) {
    const request = baseRequest;
    request.start_block_num = parseInt(start, 10);
    local_block_num = request.start_block_num - 1;
    request.end_block_num = parseInt(finish, 10);
    debugLog(`Reader ${process.env.worker_id} requestBlockRange from: ${request.start_block_num} to: ${request.end_block_num}`);
    send(['get_blocks_request_v0', request]);
}

function processFirstABI(data) {
    abi = JSON.parse(data);
    types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), abi);
    abi.tables.map(table => tables.set(table.name, table.type));
    process.send({event: 'init_abi', data: data});
    if (!config.indexer['disable_reading']) {
        switch (role) {
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

async function logForkEvent(starting_block, ending_block, new_id) {
    await client.index({
        index: queue_prefix + '-logs',
        body: {
            type: 'fork',
            '@timestamp': new Date().toISOString(),
            'fork.from_block': starting_block,
            'fork.to_block': ending_block,
            'fork.size': ending_block - starting_block + 1,
            'fork.new_block_id': new_id
        }
    });
}

async function handleFork(data) {
    const this_block = data['this_block'];
    await logForkEvent(this_block['block_num'], local_block_num, this_block['block_id']);
    console.log(`Handling fork event: new block ${this_block['block_num']} has id ${this_block['block_id']}`);
    console.log(`Removing indexed data from ${this_block['block_num']} to ${local_block_num}`);
    const searchBody = {
        query: {
            bool: {
                must: [{range: {block_num: {gte: this_block['block_num'], lte: local_block_num}}}]
            }
        }
    };
    const indexName = queue_prefix + '-delta-' + index_version + '-*';
    const {body} = await client.deleteByQuery({
        index: indexName,
        refresh: true,
        body: searchBody
    });
    console.log(body);
    console.log(`Live reading resumed!`);
}

// Entrypoint for incoming blocks
async function onMessage(data) {

    if (abi) {
        // NORMAL OPERATION MODE WITH ABI PRESENT
        if (!recovery) {

            // NORMAL OPERATION MODE
            if (role) {
                const res = deserialize('result', data, txEnc, txDec, types)[1];
                if (res['this_block']) {
                    const blk_num = res['this_block']['block_num'];
                    if (isLiveReader) {

                        // LIVE READER MODE
                        if (blk_num !== local_block_num + 1) {
                            await handleFork(res);
                        } else {
                            local_block_num = blk_num;
                        }
                        stageOneDistQueue.push({num: blk_num, content: data});
                        return 1;

                    } else {

                        // BACKLOG MODE
                        if (future_block !== 0 && future_block === blk_num) {
                            console.log('Missing block ' + blk_num + ' received!');
                        } else {
                            future_block = 0;
                        }
                        if (blk_num === local_block_num + 1) {
                            local_block_num = blk_num;
                            if (res['block'] || res['traces'] || res['deltas']) {
                                stageOneDistQueue.push({num: blk_num, content: data});
                                return 1;
                            } else {
                                if (blk_num === 1) {
                                    stageOneDistQueue.push({num: blk_num, content: data});
                                    return 1;
                                } else {
                                    return 0;
                                }
                            }
                        } else {
                            console.log(`[${role}] missing block: ${(local_block_num + 1)} current block: ${blk_num}`);
                            future_block = blk_num + 1;
                            return 0;
                        }
                    }
                } else {
                    return 0;
                }
            } else {
                console.log("[FATAL ERROR] undefined role! Exiting now!");
                ship.close();
                process.exit(1);
            }

        } else {

            // RECOVERY MODE
            if (isLiveReader) {
                console.log(`Resuming live stream from block ${local_block_num}...`);
                requestBlocks(local_block_num + 1);
                recovery = false;
            } else {
                if (!completionSignaled) {
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
                    console.log('Reader already finished, no need to restart.');
                    recovery = false;
                }
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
        const q = isLiveReader ? queue_prefix + ':live_blocks' : queue + ":" + currentIdx;
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
                        process.send({event: 'read_block', live: isLiveReader});
                    }
                });

                if (!isLiveReader) {
                    local_distributed_count++;
                    debugLog(`Block Number: ${d.num} - Range progress: ${local_distributed_count}/${range_size}`);
                    if (local_distributed_count === range_size) {
                        signalReaderCompletion();
                    }
                    currentIdx++;
                    if (currentIdx > n_deserializers) {
                        currentIdx = 1;
                    }
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

function onIpcMessage(msg) {
    switch (msg.event) {
        case 'new_range': {
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
            break;
        }
        case 'stop': {
            if (isLiveReader) {
                console.log('[LIVE READER] Closing Websocket');
                ship.close();
                setTimeout(() => {
                    console.log('[LIVE READER] Process killed');
                    process.exit(1);
                }, 2000);
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
            if (data.some(el => el > config.scaling.queue_limit)) {
                allowRequests = false;
            } else {
                allowRequests = true;
                if (pendingRequest) {
                    processPending();
                }
            }
        });
    }, queueSizeCheckInterval);
}

function assertQueues() {

    if (isLiveReader) {
        const live_queue = queue_prefix + ':live_blocks';
        ch.assertQueue(live_queue, {
            durable: true
        });
        ch.on('drain', function () {
            console.log('drain...');
            qStatusMap[live_queue] = true;
        });
    } else {
        for (let i = 0; i < n_deserializers; i++) {
            ch.assertQueue(queue + ":" + (i + 1), {
                durable: true
            });
            ch.on('drain', function () {
                console.log('drain...');
                qStatusMap[queue + ":" + (i + 1)] = true;
            });
        }
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

    rpc = manager.nodeosJsonRPC;
    client = manager.elasticsearchClient;
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
