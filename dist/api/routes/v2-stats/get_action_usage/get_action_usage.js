import { timedQuery } from "../../../helpers/functions.js";
async function getLastSeq(fastify, date) {
    const req = await fastify.elastic.search({
        index: fastify.manager.chain + '-action-*',
        size: 1,
        query: {
            bool: {
                must: [
                    { "range": { "@timestamp": { "lt": date } } }
                ]
            }
        },
        _source_includes: ["global_sequence"],
        "sort": ["global_sequence:desc"]
    });
    let lastGs = 0;
    if (req.hits.hits[0]._source) {
        lastGs = req.hits.hits[0]._source.global_sequence;
    }
    return lastGs;
}
async function getTxCount(fastify, dateFrom, dateTo) {
    const req = await fastify.elastic.count({
        index: fastify.manager.chain + '-action-*',
        body: {
            "query": {
                "bool": {
                    "must": [
                        { "term": { "creator_action_ordinal": 0 } },
                        { "range": { "@timestamp": { "gt": dateFrom, "lt": dateTo } } }
                    ]
                }
            }
        }
    });
    return req.count;
}
async function getUniqueActors(fastify, dateFrom, dateTo) {
    const req = await fastify.elastic.search({
        index: fastify.manager.chain + '-action-*',
        size: 0,
        body: {
            "aggs": {
                "unique_actors": {
                    "cardinality": {
                        "field": "act.authorization.actor"
                    }
                }
            },
            "query": {
                "bool": {
                    "filter": [{ "range": { "@timestamp": { "gt": dateFrom, "lt": dateTo } } }]
                }
            }
        }
    });
    return req.aggregations.unique_actors.value;
}
async function getActionUsage(fastify, request) {
    const query = request.query;
    let now = new Date();
    let expiration = 86400;
    if (query.end_date) {
        now = new Date(query.end_date);
    }
    now.setMinutes(0, 0, 0);
    let period;
    if (query.period === '1h') {
        period = 3600000;
    }
    else if (query.period === '24h' || query.period === '1d') {
        period = 86400000;
    }
    else {
        return {};
    }
    if (!query.end_date) {
        expiration = Math.floor((period - (Date.now() - now.getTime())) / 1000);
    }
    const response = {};
    const periodStart = new Date(now.getTime() - period);
    const pStart = periodStart.toISOString();
    const pEnd = now.toISOString();
    const cacheKey = `${fastify.manager.chain}_act_stats_${pStart}_${pEnd}_${query.unique_actors}`;
    const cachedValue = await fastify.redis.get(cacheKey);
    if (cachedValue) {
        const cachedResponse = JSON.parse(cachedValue);
        cachedResponse.cached = true;
        cachedResponse.cache_exp = expiration;
        return cachedResponse;
    }
    const firstReq = await getLastSeq(fastify, pStart);
    const lastReq = await getLastSeq(fastify, pEnd);
    response.action_count = lastReq - firstReq;
    response.tx_count = await getTxCount(fastify, pStart, pEnd);
    if (query.unique_actors) {
        response.unique_actors = await getUniqueActors(fastify, pStart, pEnd);
    }
    response.period = query.period;
    response.from = pStart;
    response.to = pEnd;
    await fastify.redis.set(cacheKey, JSON.stringify(response), 'EX', expiration);
    return response;
}
export function getActionUsageHandler(fastify, route) {
    return async (request, reply) => {
        reply.send(await timedQuery(getActionUsage, fastify, request, route));
    };
}
