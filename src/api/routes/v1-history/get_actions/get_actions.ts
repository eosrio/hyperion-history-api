import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {mergeActionMeta, timedQuery} from "../../../helpers/functions.js";
import {Serialize} from "eosjs";
import {hLog} from "../../../../indexer/helpers/common_functions.js";
import {Abieos} from "@eosrio/node-abieos";
import {JsonRpc} from "eosjs/dist";
import {terms} from "../../v2-history/get_actions/definitions.js";
import {Client, estypes} from "@elastic/elasticsearch";

const abi_remapping = {
    "_Bool": "bool"
};

const txEnc = new TextEncoder();
const txDec = new TextDecoder();

async function fetchAbiHexAtBlockElastic(client: Client, chain, contract_name, last_block, get_json) {
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
            return results[0]._source;
        } else {
            return null;
        }
    } catch (e) {
        hLog(e);
        return null;
    }
}

async function getAbiFromHeadBlock(rpc: JsonRpc, code) {
    let _abi;
    try {
        _abi = (await rpc.get_abi(code)).abi;
    } catch (e) {
        hLog(e);
    }
    return {abi: _abi, valid_until: null, valid_from: null};
}

async function getContractAtBlock(esClient: Client, rpc: JsonRpc, chain: string, accountName: string, block_num: number, check_action?: string) {
    let savedAbi, abi;
    savedAbi = await fetchAbiHexAtBlockElastic(esClient, chain, accountName, block_num, true);
    if (savedAbi === null || (savedAbi.actions && !savedAbi.actions.includes(check_action))) {
        savedAbi = await getAbiFromHeadBlock(rpc, accountName);
        if (!savedAbi) return [null, null];
        abi = savedAbi.abi;
    } else {
        try {
            abi = JSON.parse(savedAbi.abi);
        } catch (e) {
            hLog(e);
            return [null, null];
        }
    }
    if (!abi) return [null, null];
    const initialTypes = Serialize.createInitialTypes();
    let types;
    try {
        types = Serialize.getTypesFromAbi(initialTypes, abi);
    } catch (e) {
        let remapped = false;
        for (const struct of abi.structs) {
            for (const field of struct.fields) {
                if (abi_remapping[field.type]) {
                    field.type = abi_remapping[field.type];
                    remapped = true;
                }
            }
        }
        if (remapped) {
            try {
                types = Serialize.getTypesFromAbi(initialTypes, abi);
            } catch (e) {
                hLog('failed after remapping abi');
                hLog(accountName, block_num, check_action);
                hLog(e);
            }
        } else {
            hLog(accountName, block_num);
            hLog(e);
        }
    }
    const actions = new Map();
    for (const {name, type} of abi.actions) {
        actions.set(name, Serialize.getType(types, type));
    }
    const result = {types, actions, tables: abi.tables};
    if (check_action) {
        if (actions.has(check_action)) {
            try {
                const abieos = Abieos.getInstance();
                abieos.loadAbi(accountName, JSON.stringify(abi));
            } catch (e) {
                hLog(e);
            }
        }
    }
    return [result, abi];
}


const extendedActions = new Set(["transfer", "newaccount", "updateauth"]);

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

    // console.log(JSON.stringify(esOpts, null, 2));

    const pResults = await Promise.all([fastify.eosjs.rpc.get_info(), fastify.elastic.search<any>(esOpts)]);
    const results = pResults[1];
    const response: any = {
        actions: [],
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
