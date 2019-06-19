const {getTransfersSchema} = require("../../schemas");
const _ = require('lodash');
const {getCacheByHash} = require("../../helpers/functions");
const route = '/get_transfers';

const maxActions = 1000;

function processActions(results) {
    const action_traces = results['body']['hits']['hits'];
    const actions = [];
    let sum = 0;
    for (const aTrace of action_traces) {
        const action = aTrace['_source'];
        const name = action.act.name;
        if (action['@' + name]) {
            if (action['@transfer']) {
                sum += parseFloat(action['@transfer']['amount']);
            }
            action['act']['data'] = _.merge(action['@' + name], action['act']['data']);
            delete action['@' + name];
        }
        actions.push(action);
    }
    return [sum, actions];
}

async function getTransfers(fastify, request) {
    const {redis, elastic} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, route + JSON.stringify(request.query));
    if (cachedResponse) {
        return cachedResponse;
    }
    const must_array = [];
    must_array.push({"term": {"act.name": {"value": "transfer"}}});
    if (request.query['from']) {
        must_array.push({"term": {"@transfer.from": {"value": request.query['from'].toLowerCase()}}});
    }
    if (request.query['to']) {
        must_array.push({"term": {"@transfer.to": {"value": request.query['to'].toLowerCase()}}});
    }
    if (request.query['symbol']) {
        must_array.push({"term": {"@transfer.symbol": {"value": request.query['symbol'].toUpperCase()}}});
    }
    if (request.query['contract']) {
        must_array.push({"term": {"act.account": {"value": request.query['contract'].toLowerCase()}}});
    }
    if (request.query['after'] || request.query['before']) {
        let _lte = "now";
        let _gte = 0;
        if (request.query['before']) {
            _lte = request.query['before'];
        }
        if (request.query['after']) {
            _gte = request.query['after'];
        }
        must_array.push({
            range: {
                "@timestamp": {
                    "gte": _gte,
                    "lte": _lte
                }
            }
        });
    }
    let limit, skip;
    limit = parseInt(request.query.limit, 10);
    if (limit < 1) {
        return 'invalid limit parameter';
    }
    skip = parseInt(request.query.skip, 10);
    if (skip < 0) {
        return 'invalid skip parameter';
    }
    const body = {"query": {"bool": {"must": must_array}}};
    const results = await elastic.search({
        "index": process.env.CHAIN + '-action-*',
        "from": skip || 0,
        "size": (limit > maxActions ? maxActions : limit) || 10,
        "body": body
    });
    const [sum, _actions] = processActions(results);
    const response = {
        "action_count": results['body']['hits']['total']['value'],
        "total_amount": sum,
        "actions": _actions
    };
    redis.set(hash, JSON.stringify(response), 'EX', 30);
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get(route, {
        schema: getTransfersSchema.GET
    }, async (request, reply) => {
        reply.send(await getTransfers(fastify, request));
    });
    next()
};
