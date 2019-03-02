const {getCacheByHash} = require("../helpers/functions");
const {getAbiSnapshotSchema} = require("../schemas");

async function getAbiSnapshot(fastify, request) {
    const {redis, elasticsearch} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(request.query));
    if (cachedResponse) {
        return JSON.parse(cachedResponse);
    }
    const code = request.query.contract;
    const block = request.query.block;
    const results = await elasticsearch.search({
        "index": process.env.CHAIN + '-abi',
        "size": 1,
        "body": {
            "size": 1,
            "query": {
                "bool": {
                    "must": [
                        {"range": {"block": {"lte": parseInt(block)}}},
                        {"term": {"account": code}}
                    ]
                }
            },
            "sort": [
                {"block": {"order": "desc"}}
            ]
        }
    });
    let abi = null;
    if (results['hits']['hits'].length > 0) {
        abi = results['hits']['hits'][0]['_source']['abi'];
    } else {
        abi = 'abi not found for ' + code + ' until block ' + block;
    }
    redis.set(hash, JSON.stringify(abi), 'EX', 30);
    return abi;
}

module.exports = function (fastify, opts, next) {
    fastify.get('/get_abi_snapshot', {
        schema: getAbiSnapshotSchema.GET
    }, async (request, reply) => {
        reply.send(await getAbiSnapshot(fastify, request));
    });
    next()
};
