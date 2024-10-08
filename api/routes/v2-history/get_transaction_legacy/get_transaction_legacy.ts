import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {mergeActionMeta, timedQuery} from "../../../helpers/functions";

async function getTransaction(fastify: FastifyInstance, request: FastifyRequest) {
    const _size = fastify.manager.config.api.limits.get_trx_actions || 100;
    const query: any = request.query;

    let indexPattern = fastify.manager.chain + '-action-*';
    if (query.hot_only) {
        indexPattern = fastify.manager.chain + '-action';
    }

    const pResults = await Promise.all([
        fastify.eosjs.rpc.get_info(),
        fastify.elastic.search<any>({
            index: indexPattern,
            size: _size,
            query: {
                bool: {
                    must: [
                        {term: {trx_id: query.id.toLowerCase()}}
                    ]
                }
            },
            sort: {
                global_sequence: "asc"
            }
        }),
        fastify.elastic.search<any>({
            index: fastify.manager.chain + '-gentrx-*',
            size: _size,
            query: {
                bool: {
                    must: [
                        {term: {trx_id: query.id.toLowerCase()}}
                    ]
                }
            }
        })
    ]);

    const results = pResults[1];
    const genTrxRes = pResults[2];

    const response: any = {
        "executed": false,
        "hot_only": false,
        "trx_id": query.id,
        "lib": pResults[0].last_irreversible_block_num,
        "actions": [],
        "generated": undefined
    };

    if (query.hot_only) {
        response.hot_only = true;
    }

    const hits = results.hits.hits;

    if (hits.length > 0) {

        // const producers = {};
        // for (let hit of hits) {
        // 	if (hit._source.producer) {
        // 		if (producers[hit._source.producer]) {
        // 			producers[hit._source.producer]++;
        // 		} else {
        // 			producers[hit._source.producer] = 1;
        // 		}
        // 	}
        // }
        // let useBlockNumber;
        // if (Object.keys(producers).length > 1) {
        // 	// multiple producers of the same tx id, forked actions are present, attempt to clean-up
        // 	let trueProd = '';
        // 	let highestActCount = 0;
        // 	for (const prod in producers) {
        // 		if (producers.hasOwnProperty(prod)) {
        // 			if(producers[prod] === highestActCount) {
        // 				useBlockNumber = true;
        // 			} else if (producers[prod] > highestActCount) {
        // 				highestActCount = producers[prod];
        // 				trueProd = prod;
        // 			}
        // 		}
        // 	}
        // }

        let highestBlockNum = 0;
        for (let action of hits) {
            if (action._source.block_num > highestBlockNum) {
                highestBlockNum = action._source.block_num;
            }
        }

        for (let action of hits) {
            if (action._source.block_num === highestBlockNum) {
                action = action._source;
                mergeActionMeta(action);
                response.actions.push(action);
            }
        }

        response.executed = true;
    }

    const hits2 = genTrxRes.hits.hits;

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
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getTransaction, fastify, request, route));
    }
}
