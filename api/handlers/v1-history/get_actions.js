const _ = require('lodash');
const fetch = require('node-fetch');
const {JsonRpc} = require('eosjs');
const eos_endpoint = process.env.NODEOS_HTTP;
const rpc = new JsonRpc(eos_endpoint, {fetch});
const {getCacheByHash} = require("../../helpers/functions");

const maxActions = 1000;
const route = '/get_actions';
const terms = ["notified", "act.authorization.actor"];
const extendedActions = new Set(["transfer", "newaccount", "updateauth"]);

const schema = {
    description: 'get actions based on notified account. this endpoint also accepts generic filters based on indexed fields' +
        ' (e.g. act.authorization.actor=eosio or act.name=delegatebw), if included they will be combined with a AND operator',
    summary: 'get root actions',
    tags: ['history'],
    body: {
        type: ['object', 'string'],
        properties: {
            "account_name": {
                description: 'notified account',
                type: 'string',
                minLength: 1,
                maxLength: 12
            },
            "pos": {
                description: 'action position (pagination)',
                type: 'integer'
            },
            "offset": {
                description: 'limit of [n] actions per page',
                type: 'integer'
            },
            "filter": {
                description: 'code:name filter',
                type: 'string',
                minLength: 3
            },
            "sort": {
                description: 'sort direction',
                enum: ['desc', 'asc', '1', '-1'],
                type: 'string'
            },
            "after": {
                description: 'filter after specified date (ISO8601)',
                type: 'string',
                format: 'date-time'
            },
            "before": {
                description: 'filter before specified date (ISO8601)',
                type: 'string',
                format: 'date-time'
            },
            "parent": {
                description: 'filter by parent global sequence',
                type: 'integer',
                minimum: 0
            }
        }
    },
    response: {
        200: {
            type: 'object',
            properties: {
                query_time: {type: 'number'},
                last_irreversible_block: {type: 'number'},
                actions: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            account_action_seq: {type: 'number'},
                            global_action_seq: {type: 'number'},
                            block_num: {type: 'number'},
                            block_time: {type: 'string'},
                            action_trace: {
                                type: 'object',
                                properties: {
                                    act: {
                                        type: 'object',
                                        properties: {
                                            account: {type: 'string'},
                                            name: {type: 'string'},
                                            authorization: {
                                                type: 'array',
                                                items: {
                                                    type: 'object',
                                                    additionalProperties: true,
                                                }
                                            },
                                            data: {type: 'object', additionalProperties: true},
                                            hex_data: {type: 'string'}
                                        }
                                    },
                                    trx_id: {type: 'string'},
                                    block_num: {type: 'number'},
                                    block_time: {type: 'string'}
                                }
                            }
                        }
                    }
                }
            }
        }
    }
};


async function get_actions(fastify, request) {
    if (typeof request.body === 'string') {
        request.body = JSON.parse(request.body)
    }
    const t0 = Date.now();
    const {redis, elastic} = fastify;
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
            from = 0;
            size = pos + 1
        } else {
            from = pos;
            size = offset + 1;
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

    if (request.body.parent !== undefined) {
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
    const pResults = await Promise.all([rpc.get_info(), elastic['search']({
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
    const hits = results['body']['hits']['hits'];
    if (hits.length > 0) {
        let actions = hits;
        if (offset < 0) {
            let index;
            if (pos === -1) {
                index = actions.length + offset;
                if (index < 0) {
                    index = 0
                }
            } else if (pos >= 0) {
                index = actions.length + offset - 1;
                if (index < 0) {
                    index = 0
                }
            }
            actions = actions.slice(index);
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
                    "trx_id": action.trx_id,
                    "block_num": action.block_num,
                    "block_time": action['@timestamp']
                }
            };
            const name = action.act.name;
            if (action['@' + name]) {
                action['act']['data'] = _.merge(action['@' + name], action['act']['data']);
                if (name === 'transfer') {
                    action.act.data.quantity = String(action.act.data.amount) + ' ' + action.act.data.symbol;
                    delete action.act.data.amount;
                    delete action.act.data.symbol;
                }
                delete action['@' + name];
            }
            act.action_trace.act = action.act;
            act.action_trace.act.hex_data = new Buffer(JSON.stringify(action.act.data)).toString('hex');
            if (action.act.account_ram_deltas) {
                act.action_trace.account_ram_deltas = action.account_ram_deltas
            }
            response.actions.push(act);
        })
    }
    response['query_time'] = Date.now() - t0;
    redis.set(hash, JSON.stringify(response), 'EX', 30);
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.post('/get_actions', {schema}, async (request) => {
        return await get_actions(fastify, request);
    });
    next();
};
