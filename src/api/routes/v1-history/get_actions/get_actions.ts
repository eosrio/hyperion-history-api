import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {mergeActionMeta, timedQuery} from "../../../helpers/functions.js";
import {hLog} from "../../../../indexer/helpers/common_functions.js";
import {Abieos} from "@eosrio/node-abieos";
import {terms} from "../../v2-history/get_actions/definitions.js";
import {Client, estypes} from "@elastic/elasticsearch";
import {ABI, Serializer} from "@wharfkit/antelope";
import {SavedAbi} from "../../../../interfaces/hyperion-abi.js";
import {ActionTrace} from "../../../../interfaces/action-trace.js";

const abieos = Abieos.getInstance();

async function fetchSavedAbiAtBlock(
    client: Client,
    chain: string,
    contract_name: string,
    last_block: number,
    get_json: boolean
): Promise<SavedAbi | undefined> {
    try {
        const _includes = ["actions", "tables", "block"];
        if (get_json) {
            _includes.push("abi");
        } else {
            _includes.push("abi_hex");
        }
        const query = {
            bool: {
                must: [
                    {term: {account: contract_name}},
                    {range: {block: {lte: last_block}}}
                ]
            }
        };
        const queryResult = await client.search<any>({
            index: `${chain}-abi-*`,
            size: 1, query,
            sort: [{block: {order: "desc"}}],
            _source: {includes: _includes}
        });
        const results = queryResult.hits.hits;
        if (results.length > 0) {
            const nextRefResponse: estypes.SearchResponse<any, any> = await client.search({
                index: `${chain}-abi-*`,
                size: 1,
                query: {
                    bool: {
                        must: [
                            {term: {account: contract_name}},
                            {range: {block: {gte: last_block}}}
                        ]
                    }
                },
                sort: [{block: {order: "asc"}}],
                _source: {includes: ["block"]}
            });
            const nextRef = nextRefResponse.hits.hits;
            if (nextRef.length > 0) {
                return {
                    valid_until: nextRef[0]._source.block,
                    ...results[0]._source
                };
            }
            return {
                ...results[0]._source,
                abi: ABI.fromABI(results[0]._source.abi_hex),
            } as SavedAbi;
        }
    } catch (e) {
        hLog(e);
    }
}

const extendedActions = new Set(["transfer", "newaccount", "updateauth"]);

async function encodeActionData(fastify: FastifyInstance, action: ActionTrace) {
    try {
        let savedAbiData = await fetchSavedAbiAtBlock(fastify.elastic, fastify.manager.chain, action.act.account, action.block_num, true);
        if (!savedAbiData) {
            savedAbiData = await fastify.antelope.getAbi(action.act.account);
        }
        if (savedAbiData) {
            let actionType: string | undefined;

            try {
                actionType = abieos.getTypeForAction(action.act.account, action.act.name);
            } catch (e: any) {
                console.log('failed to get action type');
                console.log(e.message);
            }

            if (!actionType || actionType === 'NO_CONTEXT') {
                const loaded = abieos.loadAbi(action.act.account, savedAbiData.abi);
                if (!loaded) {
                    console.log('failed to load abi');
                    return;
                }
                actionType = abieos.getTypeForAction(action.act.account, action.act.name);
                if (!actionType) {
                    console.log('failed to get action type after abi loaded');
                    return;
                }
            }
            if (!actionType) {
                console.log('failed to get action type after contract loaded');
                return;
            }
            // remove fields that are not in the abi
            const abiType = savedAbiData.abi.structs.find(value => value.name === actionType);
            const actionData = {};
            if (abiType) {
                for (const field of abiType.fields) {
                    actionData[field.name] = action.act.data[field.name];
                }
            } else {
                console.log('failed to find abi type');
            }

            try {
                const data = abieos.jsonToHex(action.act.account, actionType, actionData).toLowerCase();
                action.act.hex_encoder = 'abieos';
                return data.toLowerCase();
            } catch (e: any) {
                console.log('failed to convert json to hex with abieos');
                console.log(e.message);
            }

            try {
                const data = Serializer.encode({
                    object: action.act.data,
                    abi: savedAbiData.abi,
                    type: actionType
                }).hexString;
                action.act.hex_encoder = 'antelope';
                return data.toLowerCase();
            } catch (e: any) {
                console.log('failed to encode with Antelope Serializer');
                console.log(e.message);
            }
        }
    } catch (e: any) {
        console.log(e);
    }
}

async function getActions(fastify: FastifyInstance, request: FastifyRequest) {

    if (typeof request.body === 'string') {
        request.body = JSON.parse(request.body);
    }

    const reqBody = request.body as any;
    const should_array: any = [];
    for (const entry of terms) {
        const tObj = {term: {}};
        tObj.term[entry] = reqBody.account_name;
        should_array.push(tObj);
    }
    let code, method, pos, offset;
    let sort_direction = 'desc';
    let filterObj: any = [];
    if (reqBody.filter) {
        const filters = reqBody.filter.split(',');
        for (const filter of filters) {
            const obj: any = {bool: {must: []}};
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
    let from = 0;
    let size = 0;
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

    const queryStruct: any = {
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

    const getActionsLimit = fastify.manager.config.api.limits.get_actions ?? 1000;

    const esOpts = {
        "index": fastify.manager.chain + '-action-*',
        "from": from || 0,
        "size": (size > getActionsLimit ? getActionsLimit : size),
        "query": queryStruct,
        "sort": {
            "global_sequence": sort_direction
        }
    };

    const pResults = await Promise.all([
        fastify.antelope.chain.get_info(),
        fastify.elastic.search<any>(esOpts)
    ]);
    const results = pResults[1];
    const response: any = {
        actions: [],
        last_irreversible_block: pResults[0].last_irreversible_block_num.toNumber()
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
            let action = actions[i] as any;
            action = action._source;
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
                action.act.hex_data = await encodeActionData(fastify, action);
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
