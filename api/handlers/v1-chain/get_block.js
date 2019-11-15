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

const {blockStore} = require('../blockStore');

async function getBlock(fastify, request, reply) {
    const {eosjs} = fastify;
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
    if (block_num_or_id) {
        try {
            const blockdata = await eosjs.rpc.get_block(block_num_or_id);
            reply.send(blockdata);
        } catch (e) {
            const errJson = {
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
            };
            reply.code(400).send(errJson);
        }
    } else {
        reply.code(404).type('text/html').send('Not Found');
    }
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
    fastify.post('/get_block', {schema}, async (request, reply) => {
        await getBlock(fastify, request, reply);
    });
    next();
};
