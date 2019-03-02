const {getKeyAccountsSchema} = require("../schemas");
const {getCacheByHash} = require("../helpers/functions");
const numeric = require('eosjs/dist/eosjs-numeric');
const ecc = require('eosjs-ecc');

async function getKeyAccounts(fastify, request) {
    const {redis, elasticsearch} = fastify;
    let public_Key = request.query.public_key;
    if (!ecc.isValidPublic(public_Key)) {
        return 'invalid public key'
    } else {
        public_Key = numeric.convertLegacyPublicKey(public_Key);
    }
    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(request.query));
    if (cachedResponse) {
        return cachedResponse;
    }
    const results = await elasticsearch.search({
        index: process.env.CHAIN + '-action-*',
        size: 1,
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
        response.account_names.push(...results['hits']['hits'].map((v) => {
            if (v._source.act.name === 'newaccount') {
                return v._source.act.data.newact;
            } else if (v._source.act.name === 'updateauth') {
                return v._source.act.data.account;
            } else {
                return null;
            }
        }));
    }
    redis.set(hash, JSON.stringify(response), 'EX', 30);
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get('/get_key_accounts', {
        schema: getKeyAccountsSchema.GET
    }, async (request, reply) => {
        reply.send(await getKeyAccounts(fastify, request));
    });
    next()
};
