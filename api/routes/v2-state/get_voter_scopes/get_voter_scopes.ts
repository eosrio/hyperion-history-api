import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions";

async function getVoterScopes(fastify: FastifyInstance, request: FastifyRequest) {

    const query = request.query as any;

    const response: any = {
        scopes: []
    };

    const result = await fastify.elastic.search<{voter: string}>({
        index: fastify.manager.chain + "-table-voters-*",
        query: {
            wildcard: {
                voter: {
                    value: `*${query.term}*`
                }
            }
        },
        _source: {
            includes: "voter"
        }
    });

    if ( result && result.hits.hits && result.hits.hits.length > 0) {
        result.hits.hits.forEach(v => {
            if (v._source) {
                response.scopes.push(v._source.voter);
            }
        });
    }

    return response;
}

export function getVoterScopesHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getVoterScopes, fastify, request, route));
    }
}