const {getCacheByHash} = require("../../helpers/functions");

const {getTransactedAccountsSchema} = require("../../schemas");

async function getTransactedAccounts(fastify, request) {
    const t0 = Date.now();
    const {redis, elasticsearch} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(request.query));
    if (cachedResponse) {
        return cachedResponse;
    }
    const {account, min, max, direction, limit, contract, symbol} = request.query;
    let _limit = 100;
    if (limit) {
        _limit = parseInt(limit, 10);
        if (_limit > 500) {
            _limit = 500;
        }
    }
    let _min;
    if (min) {
        _min = parseInt(min, 10);
        if (_min < 0) {
            _min = 0;
        }
    }
    let _max;
    if (max) {
        _max = parseInt(max, 10);
        if (_max < 0) {
            _max = null;
        }
    }

    const response = {
        query_time: null,
        account: account
    };

    const must_array = [
        {term: {"notified": account}},
        {term: {"act.name": "transfer"}}
    ];

    if (min || max) {
        const _range = {
            "@transfer.amount": {}
        };
        if (min) {
            _range["@transfer.amount"]["gte"] = _min;
        }
        if (max) {
            _range["@transfer.amount"]["lt"] = _max;
        }
        must_array.push({range: _range});
    }

    if (contract) {
        must_array.push({term: {"act.account": contract}});
        response['contract'] = contract;
    }

    if (symbol) {
        must_array.push({term: {"@transfer.symbol": symbol}});
        response['symbol'] = symbol;
    }

    const sum_agg = {
        "total_amount": {
            sum: {
                field: "@transfer.amount"
            }
        }
    };

    let filter_array = [];
    if (request.query['after'] || request.query['before']) {
        let _lte = "now";
        let _gte = 0;
        if (request.query['before']) {
            _lte = request.query['before'];
        }
        if (request.query['after']) {
            _gte = request.query['after'];
        }
        filter_array.push({
            range: {
                "@timestamp": {
                    "gte": _gte,
                    "lte": _lte
                }
            }
        });
    } else {
        filter_array.push({
            range: {
                "block_num": {
                    "gte": 0
                }
            }
        });
    }

    if (direction === 'out' || direction === 'both') {
        const outResults = await elasticsearch.search({
            index: process.env.CHAIN + '-action-*',
            body: {
                size: 0,
                aggs: {
                    "receivers": {
                        terms: {
                            field: "@transfer.to",
                            size: _limit,
                            order: {
                                "total_amount": "desc"
                            }
                        },
                        aggs: sum_agg
                    }
                },
                query: {
                    bool: {
                        must: must_array,
                        filter: filter_array,
                        must_not: [
                            {term: {"@transfer.to": account}}
                        ]
                    }
                }
            }
        });
        response['total_out'] = 0;
        response['outputs'] = outResults['aggregations']['receivers']['buckets'].map((bucket) => {
            const _sum = parseFloat(bucket.total_amount.value.toFixed(4));
            response['total_out'] += _sum;
            return {
                account: bucket.key,
                sum: _sum,
                transfers: bucket['doc_count'],
                average: parseFloat((bucket.total_amount.value / bucket['doc_count']).toFixed(4))
            };
        });
        response['total_out'] = parseFloat(response['total_out'].toFixed(4));
    }

    if (direction === 'in' || direction === 'both') {
        const inResults = await elasticsearch.search({
            index: process.env.CHAIN + '-action-*',
            body: {
                size: 0,
                aggs: {
                    "senders": {
                        terms: {
                            field: "@transfer.from",
                            size: _limit,
                            order: {
                                "total_amount": "desc"
                            }
                        },
                        aggs: sum_agg
                    }
                },
                query: {
                    bool: {
                        must: must_array,
                        filter: filter_array,
                        must_not: [
                            {term: {"@transfer.from": account}}
                        ]
                    }
                }
            }
        });
        response['total_in'] = 0;
        response['inputs'] = inResults['aggregations']['senders']['buckets'].map((bucket) => {
            const _sum = parseFloat(bucket.total_amount.value.toFixed(4));
            response['total_in'] += _sum;
            return {
                account: bucket.key,
                sum: _sum,
                transfers: bucket['doc_count'],
                average: parseFloat((bucket.total_amount.value / bucket['doc_count']).toFixed(4))
            };
        });
        response['total_in'] = parseFloat(response['total_in'].toFixed(4));
    }

    response['query_time'] = Date.now() - t0;
    redis.set(hash, JSON.stringify(response), 'EX', 600);
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get('/get_transacted_accounts', {
        schema: getTransactedAccountsSchema.GET
    }, async (request, reply) => {
        reply.send(await getTransactedAccounts(fastify, request));
    });
    next()
};
