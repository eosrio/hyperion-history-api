import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {ServerResponse} from "http";
import {mergeActionMeta, timedQuery} from "../../../helpers/functions";

async function getTransaction(fastify: FastifyInstance, request: FastifyRequest) {
    const _size = fastify.manager.config.api.limits.get_trx_actions || 100;
    const pResults = await Promise.all([
        fastify.eosjs.rpc.get_info(),
        fastify.elastic.search({
            index: fastify.manager.chain + '-action-*',
            size: _size,
            body: {
                query: {
                    bool: {
                        must: [
                            {term: {trx_id: request.query.id.toLowerCase()}}
                        ]
                    }
                },
                sort: {
                    global_sequence: "asc"
                }
            }
        }),
        fastify.elastic.search({
            index: fastify.manager.chain + '-gentrx-*',
            size: _size,
            body: {
                query: {
                    bool: {
                        must: [
                            {term: {trx_id: request.query.id.toLowerCase()}}
                        ]
                    }
                }
            }
        })
    ]);

    const results = pResults[1];
    const genTrxRes = pResults[2];

    const response = {
        "executed": false,
        "trx_id": request.query.id,
        "lib": pResults[0].last_irreversible_block_num,
        "actions": [],
        "generated": undefined
    };

    const hits = results['body']['hits']['hits'];

    if (hits.length > 0) {
        for (let action of hits) {
            action = action._source;
            mergeActionMeta(action);
            response.actions.push(action);
        }
        response.executed = true;
    }

    const hits2 = genTrxRes['body']['hits']['hits'];

    if (hits2 && hits2.length > 0) {
        if (hits2[0]._source['@timestamp']) {
            hits2[0]._source['timestamp'] = hits2[0]._source['@timestamp'];
            delete hits2[0]._source['@timestamp'];
        }
        response.generated = hits2[0]._source;
    }

    return response;
}

export function getTransactionHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply<ServerResponse>) => {
        reply.send(await timedQuery(getTransaction, fastify, request, route));
    }
}
