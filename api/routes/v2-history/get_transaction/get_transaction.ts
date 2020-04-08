import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {ServerResponse} from "http";
import {mergeActionMeta, timedQuery} from "../../../helpers/functions";

async function getTransaction(fastify: FastifyInstance, request: FastifyRequest) {
    const pResults = await Promise.all([
        fastify.eosjs.rpc.get_info(),
        fastify.elastic.search({
            "index": fastify.manager.chain + '-action-*',
            "body": {
                "query": {
                    "bool": {
                        must: [
                            {term: {"trx_id": request.query.id.toLowerCase()}}
                        ]
                    }
                },
                "sort": {
                    "global_sequence": "asc"
                }
            }
        })
    ]);
    const results = pResults[1];
    const response = {
        "trx_id": request.query.id,
        "lib": pResults[0].last_irreversible_block_num,
        "actions": []
    };
    const hits = results['body']['hits']['hits'];
    if (hits.length > 0) {
        for (let action of hits) {
            action = action._source;
            mergeActionMeta(action);
            response.actions.push(action);
        }
    }
    return response;
}

export function getTransactionHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply<ServerResponse>) => {
        reply.send(await timedQuery(getTransaction, fastify, request, route));
    }
}
