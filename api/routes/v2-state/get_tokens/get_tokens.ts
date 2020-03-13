import {ServerResponse} from "http";
import {timedQuery} from "../../../helpers/functions";
import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";


async function getTokens(fastify: FastifyInstance, request: FastifyRequest) {

    const response = {
        query_time: null,
        cached: false,
        'account': request.query.account,
        'tokens': []
    };

    const results = await fastify.elastic.search({
        "index": process.env.CHAIN + '-action-*',
        "body": {
            size: 0,
            query: {
                bool: {
                    // must_not: {term: {"act.account": "eosio.token"}},
                    filter: [
                        {term: {"notified": request.query.account}},
                        {terms: {"act.name": ["transfer", "issue"]}}
                    ]
                }
            },
            aggs: {
                tokens: {
                    terms: {
                        field: "act.account",
                        size: 1000
                    }
                }
            }
        }
    });

    for (const bucket of results['body']['aggregations']['tokens']['buckets']) {
        let token_data;
        try {
            token_data = await fastify.eosjs.rpc.get_currency_balance(bucket['key'], request.query.account);
        } catch (e) {
            console.log(`get_currency_balance error - contract:${bucket['key']} - account:${request.query.account}`);
            continue;
        }
        for (const entry of token_data) {
            let precision = 0;
            const [amount, symbol] = entry.split(" ");
            const amount_arr = amount.split(".");
            if (amount_arr.length === 2) {
                precision = amount_arr[1].length;
            }
            response.tokens.push({
                symbol: symbol,
                precision: precision,
                amount: parseFloat(amount),
                contract: bucket['key']
            });
        }
    }
    return response;
}

export function getTokensHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply<ServerResponse>) => {
        reply.send(await timedQuery(getTokens, fastify, request, route));
    }
}
