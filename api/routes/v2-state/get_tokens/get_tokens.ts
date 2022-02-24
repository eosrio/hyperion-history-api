import {timedQuery} from "../../../helpers/functions";
import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {getSkipLimit} from "../../v2-history/get_actions/functions";
import { FeatureFlagClient } from "../../../shared/featureFlag/FeatureFlagClient";
import { FeatureFlagName } from "../../../featureFlags";


async function getTokens(fastify: FastifyInstance, request: FastifyRequest) {

    const query: any = request.query;

    const response = {'account': query.account, 'tokens': []};

    const {skip, limit} = getSkipLimit(request.query);
    const maxDocs = fastify.manager.config.api.limits.get_tokens ?? 100;

    const stateResult = await fastify.elastic.search({
        "index": fastify.manager.chain + '-table-accounts-*',
        "size": (limit > maxDocs ? maxDocs : limit) || 50,
        "from": skip || 0,
        "body": {
            query: {
                bool: {
                    filter: [{term: {"scope": query.account}}]
                }
            }
        }
    });

    const testSet = new Set();
    for (const hit of stateResult.body.hits.hits) {
        const data = hit._source;
        if (typeof data.present !== "undefined" && data.present === 0) {
            continue;
        }
        let precision;
        const key = `${data.code}_${data.symbol}`;

		if (testSet.has(key)) {
            continue;
        }

        testSet.add(key);
        if (!fastify.tokenCache) {
            fastify.tokenCache = new Map<string, any>();
        }
        if (fastify.tokenCache.has(key)) {
            precision = fastify.tokenCache.get(key).precision;
        } else {
            let token_data;
            try {
                token_data = await fastify.eosjs.rpc.get_currency_balance(data.code, query.account, data.symbol);
                if (token_data.length > 0) {
                    const [amount, symbol] = token_data[0].split(" ");
                    const amount_arr = amount.split(".");
                    if (amount_arr.length === 2) {
                        precision = amount_arr[1].length;
                        fastify.tokenCache.set(key, {precision});
                        // console.log('Caching token precision -', key, precision);
                    }
                }
            } catch (e) {
                console.log(`get_currency_balance error - contract:${data.code} - account:${query.account}`);
            }
        }

        response.tokens.push({
            symbol: data.symbol,
            precision: precision,
            amount: parseFloat(data.amount),
            contract: data.code
        });
    }

    return response;
}

export function getTokensHandler(fastify: FastifyInstance, route: string, featureFlagClient: FeatureFlagClient) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const isQueryingTokenValueEnabled = await featureFlagClient.variation(FeatureFlagName.IsQueryingTokenValueEnabled)

        if (!isQueryingTokenValueEnabled) {
            const query: any = request.query;
            const response = {
                'account': query.account,
                'tokens': [
                {
                    symbol: null,
                    precision: null,
                    amount: null,
                    contract: null
                }],
                'error': 'Accessing this route is forbidden'
            }

            reply.status(200).send(response)
        } else {
            reply.send(await timedQuery(getTokens, fastify, request, route));
        }
    }
}
