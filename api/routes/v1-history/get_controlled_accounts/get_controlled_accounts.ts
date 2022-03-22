import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions";
import {SearchHit} from "@elastic/elasticsearch/lib/api/types";

async function getControlledAccounts(fastify: FastifyInstance, request: FastifyRequest) {
    let body;
    if (typeof request.body === 'string') {
        body = JSON.parse(request.body) as any;
    }
    let controlling_account;
    if (request && request.body && body["controlling_account"]) {
        controlling_account = body["controlling_account"]
    }
    const results = await fastify.elastic.search({
        index: fastify.manager.chain + '-action-*',
        size: 100,
        body: {
            query: {
                bool: {
                    should: [
                        {
                            term: {"@updateauth.auth.accounts.permission.actor": controlling_account}
                        },
                        {
                            bool: {
                                must: [
                                    {term: {"act.account": "eosio"}},
                                    {term: {"act.name": "newaccount"}},
                                    {term: {"act.authorization.actor": controlling_account}}
                                ]
                            }
                        }
                    ],
                    minimum_should_match: 1
                }
            },
            sort: [
                {"global_sequence": {"order": "desc"}}
            ]
        }
    });

    const response = {
        controlled_accounts: [] as any[]
    };

    const hits = results.hits.hits;

    if (hits.length > 0) {
        response.controlled_accounts = hits.map((v: SearchHit<any>) => {
            if (v._source.act.name === 'newaccount') {
                if (v._source['@newaccount'].newact) {
                    return v._source['@newaccount'].newact;
                } else if (v._source.act.data.newact) {
                    return v._source.act.data.newact;
                } else {
                    return null;
                }
            } else if (v._source.act.name === 'updateauth') {
                return v._source.act.data.account;
            } else {
                return null;
            }
        });
    }
    if (response.controlled_accounts.length > 0) {
        response.controlled_accounts = [...(new Set(response.controlled_accounts))];
    }
    return response;
}

export function getControlledAccountsHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getControlledAccounts, fastify, request, route));
    }
}
