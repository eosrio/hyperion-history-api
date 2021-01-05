import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {ServerResponse} from "http";
import {timedQuery} from "../../../helpers/functions";

async function getLastSeq(fastify: FastifyInstance, date: string) {
    const req = await fastify.elastic.search({
        index: fastify.manager.chain + '-action-*',
        body: {
            "size": 1,
            "query": {
                "bool": {
                    "must": [
                        {
                            "range": {
                                "@timestamp": {
                                    "lt": date
                                }
                            }
                        }
                    ]
                }
            },
            "_source": {
                "includes": ["global_sequence"]
            },
            "sort": [
                {
                    "@timestamp": "desc"
                }
            ]
        }
    });
    return req.body.hits.hits[0]._source.global_sequence;
}

async function getTxCount(fastify: FastifyInstance, dateFrom: string, dateTo: string) {
    const req = await fastify.elastic.count({
        index: fastify.manager.chain + '-action-*',
        body: {
            "query": {
                "bool": {
                    "must": [
                        {
                            "term": {
                                "creator_action_ordinal": 0
                            }
                        },
                        {
                            "range": {
                                "@timestamp": {
                                    "gt": dateFrom,
                                    "lt": dateTo
                                }
                            }
                        }
                    ]
                }
            }
        }
    });
    return req.body.count;
}

async function getActionUsage(fastify: FastifyInstance, request: FastifyRequest) {
    const query = request.query;
    let now = new Date();
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
    const periodStart = new Date(now.getTime() - period);
    const firstReq = await getLastSeq(fastify, periodStart.toISOString());
    const lastReq = await getLastSeq(fastify, now.toISOString());
    const txCount = await getTxCount(fastify, periodStart.toISOString(), now.toISOString());
    return {
        action_count: lastReq - firstReq,
        tx_count: txCount,
        period: query.period,
        from: periodStart.toISOString(),
        to: now.toISOString()
    };
}

export function getActionUsageHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply<ServerResponse>) => {
        reply.send(await timedQuery(getActionUsage, fastify, request, route));
    }
}