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
    console.log(request.body);
    let from_block;
    if (request.body['block_num_or_id']) {
        from_block = parseInt(request.body['block_num_or_id']);
        let response;
        console.log('Local Block store size:', blockStore.localBlocks.size);
        blockStore.requestRange(from_block, from_block + 1, (block) => {
            response = block;
        }, () => {
            reply.send(response);
        });
    }
}

module.exports = function (fastify, opts, next) {
    fastify.post('/get_block', {schema}, async (request, reply) => {
        await getBlock(fastify, request, reply);
    });
    next();
};
