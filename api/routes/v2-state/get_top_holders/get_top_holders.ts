import { timedQuery } from "../../../helpers/functions";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSkipLimit } from "../../v2-history/get_actions/functions";

async function getTopHolders(fastify: FastifyInstance, request: FastifyRequest) {

    const query: any = request.query;

    const response: any = {
        contract: query.contract,
        symbol: undefined,
        holders: []
    };

    const { skip, limit } = getSkipLimit(request.query);

    const maxDocs = fastify.manager.config.api.limits.get_top_holders ?? 500;

    const terms: any[] = [];


    if (query.contract) {
        terms.push({ "term": { "code": { "value": query.contract } } });
    }

    if (query.symbol) {
        terms.push({ "term": { "symbol": { "value": query.symbol } } });
        response.symbol = query.symbol;
    }


    const stateResult = await fastify.elastic.search<any>({
        "index": fastify.manager.chain + '-table-accounts-*',
        "size": (limit > maxDocs ? maxDocs : limit) || 50,
        "from": skip || 0,
        body: {
            sort: {
                amount: {
                    order: "desc"
                }
            },
            query: { bool: { "must": terms } }
        }
    });

    response.holders = stateResult.body.hits.hits.map((doc: any) => {
        return {
            owner: doc._source.scope,
            amount: doc._source.amount,
            symbol: doc._source.symbol,
            updated_on: doc._source.block_num
        };
    });

    return response;

}

export function getTopHoldersHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getTopHolders, fastify, request, route));
    }
}