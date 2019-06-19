const {getVotersSchema} = require("../../schemas");
const {getCacheByHash} = require("../../helpers/functions");
const route = '/get_voters';


const maxActions = 1000;

const fetch = require('node-fetch');
const {JsonRpc} = require('eosjs');
const eos_endpoint = process.env.NODEOS_HTTP;
const rpc = new JsonRpc(eos_endpoint, {fetch});

async function getVoters(fastify, request) {

    const t0 = Date.now();
    const {redis, elastic} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, route + JSON.stringify(request.query));
    if (cachedResponse) {
        return cachedResponse;
    }

    let skip, limit;

    skip = parseInt(request.query.skip, 10);
    if (skip < 0) {
        return 'invalid skip parameter';
    }
    limit = parseInt(request.query.limit, 10);
    if (limit < 1) {
        return 'invalid limit parameter';
    }

    const response = {
        query_time: null,
        voter_count: 0,
        'voters': []
    };
    let queryStruct = {
        "bool": {
            "must": []
        }
    };

    if (request.query.producer) {
        for (const bp of request.query.producer.split(",")) {
            queryStruct.bool.must.push({"term": {"producers": bp}});
        }
    }

    if (request.query.proxy === 'true') {
        queryStruct.bool.must.push({"term": {"is_proxy": true}});
    }

    if (queryStruct.bool.must.length === 0) {
        queryStruct = {
            "match_all": {}
        };
    }

    let prefix = process.env.CHAIN;
    if(process.env.CHAIN === 'mainnet') {
        prefix = 'eos';
    }

    const results = await elastic.search({
        "index": prefix + '-table-voters-*',
        "from": skip || 0,
        "size": (limit > maxActions ? maxActions : limit) || 10,
        "body": {
            "query": queryStruct,
            "sort": [{"last_vote_weight": "desc"}]
        }
    });
    const hits = results['body']['hits']['hits'];
    for (const hit of hits) {
        const voter = hit._source;
        response.voters.push({
            account: voter.voter,
            weight: voter.last_vote_weight,
            last_vote: voter.block_num
        });
    }
    response.voter_count = results['body']['hits']['total']['value'];
    response['query_time'] = Date.now() - t0;
    redis.set(hash, JSON.stringify(response), 'EX', 30);
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get(route, {
        schema: getVotersSchema.GET
    }, async (request) => {
        return await getVoters(fastify, request);
    });
    next();
};
