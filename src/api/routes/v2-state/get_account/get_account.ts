import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";

import {Dispatcher, request as undiciRequest} from 'undici';
import {getSkipLimit} from "../../v2-history/get_actions/functions.js";
import {getActions} from "../../v2-history/get_actions/get_actions.js";
import {hLog} from "../../../../indexer/helpers/common_functions.js";

const DEFAULT_ACTIONS_LIMIT = 20;

interface AccountDataResponse {
    actions: any[];
    total_actions: number;
    tokens: any[];
    links: any[];
}


async function getEnhancedAccountData(
    fastify: FastifyInstance,
    account: string,
    skip: number,
    limit: number
): Promise<AccountDataResponse> {
    const localApi = `http://${fastify.manager.config.api.server_addr}:${fastify.manager.config.api.server_port}/v2`;
    const getTokensApiUrl = `${localApi}/state/get_tokens?account=${account}`;
    const getActionsApiUrl = `${localApi}/history/get_actions?account=${account}` +
        `&limit=${limit}&skip=${skip}&noBinary=true&track=true`;
    const getLinksApiUrl = `${localApi}/state/get_links?account=${account}`;

    const requests: [
        Promise<Dispatcher.ResponseData>,
        Promise<Dispatcher.ResponseData>,
        Promise<Dispatcher.ResponseData>
    ] = [
        undiciRequest(getActionsApiUrl),
        undiciRequest(getTokensApiUrl),
        undiciRequest(getLinksApiUrl)
    ];

    const [actionsResponse, tokensResponse, linksResponse] = await Promise.all(requests);

    const [actionsResult, tokensResult, linksResult] = await Promise.all([
        actionsResponse.body.json() as any,
        tokensResponse.body.json() as any,
        linksResponse.body.json() as any
    ]);

    return {
        actions: actionsResult.actions,
        total_actions: actionsResult.total.value,
        tokens: tokensResult.tokens,
        links: linksResult.links
    };
}


interface NodeToken {
    symbol: string;
    precision: number;
    amount: number;
    contract: string;
}

/** Every balance the node reports in the system token contract; complete for that contract only. */
async function getNodeTokens(fastify: FastifyInstance, contract: string, account: string): Promise<NodeToken[]> {
    const balances = await fastify.antelope.chain.get_currency_balance(contract, account);
    return balances.map(balance => {
        const [quantity, symbol] = String(balance).split(' ');
        const decimals = quantity.split('.')[1];
        return {symbol, precision: decimals ? decimals.length : 0, amount: parseFloat(quantity), contract};
    });
}

/**
 * Extension providers have no qualified token or permission-link projection yet, so this reads only what the
 * node answers authoritatively plus the metadata action search, in this request's own proof scope. Parts that
 * cannot be served are listed in `unavailable` instead of being returned empty.
 */
async function getNodeAccountData(fastify: FastifyInstance, request: FastifyRequest, account: string,
                                  skip: number, limit: number) {
    const contract = `${fastify.manager.config.settings.eosio_alias ?? 'eosio'}.token`;
    const unavailable = ['links'];
    const maxActions = fastify.manager.config.api.limits.get_actions ?? 0;
    if (maxActions > 0 && limit > maxActions) limit = maxActions;
    const [actionsResult, tokens] = await Promise.all([
        getActions(fastify, request, {account, skip, limit, noBinary: true, track: 'true'}),
        getNodeTokens(fastify, contract, account).catch((e: any) => {
            hLog(`Error fetching ${contract} balances for ${account}: ${e.message}`);
            unavailable.push('tokens');
            return [];
        })
    ]);
    return {
        actions: actionsResult.actions,
        total_actions: actionsResult.total.value,
        tokens,
        token_contracts: [contract],
        unavailable
    };
}

async function getAccount(fastify: FastifyInstance, request: FastifyRequest) {
    const query: any = request.query;
    let {skip, limit} = getSkipLimit(query, 200);
    if (limit === 0) {
        limit = DEFAULT_ACTIONS_LIMIT;
    }

    const account = query.account;
    if (!account) {
        throw new Error("Account query parameter is required.");
    }

    let accountInfo: any = null;

    try {
        accountInfo = await fastify.antelope.getAccountUntyped(account);
    } catch (e: any) {
        console.error(`Error fetching account ${account}: ${e.message}`);
        throw new Error(`Account ${account} not found or error fetching account details.`);
    }

    if (fastify.manager.config.settings?.protocol?.provider === 'extension') {
        return {account: accountInfo, ...await getNodeAccountData(fastify, request, account, skip, limit)};
    }

    // Fetch actions, tokens, and links
    const apiData = await getEnhancedAccountData(fastify, account, skip, limit);

    return {
        account: accountInfo,
        actions: apiData.actions,
        total_actions: apiData.total_actions,
        tokens: apiData.tokens,
        links: apiData.links
    };
}


export function getAccountHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getAccount, fastify, request, route));
    }
}
