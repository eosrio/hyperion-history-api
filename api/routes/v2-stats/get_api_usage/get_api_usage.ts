import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions";
import {parseInt} from "lodash";

async function getApiUsage(fastify: FastifyInstance, request: FastifyRequest) {
    const response = {
        total: {responses: {}},
        buckets: []
    } as any;
    const data = await fastify.redis.keys(`stats:${fastify.manager.chain}:*`);
    const buckets = [];
    for (const key of data) {
        const parts = key.split(':');
        if (parts[2] === 'H') {
            const bucket = {
                timestamp: new Date(parseInt(parts[3])),
                responses: {}
            };
            const sortedSet = await fastify.redis.zrange(key, 0, -1, 'WITHSCORES');
            for (let i = 0; i < sortedSet.length; i += 2) {
                const [status, path] = sortedSet[i].split(']');
                if (status) {
                    const statusCode = status.slice(1);
                    if (!bucket.responses[statusCode]) {
                        bucket.responses[statusCode] = {};
                    }
                    if (statusCode) {
                        bucket.responses[statusCode][path] = parseInt(sortedSet[i + 1]);
                    }
                }
            }
            response.buckets.push(bucket);
        } else {
            if (parts[2] === 'total' && parts[4]) {
                const statusCode = parts[3];
                if (!response.total.responses[statusCode]) {
                    response.total.responses[statusCode] = {};
                }
                const value = await fastify.redis.get(key);
                response.total.responses[statusCode][parts[4]] = parseInt(value);
            }
        }
    }
    // reverse sorte by date
    response.buckets.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return response;
}

export function getApiUsageHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getApiUsage, fastify, request, route));
    }
}
