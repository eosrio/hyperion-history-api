import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";

const percentiles = [1, 5, 25, 50, 75, 95, 99];

async function getResourceUsage(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query as any;
    const searchBody: any = {
        query: {
            bool: {
                must: [
                    {term: {"act.account": query.code}},
                    {term: {"act.name": query.action}},
                    {term: {"action_ordinal": {"value": 1}}},
                    {
                        range: {
                            "@timestamp": {
                                gte: "now-2d/d",
                                lt: "now/d"
                            }
                        }
                    }
                ]
            }
        },
        track_total_hits: true,
        size: 0,
        aggs: {
            cpu_extended_stats: {extended_stats: {field: "cpu_usage_us"}},
            net_extended_stats: {extended_stats: {field: "net_usage_words"}},
            cpu_percentiles: {
                percentiles: {
                    field: "cpu_usage_us",
                    percents: percentiles
                }
            },
            net_percentiles: {
                percentiles: {
                    field: "net_usage_words",
                    percents: percentiles
                }
            }
        }
    };

    if (query['@transfer.to']) {
        searchBody.query.bool.must.push({term: {"@transfer.to": query['@transfer.to']}});
    }

    const results = await fastify.elastic.search<any, any>({
        index: fastify.manager.chain + "-action-*",
        ...searchBody
    });
    if (results) {
        const data = results.aggregations;
        return {
            cpu: {
                stats: data.cpu_extended_stats,
                percentiles: data.cpu_percentiles.values
            },
            net: {
                stats: data.net_extended_stats,
                percentiles: data.net_percentiles.values
            }
        };
    } else {
        return {};
    }
}

export function getResourceUsageHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getResourceUsage, fastify, request, route));
    }
}
