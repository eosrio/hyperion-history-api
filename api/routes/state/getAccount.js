const {getAccountSchema} = require("../../schemas");
const {getCacheByHash} = require("../../helpers/functions");
const route = '/get_account';
const got = require('got');

const localApi = `http://${process.env.SERVER_ADDR}:${process.env.SERVER_PORT}/v2`;
const getTokensApi = localApi + '/state/get_tokens';
const getActionsApi = localApi + '/history/get_actions';

const enable_caching = process.env.ENABLE_CACHING === 'true';
let cache_life = 30;
if (process.env.CACHE_LIFE) {
    cache_life = parseInt(process.env.CACHE_LIFE);
}

async function getAccount(fastify, request) {
    const t0 = Date.now();
    const {redis, elastic, eosjs} = fastify;

    // let cachedResponse, hash;
    // if(enable_caching) {
    //     [cachedResponse, hash] = await getCacheByHash(redis, route + JSON.stringify(request.query));
    //     if (cachedResponse) {
    //         cachedResponse = JSON.parse(cachedResponse);
    //         cachedResponse['query_time'] = Date.now() - t0;
    //         cachedResponse['cached'] = true;
    //         return cachedResponse;
    //     }
    // }

    const response = {
        query_time: null,
        cached: false,
        account: null,
        actions: null,
        tokens: null,
        links: null
    };

    const account = request.query.account;
    const reqQueue = [];
    reqQueue.push(eosjs.rpc.get_account(account));

    // fetch recent actions
    reqQueue.push(got.get(`${getActionsApi}?account=${account}&limit=10`));

    // fetch account tokens
    reqQueue.push(got.get(`${getTokensApi}?account=${account}`));

    const results = await Promise.all(reqQueue);
    response.account = results[0];
    response.actions = JSON.parse(results[1].body).actions;
    response.tokens = JSON.parse(results[2].body).tokens;
    response['query_time'] = Date.now() - t0;
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get(route, {
        schema: getAccountSchema.GET
    }, async (request) => {
        return await getAccount(fastify, request);
    });
    next()
};
