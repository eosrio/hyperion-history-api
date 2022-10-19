import got from "got";
import { timedQuery } from "../../../helpers/functions.js";
async function getAccount(fastify, request) {
    const query = request.query;
    const response = {
        account: null,
        actions: null,
        total_actions: 0,
        tokens: null,
        links: undefined
    };
    const account = query.account;
    const reqQueue = [];
    try {
        response.account = await fastify.eosjs.rpc.get_account(account);
    }
    catch (e) {
        throw new Error("Account not found!");
    }
    const localApi = `http://${fastify.manager.config.api.server_addr}:${fastify.manager.config.api.server_port}/v2`;
    const getTokensApi = localApi + '/state/get_tokens';
    const getActionsApi = localApi + '/history/get_actions';
    const getLinksApi = localApi + '/state/get_links';
    // fetch recent actions
    reqQueue.push(got.get(`${getActionsApi}?account=${account}&limit=20&noBinary=true&track=true`).json());
    // fetch account tokens
    reqQueue.push(got.get(`${getTokensApi}?account=${account}`).json());
    // fetch account permission links
    reqQueue.push(got.get(`${getLinksApi}?account=${account}`).json());
    const results = await Promise.all(reqQueue);
    response.actions = results[0].actions;
    response.total_actions = results[0].total.value;
    response.tokens = results[1].tokens;
    response.links = results[2].links;
    return response;
}
export function getAccountHandler(fastify, route) {
    return async (request, reply) => {
        reply.send(await timedQuery(getAccount, fastify, request, route));
    };
}
