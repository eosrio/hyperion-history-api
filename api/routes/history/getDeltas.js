const {getDeltasSchema} = require("../../schemas");
const {getCacheByHash} = require("../../helpers/functions");

const route = '/get_deltas';
const maxDeltas = 200;

async function getDeltas(fastify, request) {
    const t0 = Date.now();
    console.log(request.query);
    const {redis, elastic} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, route + JSON.stringify(request.query) + 'v2');

    // if (cachedResponse) {
    //     return cachedResponse;
    // }

    let skip, limit;
    let sort_direction = 'desc';
    const mustArray = [];
    for (const param in request.query) {
        if (Object.prototype.hasOwnProperty.call(request.query, param)) {
            console.log(param, request.query[param]);
            const value = request.query[param];
            switch (param) {
                case 'limit': {
                    limit = parseInt(value, 10);
                    if (limit < 1) {
                        return 'invalid limit parameter';
                    }
                    break;
                }
                case 'skip': {
                    skip = parseInt(value, 10);
                    if (skip < 0) {
                        return 'invalid skip parameter';
                    }
                    break;
                }
                case 'sort': {
                    if (value === 'asc' || value === '1') {
                        sort_direction = 'asc';
                    } else if (value === 'desc' || value === '-1') {
                        sort_direction = 'desc'
                    } else {
                        return 'invalid sort direction';
                    }
                    break;
                }
                default: {
                    const values = request.query[param].split(",");
                    const terms = {};
                    terms[param] = values;
                    const shouldArray = {terms: terms};
                    const boolStruct = {bool: {should: [shouldArray]}};
                    mustArray.push(boolStruct);
                    break;
                }
            }
        }
    }


    let prefix = process.env.CHAIN;
    if (process.env.CHAIN === 'mainnet') {
        prefix = 'eos';
    }

    const results = await elastic.search({
        "index": prefix + '-delta-*',
        "from": skip || 0,
        "size": (limit > maxDeltas ? maxDeltas : limit) || 10,
        "body": {
            query: {bool: {must: mustArray}},
            sort: {
                "block_num": sort_direction
            }
        }
    });
    const response = {
        query_time: null,
        total: results['body']['hits']['total'],
        deltas: results['body']['hits']['hits'].map((d) => {
            delete d._source.present;
            return d._source;
        })
    };
    response['query_time'] = Date.now() - t0;
    // redis.set(hash, JSON.stringify(response));
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get(route, {
        schema: getDeltasSchema.GET
    }, async (request) => {
        return await getDeltas(fastify, request);
    });
    next()
};
