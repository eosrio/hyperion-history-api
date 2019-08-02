const {getKeyAccountsSchema} = require("../../schemas");
const {getCacheByHash} = require("../../helpers/functions");
const numeric = require('eosjs/dist/eosjs-numeric');
const ecc = require('eosjs-ecc');

async function getKeyAccounts(fastify, request) {
    const {redis, elasticsearch} = fastify;
    let public_Key = request.query.public_key;
    if (!ecc.isValidPublic(public_Key)) {
        const err = new Error();
        err.statusCode = 400;
        err.message = 'invalid public key';
        throw err;
    } else {
        public_Key = numeric.convertLegacyPublicKey(public_Key);
    }
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
                        {term: {"@updateauth.auth.keys.key.keyword": public_Key}},
                        {term: {"@newaccount.active.keys.key.keyword": public_Key}},
                        {term: {"@newaccount.owner.keys.key.keyword": public_Key}}
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
        account_names: []
    };
    if (results['hits']['hits'].length > 0) {
        response.account_names = results['hits']['hits'].map((v) => {
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
        response.account_names = Array.from(new Set(response.account_names));
        redis.set(hash, JSON.stringify(response), 'EX', 30);
        return response;
    } else {
        const err = new Error();
        err.statusCode = 404;
        err.message = 'no accounts associated with ' + public_Key;
        throw err;
    }
}

module.exports = function (fastify, opts, next) {
    fastify.get('/get_key_accounts', {
        schema: getKeyAccountsSchema.GET
    }, async (request) => {
        return getKeyAccounts(fastify, request);
    });
    next()
};
