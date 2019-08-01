const {getTransactionV1Schema} = require("../../schemas");
const _ = require('lodash');
const {getCacheByHash} = require("../../helpers/functions");
const fetch = require('node-fetch');
const {JsonRpc} = require('eosjs');
const eos_endpoint = process.env.NODEOS_HTTP;
const rpc = new JsonRpc(eos_endpoint, {fetch});

async function getTransaction(fastify, request) {
    if (typeof request.body === 'string') {
        request.body = JSON.parse(request.body)
    }
    const {redis, elasticsearch} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(request.body));
    if (cachedResponse) {
        return cachedResponse;
    }
    const pResults = await Promise.all([rpc.get_info(), elasticsearch['search']({
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
        "id": request.body.id,
        "trx": {
            "receipt": {
                "status": "executed",
                "cpu_usage_us": 0,
                "net_usage_words": 0,
                "trx": []
            },
            "trx": {}
        },
        "block_num": 0,
        "block_time": "",
        "last_irreversible_block": pResults[0].last_irreversible_block_num,
        "traces": []
    };
    
    if (results['hits']['hits'].length > 0) {
        const actions = results['hits']['hits'];
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
        let seqNum = 0
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
            seqNum+=10
            let trace = {
                receipt: {
                    receiver: action.act.account,
                    global_sequence: action.global_sequence,
                    auth_sequence: [
                        action.act.authorization[0].actor,
                        seqNum
                    ]
                },
                act: action.act,
                account_ram_deltas: action.account_ram_deltas || [],
                context_free: false,
                block_num: action.block_num,
                block_time: action['@timestamp'],
                console: "",
                elapsed: 0,
                except: null,
                inline_traces: [],
                producer_block_id: "",
                trx_id: request.body.id,
                notified: action.notified
            }
            traces[action.global_sequence] = trace
        }
        actions.forEach(action => {
            action = action._source
            for(let i = 0; i < traces[action.global_sequence].notified.length; i++) {
                    if (traces[action.global_sequence].notified[i] === action.act.account) {
                        traces[action.global_sequence].notified.splice(i, 1)
                        break
                    }
                }
            if (action.parent !== 0) {
                for(let i = 0; i < traces[action.parent].notified.length; i++) {
                    if (traces[action.parent].notified[i] === action.act.account) {
                        traces[action.parent].notified.splice(i, 1)
                        break
                    }
                }
                traces[action.parent].inline_traces.push(traces[action.global_sequence])
            } else {
                // response.traces.push(traces[action.global_sequence])
            }
        })
        actions.forEach(action => {
            action = action._source
            response.traces.push(traces[action.global_sequence])
            traces[action.global_sequence].notified.forEach((note,index) => {
                seqNum +=10
                let trace = {
                    receipt: {
                        receiver: note,
                        global_sequence: action.global_sequence + index + 1,
                        auth_sequence: [
                            action.act.authorization[0].actor,
                            seqNum
                        ]
                    },
                    account_ram_deltas: action.account_ram_deltas || [],
                    act: action.act,
                    block_num: action.block_num,
                    block_time: action['@timestamp'],
                    console: "",
                    context_free: false,
                    elapsed: 0,
                    except: null,
                    inline_traces: [],
                    producer_block_id: "",
                    trx_id: request.body.id,
                }
                traces[action.global_sequence].inline_traces.unshift(trace)
                response.traces.push(trace)
            })
            delete traces[action.global_sequence].notified
        })
        redis.set(hash, JSON.stringify(response), 'EX', 30);
    }
    return { "id":"3f08319c2f60393a5e91a05ec2ca1ab361982a0ce71d85819318138e79f18559","trx":{"receipt":{"status":"executed","cpu_usage_us":308,"net_usage_words":23,"trx":[1,{"signatures":["SIG_K1_KaKtEetfFpGFyrPtY2R5pUtvUyxscbXawV1hxtZzWU5PBfpvkgKrqFASusTAxRD9v4gsrNYWCpHHEb4cR3c2bHYn74TgWQ"],"compression":"none","packed_context_free_data":"","packed_trx":"ebaf425d304349fb37230000000001301d4519537a2852000000572d3ccdcd01a0d4cdaae549194d00000000a8ed32325ba0d4cdaae549194d1082a7c7e8c6a6eb010000000000000004454300000000003a7b2274696d65223a313536343635313430393136322c2274797065223a322c226d7367223a22222c226964223a323135392c226963223a22227d00"}]},"trx":{"expiration":"2019-08-01T09:24:59","ref_block_num":17200,"ref_block_prefix":590871369,"max_net_usage_words":0,"max_cpu_usage_ms":0,"delay_sec":0,"context_free_actions":[],"actions":[{"account":"ecoboostcoin","name":"transfer","authorization":[{"actor":"dogonthetree","permission":"active"}],"data":{"from":"dogonthetree","to":"xinghuaboy11","quantity":"0.0001 EC","memo":"{\"time\":1564651409162,\"type\":2,\"msg\":\"\",\"id\":2159,\"ic\":\"\"}"},"hex_data":"a0d4cdaae549194d1082a7c7e8c6a6eb010000000000000004454300000000003a7b2274696d65223a313536343635313430393136322c2274797065223a322c226d7367223a22222c226964223a323135392c226963223a22227d"}],"transaction_extensions":[],"signatures":["SIG_K1_KaKtEetfFpGFyrPtY2R5pUtvUyxscbXawV1hxtZzWU5PBfpvkgKrqFASusTAxRD9v4gsrNYWCpHHEb4cR3c2bHYn74TgWQ"],"context_free_data":[]}},"block_time":"2019-08-01T09:23:30.500","block_num":33834114,"last_irreversible_block":33833812,"traces":[{"receipt":{"receiver":"ecoboostcoin","act_digest":"1f64b101694d7497aeb47f6da71e21ee1d450162d54c55d84ef83749f58863d3","global_sequence":122016731,"recv_sequence":110,"auth_sequence":[["dogonthetree",295]],"code_sequence":1,"abi_sequence":1},"act":{"account":"ecoboostcoin","name":"transfer","authorization":[{"actor":"dogonthetree","permission":"active"}],"data":{"from":"dogonthetree","to":"xinghuaboy11","quantity":"0.0001 EC","memo":"{\"time\":1564651409162,\"type\":2,\"msg\":\"\",\"id\":2159,\"ic\":\"\"}"},"hex_data":"a0d4cdaae549194d1082a7c7e8c6a6eb010000000000000004454300000000003a7b2274696d65223a313536343635313430393136322c2274797065223a322c226d7367223a22222c226964223a323135392c226963223a22227d"},"context_free":false,"elapsed":129,"console":"","trx_id":"3f08319c2f60393a5e91a05ec2ca1ab361982a0ce71d85819318138e79f18559","block_num":33834114,"block_time":"2019-08-01T09:23:30.500","producer_block_id":"02044482022d4a4e54f59410ba045724ae9d76a8a311de37761c34e253bab387","account_ram_deltas":[],"except":null,"inline_traces":[{"receipt":{"receiver":"dogonthetree","act_digest":"1f64b101694d7497aeb47f6da71e21ee1d450162d54c55d84ef83749f58863d3","global_sequence":122016732,"recv_sequence":171,"auth_sequence":[["dogonthetree",296]],"code_sequence":1,"abi_sequence":1},"act":{"account":"ecoboostcoin","name":"transfer","authorization":[{"actor":"dogonthetree","permission":"active"}],"data":{"from":"dogonthetree","to":"xinghuaboy11","quantity":"0.0001 EC","memo":"{\"time\":1564651409162,\"type\":2,\"msg\":\"\",\"id\":2159,\"ic\":\"\"}"},"hex_data":"a0d4cdaae549194d1082a7c7e8c6a6eb010000000000000004454300000000003a7b2274696d65223a313536343635313430393136322c2274797065223a322c226d7367223a22222c226964223a323135392c226963223a22227d"},"context_free":false,"elapsed":6,"console":"","trx_id":"3f08319c2f60393a5e91a05ec2ca1ab361982a0ce71d85819318138e79f18559","block_num":33834114,"block_time":"2019-08-01T09:23:30.500","producer_block_id":"02044482022d4a4e54f59410ba045724ae9d76a8a311de37761c34e253bab387","account_ram_deltas":[],"except":null,"inline_traces":[]},{"receipt":{"receiver":"xinghuaboy11","act_digest":"1f64b101694d7497aeb47f6da71e21ee1d450162d54c55d84ef83749f58863d3","global_sequence":122016733,"recv_sequence":1850,"auth_sequence":[["dogonthetree",297]],"code_sequence":1,"abi_sequence":1},"act":{"account":"ecoboostcoin","name":"transfer","authorization":[{"actor":"dogonthetree","permission":"active"}],"data":{"from":"dogonthetree","to":"xinghuaboy11","quantity":"0.0001 EC","memo":"{\"time\":1564651409162,\"type\":2,\"msg\":\"\",\"id\":2159,\"ic\":\"\"}"},"hex_data":"a0d4cdaae549194d1082a7c7e8c6a6eb010000000000000004454300000000003a7b2274696d65223a313536343635313430393136322c2274797065223a322c226d7367223a22222c226964223a323135392c226963223a22227d"},"context_free":false,"elapsed":6,"console":"","trx_id":"3f08319c2f60393a5e91a05ec2ca1ab361982a0ce71d85819318138e79f18559","block_num":33834114,"block_time":"2019-08-01T09:23:30.500","producer_block_id":"02044482022d4a4e54f59410ba045724ae9d76a8a311de37761c34e253bab387","account_ram_deltas":[],"except":null,"inline_traces":[]}]},{"receipt":{"receiver":"dogonthetree","act_digest":"1f64b101694d7497aeb47f6da71e21ee1d450162d54c55d84ef83749f58863d3","global_sequence":122016732,"recv_sequence":171,"auth_sequence":[["dogonthetree",296]],"code_sequence":1,"abi_sequence":1},"act":{"account":"ecoboostcoin","name":"transfer","authorization":[{"actor":"dogonthetree","permission":"active"}],"data":{"from":"dogonthetree","to":"xinghuaboy11","quantity":"0.0001 EC","memo":"{\"time\":1564651409162,\"type\":2,\"msg\":\"\",\"id\":2159,\"ic\":\"\"}"},"hex_data":"a0d4cdaae549194d1082a7c7e8c6a6eb010000000000000004454300000000003a7b2274696d65223a313536343635313430393136322c2274797065223a322c226d7367223a22222c226964223a323135392c226963223a22227d"},"context_free":false,"elapsed":6,"console":"","trx_id":"3f08319c2f60393a5e91a05ec2ca1ab361982a0ce71d85819318138e79f18559","block_num":33834114,"block_time":"2019-08-01T09:23:30.500","producer_block_id":"02044482022d4a4e54f59410ba045724ae9d76a8a311de37761c34e253bab387","account_ram_deltas":[],"except":null,"inline_traces":[]},{"receipt":{"receiver":"xinghuaboy11","act_digest":"1f64b101694d7497aeb47f6da71e21ee1d450162d54c55d84ef83749f58863d3","global_sequence":122016733,"recv_sequence":1850,"auth_sequence":[["dogonthetree",297]],"code_sequence":1,"abi_sequence":1},"act":{"account":"ecoboostcoin","name":"transfer","authorization":[{"actor":"dogonthetree","permission":"active"}],"data":{"from":"dogonthetree","to":"xinghuaboy11","quantity":"0.0001 EC","memo":"{\"time\":1564651409162,\"type\":2,\"msg\":\"\",\"id\":2159,\"ic\":\"\"}"},"hex_data":"a0d4cdaae549194d1082a7c7e8c6a6eb010000000000000004454300000000003a7b2274696d65223a313536343635313430393136322c2274797065223a322c226d7367223a22222c226964223a323135392c226963223a22227d"},"context_free":false,"elapsed":6,"console":"","trx_id":"3f08319c2f60393a5e91a05ec2ca1ab361982a0ce71d85819318138e79f18559","block_num":33834114,"block_time":"2019-08-01T09:23:30.500","producer_block_id":"02044482022d4a4e54f59410ba045724ae9d76a8a311de37761c34e253bab387","account_ram_deltas":[],"except":null,"inline_traces":[]}]}
    // return response;
}

module.exports = function (fastify, opts, next) {
    fastify.post('/get_transaction', {
        schema: getTransactionV1Schema.POST
    }, async (request, reply) => {
        reply.send(await getTransaction(fastify, request));
    });
    next()
};
