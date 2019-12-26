const prettyjson = require("prettyjson");
const {getActionsSchema} = require("../../schemas");
const {getCacheByHash, mergeActionMeta} = require("../../helpers/functions");

const maxActions = 1000;
const route = '/get_actions';

const terms = [
    "notified.keyword",
    "act.authorization.actor"
];

const extendedActions = new Set([
    "transfer",
    "newaccount",
    "updateauth",
    "buyram",
    "buyrambytes"
]);

const primaryTerms = [
    "notified",
    "block_num",
    "global_sequence",
    "producer",
    "@timestamp",
    "creator_action_ordinal",
    "action_ordinal",
    "cpu_usage_us",
    "net_usage_words"
];

const enable_caching = process.env.ENABLE_CACHING === 'true';
let cache_life = 30;
if (process.env.CACHE_LIFE) {
    cache_life = parseInt(process.env.CACHE_LIFE);
}

function getTrackTotalHits(query) {
    let trackTotalHits = 15000;
    if (query.track) {
        if (query.track === 'true') {
            trackTotalHits = true;
        } else if (query.track === 'false') {
            trackTotalHits = false;
        } else {
            trackTotalHits = parseInt(query.track, 10);
            if (trackTotalHits !== trackTotalHits) {
                throw new Error('failed to parse track param');
            }
        }
    }
    return trackTotalHits;
}

function addSortedBy(query, queryBody, sort_direction) {
    if (query['sortedBy']) {
        const opts = query['sortedBy'].split(":");
        const sortedByObj = {};
        sortedByObj[opts[0]] = opts[1];
        queryBody['sort'] = sortedByObj;
    } else {
        queryBody['sort'] = {
            "global_sequence": sort_direction
        };
    }
}

function processMultiVars(queryStruct, parts, field) {
    const must = [];
    const mustNot = [];

    parts.forEach(part => {
        if (part.startsWith("!")) {
            mustNot.push(part.replace("!", ""));
        } else {
            must.push(part);
        }
    });

    if (must.length > 1) {
        queryStruct.bool.must.push({
            bool: {
                should: must.map(elem => {
                    const _q = {};
                    _q[field] = elem;
                    return {term: _q}
                })
            }
        });
    } else if (must.length === 1) {
        const mustQuery = {};
        mustQuery[field] = must[0];
        queryStruct.bool.must.push({term: mustQuery});
    }

    if (mustNot.length > 1) {
        queryStruct.bool.must_not.push({
            bool: {
                should: mustNot.map(elem => {
                    const _q = {};
                    _q[field] = elem;
                    return {term: _q}
                })
            }
        });
    } else if (mustNot.length === 1) {
        const mustNotQuery = {};
        mustNotQuery[field] = mustNot[0].replace("!", "");
        queryStruct.bool.must_not.push({term: mustNotQuery});
    }
}

function addRangeQuery(queryStruct, prop, pkey, query) {
    const _termQuery = {};
    const parts = query[prop].split("-");
    _termQuery[pkey] = {
        "gte": parts[0],
        "lte": parts[1]
    };
    queryStruct.bool.must.push({range: _termQuery});
}

function applyTimeFilter(query, queryStruct) {
    if (query['after'] || query['before']) {
        let _lte = "now";
        let _gte = 0;
        if (query['before']) {
            _lte = query['before'];
            if (!_lte.endsWith("Z")) {
                _lte += "Z";
            }
        }
        if (query['after']) {
            _gte = query['after'];
            if (!_gte.endsWith("Z")) {
                _gte += "Z";
            }
        }
        if (!queryStruct.bool['filter']) {
            queryStruct.bool['filter'] = [];
        }
        queryStruct.bool['filter'].push({
            range: {
                "@timestamp": {
                    "gte": _gte,
                    "lte": _lte
                }
            }
        });
    }
}

function applyGenericFilters(query, queryStruct) {
    for (const prop in query) {
        if (Object.prototype.hasOwnProperty.call(query, prop)) {
            const pair = prop.split(".");
            if (pair.length > 1 || primaryTerms.includes(pair[0])) {
                let pkey;
                if (pair.length > 1) {
                    pkey = extendedActions.has(pair[0]) ? "@" + prop : prop;
                } else {
                    pkey = prop;
                }
                if (query[prop].indexOf("-") !== -1) {
                    addRangeQuery(queryStruct, prop, pkey, query);
                } else {
                    const _termQuery = {};
                    const parts = query[prop].split(",");
                    if (parts.length > 1) {
                        processMultiVars(queryStruct, parts, prop);
                    } else if (parts.length === 1) {
                        const andParts = parts[0].split(" ");
                        if (andParts.length > 1) {
                            andParts.forEach(value => {
                                const _q = {};
                                console.log(value);
                                _q[pkey] = value;
                                queryStruct.bool.must.push({term: _q});
                            });
                        } else {
                            if (parts[0].startsWith("!")) {
                                _termQuery[pkey] = parts[0].replace("!", "");
                                queryStruct.bool.must_not.push({term: _termQuery});
                            } else {
                                _termQuery[pkey] = parts[0];
                                queryStruct.bool.must.push({term: _termQuery});
                            }
                        }
                    }
                }
            }
        }
    }
}

function makeShouldArray(query) {
    const should_array = [];
    for (const entry of terms) {
        const tObj = {term: {}};
        tObj.term[entry] = query.account;
        should_array.push(tObj);
    }
    return should_array;
}

function applyCodeActionFilters(query, queryStruct) {
    let filterObj = [];
    if (query.filter) {
        for (const filter of query.filter.split(',')) {
            if (filter !== '*:*') {
                const _arr = [];
                const parts = filter.split(':');
                if (parts.length === 2) {
                    [code, method] = parts;
                    if (code && code !== "*") {
                        _arr.push({'term': {'act.account': code}});
                    }
                    if (method && method !== "*") {
                        _arr.push({'term': {'act.name': method}});
                    }
                }
                if (_arr.length > 0) {
                    filterObj.push({bool: {must: _arr}});
                }
            }
        }
        if (filterObj.length > 0) {
            queryStruct.bool['should'] = filterObj;
            queryStruct.bool['minimum_should_match'] = 1;
        }
    }
}

function getSkipLimit(query) {
    let skip, limit;
    skip = parseInt(query.skip, 10);
    if (skip < 0) {
        throw new Error('invalid skip parameter');
    }
    limit = parseInt(query.limit, 10);
    if (limit < 1) {
        throw new Error('invalid limit parameter');
    }
    return {skip, limit};
}

function getSortDir(query) {
    let sort_direction = 'desc';
    if (query.sort) {
        if (query.sort === 'asc' || query.sort === '1') {
            sort_direction = 'asc';
        } else if (query.sort === 'desc' || query.sort === '-1') {
            sort_direction = 'desc'
        } else {
            throw new Error('invalid sort direction');
        }
    }
    return sort_direction;
}

function applyAccountFilters(query, queryStruct) {
    if (query.account) {
        queryStruct.bool.must.push({"bool": {should: makeShouldArray(query)}});
    }
}

async function getActions(fastify, request) {
    const t0 = Date.now();
    const {redis, elastic, eosjs} = fastify;
    const query = request.query;
    let cachedResponse, hash;
    if (enable_caching) {
        [cachedResponse, hash] = await getCacheByHash(redis, route + JSON.stringify(query));
        if (cachedResponse) {
            cachedResponse = JSON.parse(cachedResponse);
            cachedResponse['query_time'] = Date.now() - t0;
            cachedResponse['cached'] = true;
            return cachedResponse;
        }
    }

    const queryStruct = {
        "bool": {
            must: [],
            must_not: [],
            boost: 1.0
        }
    };

    const {skip, limit} = getSkipLimit(query);

    const sort_direction = getSortDir(query);

    applyAccountFilters(query, queryStruct);

    applyGenericFilters(query, queryStruct);

    applyTimeFilter(query, queryStruct);

    applyCodeActionFilters(query, queryStruct);

    // allow precise counting of total hits
    const trackTotalHits = getTrackTotalHits(query);

    // Prepare query body
    const query_body = {
        "track_total_hits": trackTotalHits,
        "query": queryStruct
    };

    // Include sorting
    addSortedBy(query, query_body, sort_direction);

    // console.log(prettyjson.render(queryStruct));

    // Perform search
    const pResults = await Promise.all([eosjs.rpc.get_info(), elastic['search']({
        "index": process.env.CHAIN + '-action-*',
        "from": skip || 0,
        "size": (limit > maxActions ? maxActions : limit) || 10,
        "body": query_body
    })]);

    const results = pResults[1]['body']['hits'];
    const response = {
        query_time: null,
        cached: false,
        lib: pResults[0].last_irreversible_block_num,
        total: results['total']
    };

    if (query.simple) {
        response['simple_actions'] = [];
    } else {
        response['actions'] = [];
    }

    if (results['hits'].length > 0) {
        const actions = results['hits'];
        for (let action of actions) {
            action = action._source;
            mergeActionMeta(action);
            if (query.simple) {
                response.simple_actions.push({
                    block: action['block_num'],
                    irreversible: action['block_num'] < pResults[0].last_irreversible_block_num,
                    timestamp: action['@timestamp'],
                    transaction_id: action['trx_id'],
                    actors: action['act']['authorization'].map(a => `${a.actor}@${a.permission}`).join(","),
                    notified: action['notified'].join(','),
                    contract: action['act']['account'],
                    action: action['act']['name'],
                    data: action['act']['data']
                });
            } else {
                response.actions.push(action);
            }
        }
    }

    response['query_time'] = Date.now() - t0;

    if (enable_caching) {
        redis.set(hash, JSON.stringify(response), 'EX', cache_life);
    }

    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get('/get_actions', {
        schema: getActionsSchema.GET
    }, async (request) => {
        return await getActions(fastify, request);
    });
    next()
};
