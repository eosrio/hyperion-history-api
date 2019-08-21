const {getActionsV1Schema} = require("../../schemas");
const {getCacheByHash} = require("../../helpers/functions");
const _ = require('lodash');
const fetch = require('node-fetch');
const {JsonRpc} = require('eosjs');
const eos_endpoint = process.env.NODEOS_HTTP;
const rpc = new JsonRpc(eos_endpoint, {fetch});

const maxActions = 1000;
const route = '/get_actions';
const terms = ["notified", "act.authorization.actor"];
const extendedActions = new Set(["transfer", "newaccount", "updateauth"]);

async function getActions(fastify, request) {
    if (typeof request.body === 'string') {
        request.body = JSON.parse(request.body)
    }
    const t0 = Date.now();
    const {redis, elasticsearch} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, route + JSON.stringify(request.body));
    if (cachedResponse) {
        return cachedResponse;
    }
    const should_array = [];
    for (const entry of terms) {
        const tObj = {term: {}};
        tObj.term[entry] = request.body.account_name;
        should_array.push(tObj);
    }
    let code, method, pos, offset, parent;
    let sort_direction = 'asc';
    let filterObj = [];
    if (request.body.filter) {
        const filters = request.body.filter.split(',');
        for (const filter of filters) {
            const obj = {bool: {must: []}};
            const parts = filter.split(':');
            if (parts.length === 2) {
                [code, method] = parts;
                if (code && code !== "*") {
                    obj.bool.must.push({'term': {'act.account': code}});
                }
                if (method && method !== "*") {
                    obj.bool.must.push({'term': {'act.name': method}});
                }
            }
            filterObj.push(obj);
        }
    }
    pos = parseInt(request.body.pos || 0, 10);
    offset = parseInt(request.body.offset || maxActions, 10);
    let from, size;
    from = size = 0;
    if (pos === -1) {
        if (offset < 0) {
            from = 0;
            size = maxActions;
        }
    } else if (pos >= 0) {
        if (offset < 0) {
            from = 0
            size = pos + 1
        } else  {
            from = pos;
            size = offset+1;
        }
    }

    if (request.body.sort) {
        if (request.body.sort === 'asc' || request.body.sort === '1') {
            sort_direction = 'asc';
        } else if (request.body.sort === 'desc' || request.body.sort === '-1') {
            sort_direction = 'desc'
        } else {
            return 'invalid sort direction';
        }
    }

    const queryStruct = {
        "bool": {
            must: [],
            boost: 1.0
        }
    };

    if(request.body.parent !== undefined) {
        queryStruct.bool['filter'] = [];
        queryStruct.bool['filter'].push({
            "term": {
                "parent": parseInt(request.body.parent, 10)
            }
        });
    }

    if (request.body.account_name) {
        queryStruct.bool.must.push({"bool": {should: should_array}});
    }

    for (const prop in request.body) {
        if (Object.prototype.hasOwnProperty.call(request.body, prop)) {
            const actionName = prop.split(".")[0];
            if (prop.split(".").length > 1) {
                if (extendedActions.has(actionName)) {
                    // console.log(prop + " = " + request.body[prop]);
                    const _termQuery = {};
                    _termQuery["@" + prop] = request.body[prop];
                    queryStruct.bool.must.push({term: _termQuery});
                } else {
                    const _termQuery = {};
                    _termQuery[prop] = request.body[prop];
                    queryStruct.bool.must.push({term: _termQuery});
                }
            }
        }
    }

    if (request.body['after'] || request.body['before']) {
        let _lte = "now";
        let _gte = 0;
        if (request.body['before']) {
            _lte = request.body['before'];
        }
        if (request.body['after']) {
            _gte = request.body['after'];
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

    if (request.body.filter) {
        queryStruct.bool['should'] = filterObj;
        queryStruct.bool['minimum_should_match'] = 1;
    }
    console.log(from + ' ' + size)
    const pResults = await Promise.all([rpc.get_info(), elasticsearch['search']({
        "index": process.env.CHAIN + '-action-*',
        "from": from || 0,
        "size": (size > maxActions ? maxActions : size),
        "body": {
            "track_total_hits": 10000,
            "query": queryStruct,
            "sort": {
                "global_sequence": sort_direction
            }
        }
    })]);
    const results = pResults[1];
    const response = {
        last_irreversible_block: pResults[0].last_irreversible_block_num,
        actions: []
    };
    if (results['hits']['hits'].length > 0) {
        let actions = results['hits']['hits'];
        if (offset < 0) {
            let index
            if (pos === -1) {
                index = actions.length + offset
                if (index < 0) {
                    index = 0
                }
            } else if (pos >= 0) {
                index = actions.length + offset -1
                if (index < 0) {
                    index = 0
                }
            }
            console.log(actions)
            actions = actions.slice(index)
            console.log(actions)
        }
        actions.forEach((action, index) => {
            action = action._source;
            let act = {
                "global_action_seq": action.global_sequence,
                "account_action_seq": index,
                "block_num": action.block_num,
                "block_time": action['@timestamp'],
                "action_trace": {
                    "receipt": {},
                    "act": {},
                    "elapsed": 0,
                    "console": "",
                    "context_free": false,
                    "trx_id": action.trx_id,
                    "block_num": action.block_num,
                    "block_time": action['@timestamp'],
                    "producer_block_id": "",
                    "account_ram_deltas": [],
                    "except": null,
                    "inline_traces": []
                }
            }
            const name = action.act.name;
            if (action['@' + name]) {
                action['act']['data'] = _.merge(action['@' + name], action['act']['data']);
                if (name === 'transfer') {
                    action.act.data.quantity = String(action.act.data.amount) + ' ' + action.act.data.symbol
                    delete action.act.data.amount
                    delete action.act.data.symbol
                }
                delete action['@' + name];
            }
            act.action_trace.act = action.act
            act.action_trace.act.hex_data = new Buffer(JSON.stringify(action.act.data)).toString('hex')
            if (action.act.account_ram_deltas) {
                act.action_trace.account_ram_deltas = action.account_ram_deltas
            }
            response.actions.push(act);
        })
    }
    // response['query_time'] = Date.now() - t0;
    redis.set(hash, JSON.stringify(response), 'EX', 30);
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.post('/get_actions', {
        schema: getActionsV1Schema.POST
    }, async (request) => {
        return await getActions(fastify, request);
    });
    next()
};
