const {getActionsSchema} = require("../schemas");
const {getCacheByHash} = require("../helpers/functions");
const _ = require('lodash');
const fetch = require('node-fetch');
const {JsonRpc} = require('eosjs');
const eos_endpoint = process.env.NODEOS_HTTP;
const rpc = new JsonRpc(eos_endpoint, {fetch});

const terms = ["notified", "act.authorization.actor"];

async function getActions(fastify, request) {
    const t0 = Date.now();
    const maxActions = 100;
    const {redis, elasticsearch} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(request.query));
    if (cachedResponse) {
        return cachedResponse;
    }
    const should_array = [];
    for (const entry of terms) {
        const tObj = {term: {}};
        tObj.term[entry] = request.query.account;
        should_array.push(tObj);
    }
    let code, method, skip, limit;
    let sort_direction = 'desc';
    let filterObj = [];
    if (request.query.filter) {
        const filters = request.query.filter.split(',');
        console.log(filters);
        for (const filter of filters) {
            const newbool = {bool: {must: []}};
            const parts = filter.split(':');
            if (parts.length === 2) {
                [code, method] = parts;
                if (code && code !== "*") {
                    newbool.bool.must.push({'term': {'act.account': code}});
                }
                if (method && method !== "*") {
                    newbool.bool.must.push({'term': {'act.name': method}});
                }
            }
            filterObj.push(newbool);
        }
    }
    skip = parseInt(request.query.skip, 10);
    if (skip < 0) {
        return 'invalid skip parameter';
    }
    limit = parseInt(request.query.limit, 10);
    if (limit < 1) {
        return 'invalid limit parameter';
    }
    if (request.query.sort) {
        if (request.query.sort === 'asc' || request.query.sort === '1') {
            sort_direction = 'asc';
        } else if (request.query.sort === 'desc' || request.query.sort === '-1') {
            sort_direction = 'desc'
        } else {
            return 'invalid sort direction';
        }
    }

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
    }

    const pResults = await Promise.all([rpc.get_info(), elasticsearch['search']({
        "index": process.env.CHAIN + '-action-*',
        "from": skip || 0,
        "size": (limit > maxActions ? maxActions : limit) || 10,
        "body": {
            "query": {
                "bool": {
                    must: [{"bool": {should: should_array}}],
                    should: filterObj,
                    filter: filter_array,
                    minimum_should_match: 1,
                    boost: 1.0
                }
            },
            "sort": {
                "global_sequence": sort_direction
            }
        }
    })]);
    const results = pResults[1];
    const response = {
        query_time: null,
        lib: pResults[0].last_irreversible_block_num,
        actions: []
    };
    if (results['hits']['hits'].length > 0) {
        const actions = results['hits']['hits'];
        for (let action of actions) {
            action = action._source;
            const name = action.act.name;
            if (action['@' + name]) {
                action['act']['data'] = _.merge(action['@' + name], action['act']['data']);
                delete action['@' + name];
            }
            response.actions.push(action);
        }
    }
    response['query_time'] = Date.now() - t0;
    redis.set(hash, JSON.stringify(response), 'EX', 30);
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get('/get_actions', {
        schema: getActionsSchema.GET
    }, async (request, reply) => {
        reply.send(await getActions(fastify, request));
    });
    next()
};
