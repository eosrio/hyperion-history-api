const schema = {
    description: 'Returns an object containing various details about a specific block on the blockchain.',
    summary: 'Returns an object containing various details about a specific block on the blockchain.',
    tags: ['state'],
    body: {
        type: ['object', 'string'],
        properties: {
            "block_num_or_id": {
                description: 'Provide a block number or a block id',
                type: 'string'
            },
        },
        required: ["block_num_or_id"]
    }
};

const route = '/get_block';
const {blockStore} = require('../blockStore');
const {getCacheByHash} = require("../../helpers/functions");

let last_get_info = 0;
let chain_info;

async function getInfo(eosjs) {
    if (Date.now() - last_get_info > 1000) {
        chain_info = await eosjs.rpc.get_info();
        last_get_info = Date.now();
    }
}

async function processBlockData(block, eosjs) {
    // Calculate total usage
    let total_cpu = 0;
    let total_net = 0;
    block.transactions.forEach((trx) => {
        total_cpu += trx['cpu_usage_us'];
        total_net += trx['net_usage_words'];
    });
    block['total_cpu_usage_us'] = total_cpu;
    block['total_net_usage_words'] = total_net;

    // check irreversibility
    await getInfo(eosjs);
    block['last_irreversible_block_num'] = chain_info.last_irreversible_block_num;
    block['irreversible'] = block['block_num'] <= block['last_irreversible_block_num'];
    return block;
}

async function getBlock(fastify, request, reply) {
    const {eosjs, redis} = fastify;
    let block_num_or_id;
    try {
        if (typeof request.body === 'object') {
            block_num_or_id = request.body['block_num_or_id'];
        } else {
            block_num_or_id = JSON.parse(request.body)['block_num_or_id'];
        }
    } catch (e) {
        console.log(request.body);
        console.log(e);
    }

    if (parseInt(block_num_or_id) === 0) {
        await getInfo(eosjs);
        block_num_or_id = chain_info.head_block_num;
    }

    if (block_num_or_id) {
        let cachedResponse, hash;
        const key = route + '_' + block_num_or_id;
        [cachedResponse, hash] = await getCacheByHash(redis, key);
        if (cachedResponse) {
            cachedResponse = JSON.parse(cachedResponse);
            if (cachedResponse['irreversible']) {
                reply.send(cachedResponse);
                return;
            }
        }

        try {
            let blockdata = await eosjs.rpc.get_block(block_num_or_id);
            blockdata = await processBlockData(blockdata, eosjs);
            const blockstring = JSON.stringify(blockdata);
            if (blockdata['irreversible']) {
                redis.set(hash, blockstring, 'EX', 86400);
            } else {
                redis.set(hash, blockstring, 'EX', 10);
            }
            reply.send(blockdata);
        } catch (e) {
            reply.code(400).send({
                "code": 400,
                "message": "Unknown Block",
                "error": {
                    "code": 3100002,
                    "name": "unknown_block_exception",
                    "what": "Unknown block",
                    "details": [
                        {
                            "message": "Could not find block: " + block_num_or_id,
                            "file": "chain_plugin.cpp",
                            "line_number": 1852,
                            "method": "get_block"
                        }
                    ]
                }
            });
        }

    } else {
        reply.code(400).send({});
    }

    // TODO: fallback to state history
    // let from_block;
    // if (request.body['block_num_or_id']) {
    //     from_block = parseInt(request.body['block_num_or_id']);
    //     let response;
    //     console.log('Local Block store size:', blockStore.localBlocks.size);
    //     blockStore.requestRange(from_block, from_block + 1, (block) => {
    //         response = block;
    //     }, () => {
    //         reply.send(response);
    //     });
    // }

}

module.exports = function (fastify, opts, next) {
    fastify.post(route, {schema}, async (request, reply) => {
        await getBlock(fastify, request, reply);
    });
    next();
};
