const {getBlocksSchema} = require("../../schemas");
const {blockStore} = require('../blockStore');

async function getBlocks(fastify, request, reply) {
    const t0 = Date.now();
    let from_block, to_block;
    const {eosjs} = fastify;
    if (request.query.from) {
        from_block = parseInt(request.query.from);
        if (request.query.to) {
            to_block = parseInt(request.query.to);
        } else {
            to_block = from_block + 1;
        }
    } else {
        const head = (await eosjs.rpc.get_info()).head_block_num;
        from_block = head;
        to_block = head + 1;
    }

    if (to_block > from_block) {
        if (to_block - from_block > 20) {
            reply.status(403).send('request over limit');
        } else {
            const response = {query_time: null, cached: false, blocks: []};
            console.log('Local Block store size:', blockStore.localBlocks.size);
            blockStore.requestRange(from_block, to_block, (block, cached) => {
                if (cached) {
                    response.cached = true;
                }
                response.blocks.push(block);
            }, () => {
                response['query_time'] = Date.now() - t0;
                reply.send(response);
            });
        }
    } else {
        reply.status(403).send('invalid block range');
    }
}

module.exports = function (fastify, opts, next) {
    fastify.get('/get_blocks', {
        schema: getBlocksSchema.GET
    }, async (request, reply) => {
        await getBlocks(fastify, request, reply);
    });
    next();
};
