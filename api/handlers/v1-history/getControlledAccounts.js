const {getControlledAccountsSchema} = require("../../schemas");
const {getCacheByHash} = require("../../helpers/functions");
const numeric = require('eosjs/dist/eosjs-numeric');
const ecc = require('eosjs-ecc');

async function getKeyAccounts(fastify, request) {
    const {redis, elasticsearch} = fastify;
    let controlling_account = request.query.controlling_account;
    // if (!ecc.isValidPublic(controlling_account)) {
    //     const err = new Error();
    //     err.statusCode = 400;
    //     err.message = 'invalid account';
    //     throw err;
    // } else {
    //     controlling_account = numeric.convertLegacyPublicKey(controlling_account);
    // }
    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(request.query));
    if (cachedResponse) {
        return cachedResponse;
    }
    const results = await elasticsearch.search({
        index: process.env.CHAIN + '-action-*',
        size: 100,
        body: {
            query: {
                bool: {
                    should: [
                        {term: {"@updateauth.auth.keys.key.keyword": controlling_account}},
                        {term: {"@newaccount.active.keys.key.keyword": controlling_account}},
                        {term: {"@newaccount.owner.keys.key.keyword": controlling_account}}
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
        controlled_accounts: []
    };
    if (results['hits']['hits'].length > 0) {
        response.controlled_accounts = results['hits']['hits'].map((v) => {
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
        response.controlled_accounts = Array.from(new Set(response.controlled_accounts));
        redis.set(hash, JSON.stringify(response), 'EX', 30);
    }
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get('/get_controlled_accounts', {
        schema: getControlledAccountsSchema.GET
    }, async (request) => {
        return getKeyAccounts(fastify, request);
    });
    next()
};
