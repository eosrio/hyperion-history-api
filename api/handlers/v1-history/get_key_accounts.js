const {getCacheByHash} = require("../../helpers/functions");
const numeric = require('eosjs/dist/eosjs-numeric');
const ecc = require('eosjs-ecc');

const schema = {
    description: 'get accounts by public key',
    summary: 'get accounts by public key',
    tags: ['state'],
    body: {
        type: ['object', 'string'],
        properties: {
            "public_key": {
                description: 'public key',
                type: 'string'
            },
        },
        required: ["public_key"]
    },
    response: {
        200: {
            type: 'object',
            properties: {
                "account_names": {
                    type: "array",
                    items: {type: "string"}
                }
            }
        }
    }
};

async function get_key_accounts(fastify, request) {
    const {redis, elastic} = fastify;
    if (typeof request.body === 'string') {
        request.body = JSON.parse(request.body)
    }
    let public_Key = request.body.public_key.trim();
    if (!ecc.isValidPublic(public_Key)) {
        const err = new Error();
        err.statusCode = 400;
        err.message = 'invalid public key';
        throw err;
    } else {
        public_Key = numeric.convertLegacyPublicKey(public_Key);
    }
    const results = await elastic.search({
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

    const hits = results['body']['hits']['hits'];
    if (hits.length > 0) {
        response.account_names = hits.map((v) => {
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
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.post('/get_key_accounts', {schema}, async (request) => {
        return get_key_accounts(fastify, request);
    });
    next()
};
