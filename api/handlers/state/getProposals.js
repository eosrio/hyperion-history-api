const {getProposalsSchema} = require("../../schemas");
const {getCacheByHash} = require("../../helpers/functions");
const route = '/get_proposals';

const maxActions = 1000;

const enable_caching = process.env.ENABLE_CACHING === 'true';
let cache_life = 30;
if (process.env.CACHE_LIFE) {
    cache_life = parseInt(process.env.CACHE_LIFE);
}

function getTrackOpt(request) {
    let trackTotalHits = 10000;
    if (request.query.track) {
        if (request.query.track === 'true') {
            trackTotalHits = true;
        } else if (request.query.track === 'false') {
            trackTotalHits = false;
        } else {
            trackTotalHits = parseInt(request.query.track, 10);
            if (trackTotalHits !== trackTotalHits) {
                throw new Error('failed to parse track param');
            }
        }
    }
    return trackTotalHits;
}

async function getProposals(fastify, request) {

    const t0 = Date.now();
    const {redis, elastic, eosjs} = fastify;
    let cachedResponse, hash;
    if (enable_caching) {
        [cachedResponse, hash] = await getCacheByHash(redis, route + JSON.stringify(request.query));
        if (cachedResponse) {
            cachedResponse = JSON.parse(cachedResponse);
            cachedResponse['query_time'] = Date.now() - t0;
            cachedResponse['cached'] = true;
            return cachedResponse;
        }
    }

    // Pagination
    let skip, limit;
    skip = parseInt(request.query.skip, 10);
    if (skip < 0) {
        return 'invalid skip parameter';
    }
    limit = parseInt(request.query.limit, 10);
    if (limit < 1) {
        return 'invalid limit parameter';
    }

    let queryStruct = {
        "bool": {
            "must": []
        }
    };

    // Filter by account
    if (request.query.account) {
        queryStruct.bool.must.push({
            "bool": {
                "should": [
                    {"term": {"requested_approvals.actor": request.query.account}},
                    {"term": {"provided_approvals.actor": request.query.account}}
                ]
            }
        });
    }

    // Filter by proposer account
    if (request.query.proposer) {
        queryStruct.bool.must.push({"term": {"proposer": request.query.proposer}});
    }

    // Filter by proposal name
    if (request.query.proposal) {
        queryStruct.bool.must.push({"term": {"proposal_name": request.query.proposal}});
    }

    // Filter by execution status
    if (typeof request.query.executed !== 'undefined') {
        queryStruct.bool.must.push({"term": {"executed": request.query.executed}});
    }

    // Filter by requested actors
    if (request.query.requested) {
        queryStruct.bool.must.push({"term": {"requested_approvals.actor": request.query.requested}});
    }

    // Filter by provided actors
    if (request.query.provided) {
        queryStruct.bool.must.push({"term": {"provided_approvals.actor": request.query.provided}});
    }

    // If no filter switch to full match
    if (queryStruct.bool.must.length === 0) {
        queryStruct = {
            "match_all": {}
        };
    }

    console.log(JSON.stringify(queryStruct));

    const results = await elastic.search({
        "index": process.env.CHAIN + '-table-proposals-*',
        "from": skip || 0,
        "size": (limit > maxActions ? maxActions : limit) || 10,
        "body": {
            "track_total_hits": getTrackOpt(request),
            "query": queryStruct,
            "sort": [{"block_num": "desc"}]
        }
    });

    const response = {
        query_time: null,
        cached: false,
        total: results['body']['hits']['total'],
        proposals: []
    };

    const hits = results['body']['hits']['hits'];
    for (const hit of hits) {
        const prop = hit._source;
        response.proposals.push(prop);
    }

    response['query_time'] = Date.now() - t0;
    if (enable_caching) {
        redis.set(hash, JSON.stringify(response), 'EX', cache_life);
    }
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get(route, {
        schema: getProposalsSchema.GET
    }, async (request) => {
        return await getProposals(fastify, request);
    });
    next();
};
