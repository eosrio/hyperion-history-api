import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";
import {getSkipLimit} from "../../v2-history/get_actions/functions.js";
import {hLog} from "../../../../indexer/helpers/common_functions.js";
import {PublicKey} from "@wharfkit/antelope";
import {request as undiciRequest} from "undici";


function invalidKey() {
    const err: any = new Error();
    err.statusCode = 400;
    err.message = 'invalid public key';
    throw err;
}

async function getKeyAccounts(fastify: FastifyInstance, request: FastifyRequest) {

    let pubKey: PublicKey;
    let pubKeyString: string = '';
    let pubKeyLegacy: string = '';
    if (typeof request.body === 'string' && request.method === 'POST') {
        request.body = JSON.parse(request.body);
    }

    const body: any = request.body;
    const query: any = request.query;

    const {skip, limit} = getSkipLimit(request.query);
    const maxDocs = fastify.manager.config.api.limits.get_key_accounts ?? 1000;

    const public_Key = request.method === 'POST' ? body.public_key : query.public_key;

    if (!public_Key) {
        invalidKey();
    }

    try {
        pubKey = PublicKey.from(public_Key);
        pubKeyString = pubKey.toString();
        let chainToken = fastify.manager.config.api.custom_core_token ?? 'EOS';
        pubKeyLegacy = pubKey.toLegacyString(chainToken || 'EOS');
    } catch (e: any) {
        hLog(e.message);
        invalidKey();
    }

    if (!pubKeyString) {
        invalidKey();
    }

    const response = {
        public_key: pubKeyString,
        cv: pubKeyLegacy,
        account_names: []
    } as any;

    if (request.method === 'GET' && query.details) {
        response.permissions = [];
    }

    // use get_accounts_by_authorizers if available
    try {
        const server = fastify.manager.config.api.chain_api;
        const url = server + '/v1/chain/get_accounts_by_authorizers';
        const data = await undiciRequest(url, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({keys: [pubKeyString]})
        });
        if (data.statusCode === 200) {
            const body = await data.body.json() as any;
            if (body.accounts) {
                for (const account of body.accounts) {
                    response.account_names.push(account.account_name);
                    if (request.method === 'GET' && query.details) {
                        if (account.authorizing_key === pubKeyLegacy || account.authorizing_key === pubKeyString) {
                            response.permissions.push({
                                owner: account.account_name,
                                name: account.permission_name,
                                weight: account.weight,
                                threshold: account.threshold
                            });
                        }
                    }
                }
            }
        } else {
            if (data.statusCode === 404) {
                hLog(`⚠️  /v1/chain/get_accounts_by_authorizers not available on ${server}`);
            }
        }
    } catch
        (e: any) {
        console.log(e);
    }

    // early return if we have results from get_accounts_by_authorizers
    if (response.account_names.length > 0) {
        response.account_names = [...(new Set(response.account_names))];
        return response;
    }

    try {
        const permTableResults = await fastify.elastic.search<any>({
            index: fastify.manager.chain + '-perm-*',
            size: (limit > maxDocs ? maxDocs : limit) || 100,
            from: skip || 0,
            query: {
                bool: {
                    must: [
                        {term: {"auth.keys.key.keyword": pubKeyString}}
                    ]
                }
            }
        });
        if (permTableResults.hits.hits.length > 0) {
            for (const perm of permTableResults.hits.hits) {
                response.account_names.push(perm._source.owner);
                if (request.method === 'GET' && query.details) {
                    response.permissions.push(perm._source);
                }
            }
        }
    } catch (e: any) {
        console.log(e.message);
    }

    if (response.account_names.length > 0) {
        response.account_names = [...(new Set(response.account_names))];
        return response;
    }

    // Fallback to action search
    const results = await fastify.elastic.search<any>({
        index: fastify.manager.chain + '-action-*',
        size: (limit > maxDocs ? maxDocs : limit) || 100,
        from: skip || 0,
        query: {
            bool: {
                should: [
                    {term: {"@updateauth.auth.keys.key.keyword": pubKeyString}},
                    {term: {"@newaccount.active.keys.key.keyword": pubKeyString}},
                    {term: {"@newaccount.owner.keys.key.keyword": pubKeyString}}
                ],
                minimum_should_match: 1
            }
        },
        sort: [{"global_sequence": {"order": "desc"}}]
    });

    if (results.hits.hits.length > 0) {
        response.account_names = results.hits.hits.map((v) => {
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

    if (response.account_names.length > 0) {
        response.account_names = [...(new Set(response.account_names))];
    }

    return response;
}

export function getKeyAccountsHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getKeyAccounts, fastify, request, route));
    }
}
