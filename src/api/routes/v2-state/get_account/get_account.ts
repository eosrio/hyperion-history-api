import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {timedQuery} from "../../../helpers/functions.js";

async function getAccount(fastify: FastifyInstance, request: FastifyRequest) {


    const query: any = request.query;

    const response: any = {
        account: null,
        actions: null,
        total_actions: 0,
        tokens: null,
        links: null
    };

    const account = query.account;
    const reqQueue: Promise<Response>[] = [];

    try {
        response.account = await fastify.eosjs.rpc.get_account(account);
    } catch (e) {
        throw new Error("Account not found!");
    }

    const localApi = `http://${fastify.manager.config.api.server_addr}:${fastify.manager.config.api.server_port}/v2`;
    const getTokensApi = localApi + '/state/get_tokens';
    const getActionsApi = localApi + '/history/get_actions';
    const getLinksApi = localApi + '/state/get_links';

    // fetch recent actions
    reqQueue.push(fetch(`${getActionsApi}?account=${account}&limit=20&noBinary=true&track=true`));
    // reqQueue.push(got.get(`${getActionsApi}?account=${account}&limit=20&noBinary=true&track=true`).json());

    // fetch account tokens
    reqQueue.push(fetch(`${getTokensApi}?account=${account}`));
    // reqQueue.push(got.get(`${getTokensApi}?account=${account}`).json());

    // fetch account permission links
    reqQueue.push(fetch(`${getLinksApi}?account=${account}`));
    // reqQueue.push(got.get(`${getLinksApi}?account=${account}`).json());

    // FETCH
    const results = await Promise.all((await Promise.all(reqQueue)).map(p => p.json()));

    // GOT
    // const results = await Promise.all(reqQueue);

    response.actions = results[0].actions;
    response.total_actions = results[0].total.value;
    response.tokens = results[1].tokens;
    response.links = results[2].links;
    return response;
}

export function getAccountHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getAccount, fastify, request, route));
    }
}
