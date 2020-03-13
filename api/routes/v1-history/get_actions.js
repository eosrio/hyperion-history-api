const _ = require('lodash');
const prettyjson = require("prettyjson");
const {getCacheByHash, mergeActionMeta} = require("../../helpers/functions");

const maxActions = 500;
const route = '/get_actions';
const terms = ["notified", "act.authorization.actor"];
const extendedActions = new Set(["transfer", "newaccount", "updateauth"]);

const schema = {
    description: 'legacy get actions query',
    summary: 'get actions',
    tags: ['actions', 'history'],
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
                                    action_ordinal: {type: 'number'},
                                    creator_action_ordinal: {type: 'number'},
                                    receipt: {
                                        type: 'object',
                                        properties: {
                                            receiver: {type: 'string'},
                                            global_sequence: {type: 'number'},
                                            recv_sequence: {type: 'number'},
                                            auth_sequence: {
                                                type: 'array',
                                                items: {
                                                    type: 'object',
                                                    properties: {
                                                        account: {type: 'string'},
                                                        sequence: {type: 'number'}
                                                    }
                                                }
                                            }
                                        }
                                    },
                                    receiver: {type: 'string'},
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
    const reqBody = request.body;
    console.log(reqBody);
    const t0 = Date.now();
    const {redis, elastic, eosjs} = fastify;

    const should_array = [];
    for (const entry of terms) {
        const tObj = {term: {}};
        tObj.term[entry] = reqBody.account_name;
        should_array.push(tObj);
    }
    let code, method, pos, offset, parent;
    let sort_direction = 'desc';
    let filterObj = [];
    if (reqBody.filter) {
        const filters = reqBody.filter.split(',');
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
    pos = parseInt(reqBody.pos || 0, 10);
    offset = parseInt(reqBody.offset || 20, 10);
    let from, size;
    from = size = 0;
    if (pos === -1) {
        if (offset < 0) {
            from = 0;
            size = Math.abs(offset);
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

    if (reqBody.sort) {
        if (reqBody.sort === 'asc' || reqBody.sort === '1') {
            sort_direction = 'asc';
        } else if (reqBody.sort === 'desc' || reqBody.sort === '-1') {
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

    if (reqBody.parent !== undefined) {
        const parent = parseInt(reqBody.parent, 10);
        queryStruct.bool['filter'] = [];
        queryStruct.bool['filter'].push({
            "term": {
                "parent": parent
            }
        });
    }

    if (reqBody.account_name) {
        queryStruct.bool.must.push({"bool": {should: should_array}});
    }

    for (const prop in reqBody) {
        if (Object.prototype.hasOwnProperty.call(reqBody, prop)) {
            const actionName = prop.split(".")[0];
            if (prop.split(".").length > 1) {
                if (extendedActions.has(actionName)) {
                    const _termQuery = {};
                    _termQuery["@" + prop] = reqBody[prop];
                    queryStruct.bool.must.push({term: _termQuery});
                } else {
                    const _termQuery = {};
                    _termQuery[prop] = reqBody[prop];
                    queryStruct.bool.must.push({term: _termQuery});
                }
            }
        }
    }

    if (reqBody['after'] || reqBody['before']) {
        let _lte = "now";
        let _gte = 0;
        if (reqBody['before']) _lte = reqBody['before'];
        if (reqBody['after']) _gte = reqBody['after'];
        if (!queryStruct.bool['filter']) queryStruct.bool['filter'] = [];
        queryStruct.bool['filter'].push({
            range: {"@timestamp": {"gte": _gte, "lte": _lte}}
        });
    }
    if (reqBody.filter) {
        queryStruct.bool['should'] = filterObj;
        queryStruct.bool['minimum_should_match'] = 1;
    }
    const esOpts = {
        "index": process.env.CHAIN + '-action-*',
        "from": from || 0,
        "size": (size > maxActions ? maxActions : size),
        "body": {
            "query": queryStruct,
            "sort": {
                "global_sequence": sort_direction
            }
        }
    };
    // console.log(prettyjson.render(esOpts));
    const pResults = await Promise.all([eosjs.rpc.get_info(), elastic['search'](esOpts)]);
    const results = pResults[1];
    const response = {
        actions: [],
        last_irreversible_block: pResults[0].last_irreversible_block_num
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
                    "action_ordinal": action['action_ordinal'],
                    "creator_action_ordinal": action['creator_action_ordinal'],
                    "receipt": {},
                    'receiver': "",
                    "act": {},
                    "trx_id": action.trx_id,
                    "block_num": action.block_num,
                    "block_time": action['@timestamp']
                }
            };
            mergeActionMeta(action);
            act.action_trace.act = action.act;
            act.action_trace.act.hex_data = new Buffer.from(JSON.stringify(action.act.data)).toString('hex');
            if (action.act.account_ram_deltas) {
                act.action_trace.account_ram_deltas = action.account_ram_deltas
            }
            // include receipt
            const receipt = action.receipts[0];
            act.action_trace.receipt = receipt;
            act.action_trace.receiver = receipt.receiver;
            act.account_action_seq = receipt['recv_sequence'];
            response.actions.push(act);
        });
    }
    // console.log(`Response time: ${Date.now() - t0}`);
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.post('/get_actions', {schema}, async (request, reply) => {
        reply.send(await get_actions(fastify, request));
    });
    next();
};
