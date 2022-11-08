import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {mergeActionMeta, pushBoolElement, timedQuery} from "../../../helpers/functions.js";
import {HyperionAction} from "../../../../interfaces/hyperion-action.js";
import {Serialize} from "enf-eosjs";
import {getContractAtBlock} from "../../../../helpers/common_functions.js";
import {estypes} from "@elastic/elasticsearch";

const terms = ["notified", "act.authorization.actor"];
const extendedActions = new Set(["transfer", "newaccount", "updateauth"]);

const txEnc = new TextEncoder();
const txDec = new TextDecoder();

async function getActions(fastify: FastifyInstance, request: FastifyRequest) {

    if (typeof request.body === 'string') {
        request.body = JSON.parse(request.body);
    }

    const reqBody = request.body as any;
    const should_array = [] as any[];
    for (const entry of terms) {
        const tObj: any = {term: {}};
        tObj.term[entry] = reqBody.account_name;
        should_array.push(tObj);
    }
    let code, method, pos, offset;
    let sort_direction = 'desc';
    let filterObj: any[] = [];
    if (reqBody.filter) {
        const filters = reqBody.filter.split(',');
        for (const filter of filters) {
            const obj = {bool: {must: [] as any[]}};
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

    const queryStruct: estypes.QueryDslQueryContainer = {
        bool: {
            must: [] as any,
            boost: 1.0
        }
    };

    if (reqBody.parent !== undefined) {
        const parent = parseInt(reqBody.parent, 10);
        if (queryStruct.bool) {
            queryStruct.bool.filter = [{term: {parent: parent}}];
        }
    }

    if (reqBody.account_name) {
        pushBoolElement(queryStruct, 'must', {bool: {should: should_array}});
    }

    for (const prop in reqBody) {
        if (Object.prototype.hasOwnProperty.call(reqBody, prop)) {
            const actionName = prop.split(".")[0];
            if (prop.split(".").length > 1) {
                const _termQuery: Record<string, any> = {};
                if (extendedActions.has(actionName)) {
                    _termQuery["@" + prop] = reqBody[prop];
                } else {
                    _termQuery[prop] = reqBody[prop];
                }
                pushBoolElement(queryStruct, "must", {term: _termQuery});
            }
        }
    }

    if (reqBody['after'] || reqBody['before']) {
        let _lte = "now";
        let _gte = 0;
        if (reqBody['before']) _lte = reqBody['before'];
        if (reqBody['after']) _gte = reqBody['after'];

        pushBoolElement(queryStruct, 'filter', {
            range: {
                "@timestamp": {
                    gte: _gte,
                    lte: _lte
                }
            }
        });
    }
    if (reqBody.filter && queryStruct.bool) {
        queryStruct.bool.should = filterObj;
        queryStruct.bool.minimum_should_match = 1;
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
        actions: [] as any[],
        last_irreversible_block: pResults[0].last_irreversible_block_num
    };
    const hits = results.hits.hits;
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

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i]._source as HyperionAction;
            let act: any = {
                "global_action_seq": action.global_sequence,
                "account_action_seq": i,
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

            if (reqBody.hex_data) {
                try {
                    const [contract, _] = await getContractAtBlock(
                        fastify.elastic,
                        fastify.eosjs.rpc,
                        fastify.manager.chain,
                        action.act.account,
                        action.block_num
                    );
                    action.act.hex_data = Serialize.serializeActionData(
                        contract,
                        action.act.account,
                        action.act.name,
                        action.act.data,
                        txEnc,
                        txDec
                    );
                } catch (e: any) {
                    console.log(e);
                }
            }

            if (action.act.account_ram_deltas) {
                act.action_trace.account_ram_deltas = action.account_ram_deltas
            }
            // include receipt
            const receipt = action.receipts[0];
            act.action_trace.receipt = receipt;
            act.action_trace.receiver = receipt.receiver;
            act.account_action_seq = receipt['recv_sequence'];
            response.actions.push(act);
        }
    }
    return response;
}

export function getActionsHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getActions, fastify, request, route));
    }
}
