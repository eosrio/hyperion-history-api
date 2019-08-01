const {getTransactionV1Schema} = require("../../schemas");
const _ = require('lodash');
const {getCacheByHash} = require("../../helpers/functions");
const fetch = require('node-fetch');
const {JsonRpc} = require('eosjs');
const eos_endpoint = process.env.NODEOS_HTTP;
const rpc = new JsonRpc(eos_endpoint, {fetch});

async function getTransaction(fastify, request) {
    const {redis, elastic} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(request.query));
    if (cachedResponse) {
        return cachedResponse;
    }
    const pResults = await Promise.all([rpc.get_info(), elastic['search']({
        "index": process.env.CHAIN + '-action-*',
        "body": {
            "query": {
                "bool": {
                    must: [
                        {term: {"trx_id": request.body.id.toLowerCase()}}
                    ]
                }
            },
            "sort": {
                "global_sequence": "asc"
            }
        }
    })]);
    const results = pResults[1];
    const response = {
        "id": request.query.id,
        "trx": {
            "receipt": {
                "status": "",
                "cpu_usage_us": "",
                "net_usage_words": "",
                "trx": []
            },
            "trx": {}
        },
        "block_num": 0,
        "block_time": "",
        "last_irreversible_block": pResults[0].last_irreversible_block_num,
        "traces": []
    };
    
    if (results['body']['hits']['hits'].length > 0) {
        const actions = results['body']['hits']['hits'];
        response.trx.trx = {
            "expiration": "",
            "ref_block_num": 0,
            "ref_block_prefix": 0,
            "max_net_usage_words": 0,
            "max_cpu_usage_ms": 0,
            "delay_sec": 0,
            "context_free_actions": [],
            "actions": [],
            "transaction_extensions": [],
            "signatures": [],
            "context_free_data": []
        }
        let traces = {}
        for (let action of actions) {
            action = action._source;
            const name = action.act.name;
            if (action['@' + name]) {
                action['act']['data'] = _.merge(action['@' + name], action['act']['data']);
                delete action['@' + name];
            }
            action.act['hex_data'] = ''
            if (action.parent === 0) {
                response.trx.trx.actions.push(action.act);
            }
            response.block_num = action.block_num
            response.block_time = action['@timestamp']

            let trace = {
                account_ram_deltas: [],
                act: action.act,
                block_num: action.block_num,
                block_time: action['@timestamp'],
                console: "",
                context_free: false,
                elapsed: 146,
                except: null,
                inline_traces: [],
                producer_block_id: "",
                receipt: {
                    receiver: action.act.account
                },
                trx_id: request.query.id,
                notified: action.notified
            }
            traces[action.global_sequence] = trace
        }
        actions.forEach(action => {
            action = action._source
            if (action.parent === 0) {
                response.traces.push(traces[action.global_sequence])
            } else {
                for(let i = 0; i < traces[action.parent].notified.length; i++) {
                    if (traces[action.parent].notified[i] === action.act.account) {
                        traces[action.parent].notified.splice()
                    }
                }
                traces[action.parent].inline_traces.push(traces[action.global_sequence])
            }
        })

    }
    redis.set(hash, JSON.stringify(response), 'EX', 30);
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.post('/get_transaction', {
        schema: getTransactionV1Schema.POST
    }, async (request, reply) => {
        reply.send(await getTransaction(fastify, request));
    });
    next()
};
