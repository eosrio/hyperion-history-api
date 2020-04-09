import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {ServerResponse} from "http";
import {timedQuery} from "../../../helpers/functions";
import {getSkipLimit} from "../get_actions/functions";

async function getCreatedAccounts(fastify: FastifyInstance, request: FastifyRequest) {


    const {skip, limit} = getSkipLimit(request.query);
    const maxActions = fastify.manager.config.api.limits.get_created_accounts;
    const results = await fastify.elastic.search({
        "index": fastify.manager.chain + '-action-*',
        "from": skip || 0,
        "size": (limit > maxActions ? maxActions : limit) || 100,
        "body": {
            "query": {
                "bool": {
                    must: [
                        {term: {"act.authorization.actor": request.query.account.toLowerCase()}},
                        {term: {"act.name": "newaccount"}},
                        {term: {"act.account": "eosio"}}
                    ]
                }
            },
            sort: {
                "global_sequence": "desc"
            }
        }
    });

    const response = {accounts: []};

    if (results['body']['hits']['hits'].length > 0) {
        const actions = results['body']['hits']['hits'];
        for (let action of actions) {
            action = action._source;
            const _tmp = {};
            if (action['act']['data']['newact']) {
                _tmp['name'] = action['act']['data']['newact'];
            } else if (action['@newaccount']['newact']) {
                _tmp['name'] = action['@newaccount']['newact'];
            } else {
                console.log(action);
            }
            _tmp['trx_id'] = action['trx_id'];
            _tmp['timestamp'] = action['@timestamp'];
            response.accounts.push(_tmp);
        }
    }

    return response;
}

export function getCreatedAccountsHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply<ServerResponse>) => {
        reply.send(await timedQuery(getCreatedAccounts, fastify, request, route));
    }
}
