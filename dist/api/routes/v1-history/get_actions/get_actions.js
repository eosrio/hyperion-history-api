import { mergeActionMeta, timedQuery } from "../../../helpers/functions.js";
import flatstr from 'flatstr';
const terms = ["notified", "act.authorization.actor"];
const extendedActions = new Set(["transfer", "newaccount", "updateauth"]);
async function getActions(fastify, request) {
    if (typeof request.body === 'string') {
        request.body = JSON.parse(request.body);
    }
    const reqBody = request.body;
    const should_array = [];
    for (const entry of terms) {
        const tObj = { term: {} };
        tObj.term[entry] = reqBody.account_name;
        should_array.push(tObj);
    }
    let code, method, pos, offset;
    let sort_direction = 'desc';
    let filterObj = [];
    if (reqBody.filter) {
        const filters = reqBody.filter.split(',');
        for (const filter of filters) {
            const obj = { bool: { must: [] } };
            const parts = filter.split(':');
            if (parts.length === 2) {
                [code, method] = parts;
                if (code && code !== "*") {
                    obj.bool.must.push({ 'term': { 'act.account': code } });
                }
                if (method && method !== "*") {
                    obj.bool.must.push({ 'term': { 'act.name': method } });
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
    }
    else if (pos >= 0) {
        if (offset < 0) {
            from = 0;
            size = pos + 1;
        }
        else {
            from = pos;
            size = offset + 1;
        }
    }
    if (reqBody.sort) {
        if (reqBody.sort === 'asc' || reqBody.sort === '1') {
            sort_direction = 'asc';
        }
        else if (reqBody.sort === 'desc' || reqBody.sort === '-1') {
            sort_direction = 'desc';
        }
        else {
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
        queryStruct.bool.must.push({ "bool": { should: should_array } });
    }
    for (const prop in reqBody) {
        if (Object.prototype.hasOwnProperty.call(reqBody, prop)) {
            const actionName = prop.split(".")[0];
            if (prop.split(".").length > 1) {
                if (extendedActions.has(actionName)) {
                    const _termQuery = {};
                    _termQuery["@" + prop] = reqBody[prop];
                    queryStruct.bool.must.push({ term: _termQuery });
                }
                else {
                    const _termQuery = {};
                    _termQuery[prop] = reqBody[prop];
                    queryStruct.bool.must.push({ term: _termQuery });
                }
            }
        }
    }
    if (reqBody['after'] || reqBody['before']) {
        let _lte = "now";
        let _gte = 0;
        if (reqBody['before'])
            _lte = reqBody['before'];
        if (reqBody['after'])
            _gte = reqBody['after'];
        if (!queryStruct.bool['filter'])
            queryStruct.bool['filter'] = [];
        queryStruct.bool['filter'].push({
            range: { "@timestamp": { "gte": _gte, "lte": _lte } }
        });
    }
    if (reqBody.filter) {
        queryStruct.bool['should'] = filterObj;
        queryStruct.bool['minimum_should_match'] = 1;
    }
    const getActionsLimit = fastify.manager.config.api.limits.get_actions;
    const esOpts = {
        "index": fastify.manager.chain + '-action-*',
        "from": from || 0,
        "size": (getActionsLimit && (size > getActionsLimit) ? getActionsLimit : size),
        "body": {
            "query": queryStruct,
            "sort": {
                "global_sequence": sort_direction
            }
        }
    };
    const pResults = await Promise.all([fastify.eosjs.rpc.get_info(), fastify.elastic['search'](esOpts)]);
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
                    index = 0;
                }
            }
            else if (pos >= 0) {
                index = actions.length + offset - 1;
                if (index < 0) {
                    index = 0;
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
            act.action_trace.act.hex_data = Buffer.from(flatstr(JSON.stringify(action.act.data))).toString('hex');
            if (action.act.account_ram_deltas) {
                act.action_trace.account_ram_deltas = action.account_ram_deltas;
            }
            // include receipt
            const receipt = action.receipts[0];
            act.action_trace.receipt = receipt;
            act.action_trace.receiver = receipt.receiver;
            act.account_action_seq = receipt['recv_sequence'];
            response.actions.push(act);
        });
    }
    return response;
}
export function getActionsHandler(fastify, route) {
    return async (request, reply) => {
        reply.send(await timedQuery(getActions, fastify, request, route));
    };
}
