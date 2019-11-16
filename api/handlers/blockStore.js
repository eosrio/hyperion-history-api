const async = require('async');
const {Serialize} = require('eosjs');
const {ConnectionManager} = require('../../connections/manager');
let abi, types;
let connected = false;
let tables = new Map();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const ws_opts = {compress: true, binary: true, mask: true, fin: true};
const maxMessagesInFlight = 1;
const blockReadingQueue = async.cargo(async.ensureAsync(processIncomingBlockArray), maxMessagesInFlight);

class BlockStore {
    localBlocks;
    pendingBlocks;
    pendingRequests;
    constructor() {
        this.pendingRequests = [];
        this.localBlocks = new Map();
        this.pendingBlocks = new Map();
    }

    addBlock(num, data) {
        if (this.pendingBlocks.has(num)) {
            this.localBlocks.set(num, data);
            this.pendingBlocks.get(num)['callback']();
            this.pendingBlocks.delete(num);
        }
    }

    requestRange(from_block, to_block, onBlock, onCompletion) {
        // console.log(`Requesting blocks from ${from_block} to ${to_block}`);
        const range = to_block - from_block;
        // console.log(`Range size: ${range}`);
        let requested = range;
        for (let i = 0; i < range; i++) {
            const blk_num = from_block + i;
            // console.log('Looking on local cache for block ' + blk_num);
            if (this.localBlocks.has(blk_num)) {
                onBlock(this.localBlocks.get(blk_num), true);
                requested--;
            } else {
                this.pendingBlocks.set(blk_num, {
                    callback: () => {
                        onBlock(this.localBlocks.get(blk_num), false);
                    }
                });
            }
        }
        if (requested > 0) {
            requestBlockRange(from_block, to_block);
            const checker = setInterval(() => {
                if (this.pendingBlocks.size === 0) {
                    onCompletion();
                    clearInterval(checker);
                }
            }, 30);
        } else {
            onCompletion();
        }
    }
}

const blockStore = new BlockStore();

const baseRequest = {
    max_messages_in_flight: maxMessagesInFlight,
    have_positions: [],
    irreversible_only: false,
    fetch_block: true,
    fetch_traces: true,
    fetch_deltas: false
};

const manager = new ConnectionManager();
const shipClient = manager.shipClient;
startWS();

function createSerialBuffer(array_data) {
    return new Serialize.SerialBuffer({textEncoder, textDecoder, array: array_data});
}


function serialize(type, value) {
    const buffer = createSerialBuffer();
    Serialize.getType(types, type).serialize(buffer, value);
    return buffer.asUint8Array();
}

function deserialize(type, array) {
    const buffer = new Serialize.SerialBuffer({textEncoder, textDecoder, array});
    const sState = new Serialize.SerializerState({bytesAsUint8Array: true});
    return Serialize.getType(types, type).deserialize(buffer, sState);
}

function processIncomingBlockArray(payload, cb) {
    processIncomingBlocks(payload).then(() => {
        cb();
    }).catch((err) => {
        console.log('FATAL ERROR READING BLOCKS', err);
        process.exit(1);
    })
}

function handleLostConnection() {
    console.log('connection lost');
    connected = false;
    startWS();
}

function ackBlocks(num) {
    shipClient.send(serialize('request',
        ['get_blocks_ack_request_v0', {num_messages: num}]
    ), ws_opts, (err) => {
        if (err) console.warn(err);
    });
}

async function processIncomingBlocks(block_array) {
    if (abi) {
        ackBlocks(block_array.length);
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

function processFirstABI(data) {
    abi = JSON.parse(data);
    types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), abi);
    abi.tables.map(table => tables.set(table.name, table.type));
}

function deserializeType(obj) {
    return deserialize(obj[0], obj[1], textEncoder, textDecoder, types);
}

function onMessage(data) {
    if (abi) {
        const res = deserialize('result', data)[1];
        if (res['this_block']) {
            const blk_num = res['this_block']['block_num'];
            const block_data = {
                block: null,
                traces: [],
                deltas: []
            };
            if (res.block && res.block.length) {
                block_data.block = deserialize('signed_block', res.block, textEncoder, textDecoder, types);
                if (block_data.block === null) {
                    console.log(res);
                } else {
                    block_data.block.id = res['this_block']['block_id'];
                    block_data.block.block_num = blk_num;
                    block_data.block.transactions = [];

                    if (res['traces'] && res['traces'].length) {
                        const trx_traces = deserialize('transaction_trace[]', res['traces'], textEncoder, textDecoder, types).map(trace => trace[1]);
                        for (const trace of trx_traces) {
                            trace.partial = trace.partial[1];
                            trace.actions = [];
                            for (const action_trace of trace.action_traces) {
                                // console.log(action_trace);
                                // action_trace.receipt = action_trace.receipt[1];
                                const action = action_trace[1];
                                action.receipt = action.receipt[1];
                                action['act']['data'] = Buffer.from(action['act']['data']).toString('hex');
                                trace.actions.push(action);
                            }
                            delete trace.action_traces;
                            if (trace.actions[0]['act']['account'] === 'eosio' && trace.actions[0]['act']['name'] === 'onblock') {
                                // ingore onblock
                            } else {
                                block_data.block.transactions.push(trace);
                            }
                        }
                    }

                }
            }

            // if (res['deltas'] && res['deltas'].length) {
            //     block_data.deltas = deserialize('table_delta[]', res['deltas'], textEncoder, textDecoder, types);
            // }
            blockStore.addBlock(blk_num, block_data.block);
        }
    } else {
        processFirstABI(data);
        return 1;
    }
}

function send(req_data) {
    shipClient.send(serialize('request', req_data, textEncoder, textDecoder, types));
}

function requestBlockRange(start, finish) {
    const request = baseRequest;
    request.start_block_num = start;
    request.end_block_num = finish;
    // console.log(request);
    if (connected) {
        send(['get_blocks_request_v0', request]);
    } else {
        startWS(() => {
            send(['get_blocks_request_v0', request]);
        });
    }
}

function startWS(onConnect) {
    if (onConnect) {
        shipClient.connect(blockReadingQueue.push, handleLostConnection, null, onConnect);
    } else {
        shipClient.connect(blockReadingQueue.push, handleLostConnection);
    }
    connected = true;
}

module.exports = {blockStore};
