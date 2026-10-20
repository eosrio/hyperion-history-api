import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";
import {assertActionSearchActive, assertCompleteActionSearch, searchActions} from '../../../helpers/action-search.js';
import {canonicalUint64, compatibleUint64, subtractUint64} from '../../../../indexer/helpers/uint64.js';

async function getLastSeq(fastify: FastifyInstance, request: FastifyRequest, date: string) {
    const req = await searchActions<any>(fastify, request, {
        index: fastify.manager.readIndexset('action'),
        timeout: fastify.manager.config.api.query_timeout || '10s',
        "size": 1,
        "query": {
            "bool": {
                "must": [
                    {"range": {"@timestamp": {"lt": date}}}
                ]
            }
        },
        "_source": {
            "includes": ["global_sequence"]
        },
        "sort": [{"global_sequence": "desc"}]
    });
    try {
        return compatibleUint64(req.hits.hits[0]?._source?.global_sequence);
    } catch {
        throw Object.assign(new Error('Exact action usage sequence bounds are unavailable'), {statusCode: 503});
    }
}

async function getTxCount(fastify: FastifyInstance, dateFrom: string, dateTo: string) {
    const req = await fastify.elastic.count({
        index: fastify.manager.readIndexset('action'),
        "query": {
            "bool": {
                "must": [
                    {"term": {"creator_action_ordinal": 0}},
                    {"range": {"@timestamp": {"gt": dateFrom, "lt": dateTo}}}
                ]
            }
        }
    });
    assertCompleteActionSearch({timed_out: false, _shards: req._shards});
    return req.count;
}

async function getUniqueActors(fastify: FastifyInstance, request: FastifyRequest, dateFrom: string, dateTo: string) {
    const req = await searchActions<any>(fastify, request, {
        index: fastify.manager.readIndexset('action'),
        size: 0,
        "aggs": {
            "unique_actors": {
                "cardinality": {
                    "field": "act.authorization.actor"
                }
            }
        },
        "query": {
            "bool": {
                "filter": [{"range": {"@timestamp": {"gt": dateFrom, "lt": dateTo}}}]
            }
        }
    });
    return (req.aggregations!.unique_actors as {value: number}).value;
}

async function getActionUsage(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    let now = new Date();
    let expiration = 86400;
    if (query.end_date) {
        now = new Date(query.end_date);
    }
    now.setMinutes(0, 0, 0);
    let period;
    if (query.period === '1h') {
        period = 3600000;
    } else if (query.period === '24h' || query.period === '1d') {
        period = 86400000;
    } else {
        return {};
    }

    if (!query.end_date) {
        expiration = Math.floor((period - (Date.now() - now.getTime())) / 1000);
    }

    const response = {} as any;
    const periodStart = new Date(now.getTime() - period);
    const pStart = periodStart.toISOString();
    const pEnd = now.toISOString();

    const cacheKey = `${fastify.manager.chain}_act_stats_seq_v1_${pStart}_${pEnd}_${query.unique_actors}`;
    const cachedValue = await fastify.redis.get(cacheKey);
    if (cachedValue) {
        try {
            const cachedResponse = JSON.parse(cachedValue);
            canonicalUint64(cachedResponse.action_count);
            cachedResponse.cached = true;
            cachedResponse.cache_exp = expiration;
            return cachedResponse;
        } catch {
            // Recompute an old or malformed cache entry from exact source bounds.
        }
    }

    const firstReq = await getLastSeq(fastify, request, pStart);
    const lastReq = await getLastSeq(fastify, request, pEnd);
    try {
        response.action_count = subtractUint64(lastReq, firstReq);
    } catch {
        throw Object.assign(new Error('Exact action usage sequence bounds are inconsistent'), {statusCode: 503});
    }
    response.tx_count = await getTxCount(fastify, pStart, pEnd);

    if (query.unique_actors) {
        response.unique_actors = await getUniqueActors(fastify, request, pStart, pEnd);
    }

    response.period = query.period;
    response.from = pStart;
    response.to = pEnd;

    assertActionSearchActive(request);
    await fastify.redis.set(cacheKey, JSON.stringify(response), 'EX', expiration);
    return response;
}

export function getActionUsageHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getActionUsage, fastify, request, route));
    }
}
