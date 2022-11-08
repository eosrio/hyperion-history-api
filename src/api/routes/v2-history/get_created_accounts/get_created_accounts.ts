import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";
import {getSkipLimit} from "../get_actions/functions.js";

async function getCreatedAccounts(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    const {skip, limit} = getSkipLimit(query);
    const maxActions = fastify.manager.config.api.limits.get_created_accounts;
    const results = await fastify.elastic.search<any>({
        index: fastify.manager.chain + '-action-*',
        from: skip || 0,
        size: (maxActions && (limit > maxActions) ? maxActions : limit) || 100,
        query: {
            bool: {
                must: [
                    {term: {"act.authorization.actor": query.account.toLowerCase()}},
                    {term: {"act.name": "newaccount"}},
                    {term: {"act.account": "eosio"}}
                ]
            }
        },
        sort: ["global_sequence:desc"]
    });
    const response = {
        accounts: [] as any[]
    };
    if (results.hits.hits.length > 0) {
        for (let action of results.hits.hits) {
            const a = action._source;
            const _tmp: Record<string, any> = {};
            if (a.act.data.newact) {
                _tmp.name = a.act.data.newact;
            } else if (a['@newaccount'].newact) {
                _tmp.name = a['@newaccount'].newact;
            }
            _tmp.trx_id = a.trx_id;
            _tmp.timestamp = a['@timestamp'];
            response.accounts.push(_tmp);
        }
    }
    return response;
}

export function getCreatedAccountsHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getCreatedAccounts, fastify, request, route));
    }
}
