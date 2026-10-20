import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";
import {getSkipLimit} from "../get_actions/functions.js";
import {protectProtocolAction} from '../../../helpers/protocol-abi.js';
import {searchActions} from '../../../helpers/action-search.js';
import {ProtocolAbiProofUnavailableError} from '../../../../indexer/protocol/abi-proof.js';

async function getCreatedAccounts(fastify: FastifyInstance, request: FastifyRequest) {


    const query: any = request.query;
    const {skip, limit} = getSkipLimit(query);
    const maxActions = fastify.manager.config.api.limits.get_created_accounts ?? 0;
    const results = await searchActions<any>(fastify, request, {
        index: fastify.manager.readIndexset('action'),
        from: skip || 0,
        size: (limit > maxActions ? maxActions : limit) || 100,
        query: {
            bool: {
                must: [
                    {term: {"act.authorization.actor": query.account.toLowerCase()}},
                    {term: {"act.name": "newaccount"}},
                    {term: {"act.account": fastify.manager.config.settings.eosio_alias ?? 'eosio'}}
                ]
            }
        },
        sort: {
            global_sequence: "desc"
        }
    });

    const response: any = {accounts: []};

    if (results.hits.hits.length > 0) {
        const actions = results.hits.hits;
        for (const hit of actions) {
            const action = hit._source;
            await protectProtocolAction(fastify, request, action, {decode: true});
            const _tmp = {};
            if (fastify.manager.config.settings?.protocol?.provider === 'extension') {
                const name = action.act.data?.newact ?? action.act.data?.name;
                if (typeof name !== 'string' || !name) throw new ProtocolAbiProofUnavailableError('created_account_unavailable',
                    'The certified account creation input does not supply an account name');
                _tmp['name'] = name;
            } else if (action['act']['data']['newact']) {
                _tmp['name'] = action['act']['data']['newact'];
            } else if (action['@newaccount']?.['newact']) {
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
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getCreatedAccounts, fastify, request, route));
    }
}
