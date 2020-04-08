const {getCacheByHash} = require("../../helpers/functions");
const {getAbiSnapshotSchema} = require("../../schemas");

const enable_caching = process.env.ENABLE_CACHING === 'true';
let cache_life = 30;
if (process.env.CACHE_LIFE) {
    cache_life = parseInt(process.env.CACHE_LIFE);
}

async function getAbiSnapshot(fastify, request) {
    const t0 = Date.now();
    const {redis, elastic} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(request.query));
    if (cachedResponse) {
        return JSON.parse(cachedResponse);
    }

    const response = {
        query_time: 0,
        block_num: null
    };

    const code = request.query.contract;
    const block = request.query.block;
    const should_fetch = request.query.fetch;

    if (should_fetch) {
        console.log(should_fetch);
    }

    const mustArray = [];

    mustArray.push({"term": {"account": code}});

    if (block) {
        mustArray.push({"range": {"block": {"lte": parseInt(block)}}});
    }

    const results = await elastic.search({
        index: process.env.CHAIN + '-abi',
        size: 1,
        body: {
            query: {bool: {must: mustArray}},
            sort: [{block: {order: "desc"}}]
        }
    });
    if (results['body']['hits']['hits'].length > 0) {
        if (should_fetch) {
            response['abi'] = JSON.parse(results['body']['hits']['hits'][0]['_source']['abi']);
        } else {
            response['present'] = true;
        }
        response.block_num = results['body']['hits']['hits'][0]['_source']['block'];
    } else {
        response['present'] = false;
        response['error'] = 'abi not found for ' + code + ' until block ' + block;
    }
    response['query_time'] = Date.now() - t0;
    if (enable_caching) {
        redis.set(hash, JSON.stringify(response), 'EX', cache_life);
    }
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get('/get_abi_snapshot', {
        schema: getAbiSnapshotSchema.GET
    }, async (request, reply) => {
        reply.send(await getAbiSnapshot(fastify, request));
    });
    next()
};
