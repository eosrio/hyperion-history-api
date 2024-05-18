import {createHash} from "crypto";
import * as _ from "lodash";
import {FastifyInstance, FastifyReply, FastifyRequest, FastifySchema, HTTPMethods} from "fastify";
import {checkDeltaFilter, checkFilter, hLog} from "../../helpers/common_functions";
import {Socket} from "socket.io";
import {ScrollId, SearchResponse} from "@elastic/elasticsearch/lib/api/types";

const deltaQueryFields = ['code', 'table', 'scope', 'payer'];

export function getTotalValue(searchResponse: SearchResponse): number {
    if (searchResponse.hits.total) {
        if (typeof searchResponse.hits.total === 'number') {
            return searchResponse.hits.total;
        } else {
            return searchResponse.hits.total.value;
        }
    } else {
        return 0;
    }
}

export async function streamPastDeltas(fastify: FastifyInstance, socket: Socket, data: any) {
    const search_body: any = {
        query: {bool: {must: []}},
        sort: {block_num: 'asc'},
    };
    await addBlockRangeOpts(data, search_body, fastify);
    deltaQueryFields.forEach(f => {
        addTermMatch(data, search_body, f);
    });

    const onDemandDeltaFilters: any[] = [];
    if (data.filters.length > 0) {
        data.filters.forEach(f => {
            if (f.field && f.value) {
                if (f.field.startsWith('@') && !f.field.startsWith('data')) {
                    const _q = {};
                    _q[f.field] = f.value;
                    search_body.query.bool.must.push({'term': _q});
                } else {
                    onDemandDeltaFilters.push(f);
                }
            }
        });
    }

    const responseQueue: SearchResponse<any, any>[] = [];

    let counter = 0;
    let total = 0;
    let totalFiltered = 0;
    let longScroll = false;

    // console.log(JSON.stringify(search_body, null, 2));

    const init_response: SearchResponse<any, any> = await fastify.elastic.search({
        index: fastify.manager.chain + '-delta-*',
        scroll: '30s',
        size: fastify.manager.config.api.stream_scroll_batch || 500,
        body: search_body,
    });

    const totalHits = getTotalValue(init_response);

    const scrollLimit = fastify.manager.config.api.stream_scroll_limit;
    if (scrollLimit && scrollLimit !== -1 && totalHits > scrollLimit) {
        const errorMsg = `Requested ${totalHits} deltas, limit is ${scrollLimit}.`;
        socket.emit('message', {
            reqUUID: socket.data.reqUUID,
            type: 'delta_trace', mode: 'history', messages: [],
            error: errorMsg
        });
        return {status: false, error: errorMsg};
    }

    if (totalHits > 10000) {
        total = totalHits;
        longScroll = true;
        hLog(`Attention! Long scroll (deltas) is running!`);
    }

    // emit first block
    if (init_response.hits.hits.length > 0) {
        emitTraceInit(socket, init_response.hits.hits[0]._source.block_num, totalHits);
    }

    responseQueue.push(init_response);

    let lastTransmittedBlock = 0;
    let pendingScrollId: ScrollId | undefined = '';
    while (responseQueue.length) {
        let filterCount = 0;
        const rp = responseQueue.shift();
        if (rp) {
            pendingScrollId = rp._scroll_id;
            const enqueuedMessages: any[] = [];
            counter += rp.hits.hits.length;

            for (const doc of rp.hits.hits) {
                let allow = false;
                if (onDemandDeltaFilters.length > 0) {
                    allow = onDemandDeltaFilters.every(filter => {
                        return checkDeltaFilter(filter, doc._source);
                    });
                } else {
                    allow = true;
                }
                if (allow) {
                    enqueuedMessages.push(doc._source);
                } else {
                    filterCount++;
                }
                // set last block
                if (doc._source.block_num > lastTransmittedBlock) {
                    lastTransmittedBlock = doc._source.block_num;
                }
            }

            totalFiltered += filterCount;

            if (socket.connected) {
                if (enqueuedMessages.length > 0) {
                    socket.emit('message', {
                        reqUUID: socket.data.reqUUID,
                        type: 'delta_trace',
                        mode: 'history',
                        messages: enqueuedMessages,
                        filtered: filterCount
                    });
                }
            } else {
                hLog('LOST CLIENT');
                break;
            }

            if (longScroll) {
                hLog(`Progress: ${counter + totalFiltered}/${total}`);
            }

            if (getTotalValue(rp) === counter) {
                hLog(`${counter} past deltas streamed to ${socket.id} (${totalFiltered} filtered)`);
                break;
            }

            const next_response = await fastify.elastic.scroll({
                body: {scroll_id: rp._scroll_id ?? "", scroll: '30s'}
            });
            responseQueue.push(next_response);
        }
    }

    // destroy scroll context
    await fastify.elastic.clearScroll({scroll_id: pendingScrollId});
    return {status: true, lastTransmittedBlock};
}

export function emitTraceInit(socket: Socket, firstBlock: number, totalResults: number) {
    socket.emit('message', {
        reqUUID: socket.data.reqUUID,
        type: 'trace_init',
        mode: 'history',
        first_block: firstBlock,
        results: totalResults
    });
}

export async function streamPastActions(fastify: FastifyInstance, socket, data) {
    const search_body: any = {query: {bool: {must: []}}, sort: {global_sequence: 'asc'}};
    await addBlockRangeOpts(data, search_body, fastify);
    if (data.account !== '') {
        search_body.query.bool.must.push({
            bool: {
                should: [
                    {term: {'notified': data.account}},
                    {term: {'act.authorization.actor': data.account}},
                ],
            },
        });
    }

    if (data.contract !== '*' && data.contract !== '') {
        search_body.query.bool.must.push({'term': {'act.account': data.contract}});
    }

    if (data.action !== '*' && data.action !== '') {
        search_body.query.bool.must.push({'term': {'act.name': data.action}});
    }

    const onDemandFilters: any[] = [];
    if (data.filters.length > 0) {
        data.filters.forEach(f => {
            if (f.field && f.value) {
                if (f.field.startsWith('@') && !f.field.startsWith('act.data')) {
                    const _q = {};
                    _q[f.field] = f.value;
                    search_body.query.bool.must.push({'term': _q});
                } else {
                    onDemandFilters.push(f);
                }
            }
        });
    }

    const responseQueue: SearchResponse<any, any>[] = [];
    let counter = 0;
    let total = 0;
    let totalFiltered = 0;
    let longScroll = false;

    const init_response: SearchResponse<any, any> = await fastify.elastic.search({
        index: fastify.manager.chain + '-action-*',
        scroll: '30s',
        size: fastify.manager.config.api.stream_scroll_batch || 500,
        body: search_body,
    });

    const totalHits = getTotalValue(init_response);

    const scrollLimit = fastify.manager.config.api.stream_scroll_limit;
    if (scrollLimit && scrollLimit !== -1 && totalHits > scrollLimit) {
        const errorMsg = `Requested ${totalHits} actions, limit is ${scrollLimit}.`;
        socket.emit('message', {
            reqUUID: socket.data.reqUUID,
            type: 'action_trace', mode: 'history', messages: [],
            error: `Requested ${totalHits} actions, limit is ${scrollLimit}.`
        });
        return {status: false, error: errorMsg};
    }

    if (totalHits > 10000) {
        total = totalHits;
        longScroll = true;
        hLog(`Attention! Long scroll (actions) is running!`);
    }

    // emit first block
    if (init_response.hits.hits.length > 0) {
        emitTraceInit(socket, init_response.hits.hits[0]._source.block_num, totalHits);
    }

    responseQueue.push(init_response);

    let lastTransmittedBlock = 0;
    let pendingScrollId: ScrollId | undefined = '';
    while (responseQueue.length) {
        let filterCount = 0;
        const rp = responseQueue.shift();
        if (rp) {
            pendingScrollId = rp._scroll_id;
            const enqueuedMessages: any[] = [];
            counter += rp.hits.hits.length;
            for (const doc of rp.hits.hits) {
                let allow = false;
                if (onDemandFilters.length > 0) {
                    allow = onDemandFilters.every(filter => {
                        return checkFilter(filter, doc._source);
                    });
                } else {
                    allow = true;
                }
                if (allow) {
                    enqueuedMessages.push(doc._source);
                } else {
                    filterCount++;
                }
                // set last block
                if (doc._source.block_num > lastTransmittedBlock) {
                    lastTransmittedBlock = doc._source.block_num;
                }
            }

            totalFiltered += filterCount;

            if (socket.connected) {
                if (enqueuedMessages.length > 0) {
                    socket.emit('message', {
                        reqUUID: socket.data.reqUUID,
                        type: 'action_trace',
                        mode: 'history',
                        messages: enqueuedMessages,
                        filtered: filterCount
                    });
                }
            } else {
                hLog('LOST CLIENT');
                break;
            }

            if (longScroll) {
                hLog(`Progress: ${counter + totalFiltered}/${total}`);
            }

            if (getTotalValue(rp) === counter) {
                hLog(`${counter} past actions streamed to ${socket.id} (${totalFiltered} filtered)`);
                break;
            }

            const next_response = await fastify.elastic.scroll({
                body: {scroll_id: rp._scroll_id ?? "", scroll: '30s'}
            });
            responseQueue.push(next_response);
        }
    }

    // destroy scroll context
    await fastify.elastic.clearScroll({scroll_id: pendingScrollId});
    return {status: true, lastTransmittedBlock};

}

export function addTermMatch(data, search_body, field) {
    if (data[field] && data[field] !== '*' && data[field] !== '') {
        const termQuery = {};
        termQuery[field] = data[field];
        search_body.query.bool.must.push({'term': termQuery});
    }
}

export async function addBlockRangeOpts(data, search_body, fastify: FastifyInstance) {

    let timeRange;
    let blockRange;
    let head;

    if (typeof data['start_from'] === 'string' && data['start_from'] !== '') {
        if (!timeRange) {
            timeRange = {"@timestamp": {}};
        }
        timeRange["@timestamp"]['gte'] = data['start_from'];
    }

    if (typeof data['read_until'] === 'string' && data['read_until'] !== '') {
        if (!timeRange) {
            timeRange = {"@timestamp": {}};
        }
        timeRange["@timestamp"]['lte'] = data['read_until'];
    }

    if (typeof data['start_from'] === 'number' && data['start_from'] !== 0) {
        if (!blockRange) {
            blockRange = {"block_num": {}};
        }
        if (data['start_from'] < 0) {
            if (!head) {
                head = (await fastify.eosjs.rpc.get_info()).head_block_num;
            }
            blockRange["block_num"]['gte'] = head + data['start_from'];
        } else {
            blockRange["block_num"]['gte'] = data['start_from'];
        }
    }

    if (typeof data['read_until'] === 'number' && data['read_until'] !== 0) {
        if (!blockRange) {
            blockRange = {"block_num": {}};
        }
        if (data['read_until'] < 0) {
            if (!head) {
                head = (await fastify.eosjs.rpc.get_info()).head_block_num;
            }
            blockRange["block_num"]['lte'] = head + data['read_until'];
        } else {
            blockRange["block_num"]['lte'] = data['read_until'];
        }
    }

    if (timeRange) {
        search_body.query.bool.must.push({
            range: timeRange,
        });
    }
    if (blockRange) {
        search_body.query.bool.must.push({
            range: blockRange,
        });
    }
}

export function extendResponseSchema(responseProps: any) {
    const props = {
        query_time_ms: {type: "number"},
        cached: {type: "boolean"},
        hot_only: {type: "boolean"},
        lib: {type: "number"},
        last_indexed_block: {type: "number"},
        last_indexed_block_time: {type: "string"},
        total: {
            type: "object",
            properties: {
                value: {type: "number"},
                relation: {type: "string"}
            }
        }
    };
    for (const p in responseProps) {
        if (responseProps.hasOwnProperty(p)) {
            props[p] = responseProps[p];
        }
    }
    return {
        200: {
            type: 'object',
            properties: props
        }
    };
}

export function extendQueryStringSchema(queryParams: any, required?: string[]) {
    const params = {
        limit: {
            description: 'limit of [n] results per page',
            type: 'integer',
            minimum: 1
        },
        skip: {
            description: 'skip [n] results',
            type: 'integer',
            minimum: 0
        }
    };
    for (const p in queryParams) {
        if (queryParams.hasOwnProperty(p)) {
            params[p] = queryParams[p];
        }
    }
    const schema = {
        type: 'object',
        properties: params
    }
    if (required && required.length > 0) {
        schema["required"] = required;
    }
    return schema;
}

export async function getCacheByHash(redis, key, chain) {
    const hash = createHash('sha256');
    const query_hash = hash.update(chain + "-" + key).digest('hex');
    return [await redis.get(query_hash), query_hash];
}

export function mergeActionMeta(action) {
    const name = action.act.name;
    if (action['@' + name]) {
        action['act']['data'] = _.merge(action['@' + name], action['act']['data']);
        delete action['@' + name];
    }
    action['timestamp'] = action['@timestamp'];
    // delete action['@timestamp'];
}

export function mergeDeltaMeta(delta: any) {
    const name = delta.table;
    if (delta["@" + name]) {
        delta['data'] = _.merge(delta['@' + name], delta['data']);
        delete delta['@' + name];
    }
    delta['timestamp'] = delta['@timestamp'];
    delete delta['@timestamp'];
    return delta;
}

export function setCacheByHash(fastify, hash, response, expiration?: number) {
    if (fastify.manager.config.api.enable_caching) {
        let exp;
        if (expiration) {
            exp = expiration;
        } else {
            exp = fastify.manager.config.api.cache_life;
        }
        fastify.redis.set(hash, JSON.stringify(response), 'EX', exp).catch(console.log);
    }
}

export function getRouteName(filename: string) {
    const arr = filename.split("/");
    return arr[arr.length - 2];
}

export function addApiRoute(
    fastifyInstance: FastifyInstance,
    method: HTTPMethods | HTTPMethods[],
    routeName: string,
    routeBuilder: (fastify: FastifyInstance, route: string) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
    schema: FastifySchema
) {

    hLog(`Adding ${method} ${fastifyInstance.prefix}${routeName}`);

    // if (`${fastifyInstance.prefix}${routeName}` === '/v1/chain/get_info') {
    //     console.log(fastifyInstance.prefix, routeName, method, JSON.stringify(schema, null, 2));
    // }

    fastifyInstance.route({
        url: '/' + routeName,
        method,
        handler: routeBuilder(fastifyInstance, routeName),
        schema
    });
}

export async function getCachedResponse(server: FastifyInstance, route: string, key: any) {
    const chain = server.manager.chain;
    let resp, hash;
    if (server.manager.config.api.enable_caching) {
        [resp, hash] = await getCacheByHash(server.redis, route + JSON.stringify(key), chain);
        if (resp) {
            resp = JSON.parse(resp);
            resp['cached'] = true;
            return [resp, hash];
        } else {
            return [null, hash];
        }
    } else {
        return [null, null];
    }
}

export function getTrackTotalHits(query) {
    let trackTotalHits: number | boolean = 10000;
    if (query?.track) {
        if (query.track === 'true') {
            trackTotalHits = true;
        } else if (query.track === 'false') {
            trackTotalHits = false;
        } else {
            const parsed = parseInt(query.track, 10);
            if (parsed > 0) {
                trackTotalHits = parsed;
            } else {
                throw new Error('failed to parse track param');
            }
        }
    }
    return trackTotalHits;
}

function bigint2Milliseconds(input: bigint) {
    return parseFloat((parseInt(input.toString()) / 1000000).toFixed(3));
}

const defaultRouteCacheMap = {
    get_resource_usage: 3600,
    get_creator: 3600 * 24,
    health: 10
}

export async function timedQuery(
    queryFunction: (fastify: FastifyInstance, request: FastifyRequest) => Promise<any>,
    fastify: FastifyInstance, request: FastifyRequest, route: string): Promise<any> {

    const query = request.query as any;

    // get reference time in nanoseconds
    const t0 = process.hrtime.bigint();

    // check for cached data, return the response hash if caching is enabled
    const [cachedResponse, hash] = await getCachedResponse(
        fastify,
        route,
        request.method === 'POST' ? request.body : query
    );

    let lastIndexedBlockNumber: number | null = null;
    let lastIndexedBlockTime: string | null = null;
    const lastIndexedBlock = await fastify.redis.get(`${fastify.manager.chain}:last_idx_block`);
    if (lastIndexedBlock) {
        const arr = lastIndexedBlock.split("@");
        if (arr.length === 2) {
            lastIndexedBlockNumber = parseInt(arr[0], 10);
            lastIndexedBlockTime = arr[1];
        }
    }

    if (cachedResponse && !query["ignoreCache"]) {
        // add cached query time
        cachedResponse['query_time_ms'] = bigint2Milliseconds(process.hrtime.bigint() - t0);
        if (lastIndexedBlock) {
            cachedResponse['last_indexed_block'] = lastIndexedBlockNumber;
            cachedResponse['last_indexed_block_time'] = lastIndexedBlockTime;
        }
        return cachedResponse;
    }

    // call query function
    const response = await queryFunction(fastify, request);

    // save response to cache
    if (hash) {
        let EX: number | undefined = undefined;
        if (defaultRouteCacheMap[route]) {
            EX = defaultRouteCacheMap[route];
        }
        setCacheByHash(fastify, hash, response, EX);
    }

    // add normal query time
    if (response) {
        response['query_time_ms'] = bigint2Milliseconds(process.hrtime.bigint() - t0);
        if (lastIndexedBlock) {
            response['last_indexed_block'] = lastIndexedBlockNumber;
            response['last_indexed_block_time'] = lastIndexedBlockTime;
        }
        return response;
    } else {
        return {};
    }
}

export function chainApiHandler(fastify: FastifyInstance) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        // check cache
        const [cachedData, hash, path] = fastify.cacheManager.getCachedData(request);
        if (cachedData) {
            console.log('cache hit:', path, hash);
            reply.header('hyperion-cached', true).send(cachedData);
        } else {
            // call actual request
            const apiResponse = await handleChainApiRedirect(request, reply, fastify);
            // console.log('cache miss:', path, hash);
            fastify.cacheManager.setCachedData(hash, path, apiResponse);
        }
    }
}

export async function handleChainApiRedirect(
    request: FastifyRequest,
    reply: FastifyReply,
    fastify: FastifyInstance
): Promise<string> {
    const urlParts = request.url.split("?");
    let reqUrl = fastify.chain_api + urlParts[0];

    // const pathComponents = urlParts[0].split('/');
    // const path = pathComponents.at(-1);


    if (urlParts[0] === '/v1/chain/push_transaction' && fastify.push_api && fastify.push_api !== "") {
        reqUrl = fastify.push_api + urlParts[0];
    }

    const opts: any = {};

    if (request.method === 'POST') {
        if (request.body) {
            if (typeof request.body === 'string') {
                opts['body'] = request.body;
            } else if (typeof request.body === 'object') {
                opts['body'] = JSON.stringify(request.body);
            }
        } else {
            opts['body'] = "";
        }
    } else if (request.method === 'GET') {
        const query = request.query as any;
        if (Object.keys(query).length === 0) {
            opts['json'] = undefined;
        } else {
            if (query.json === undefined) {
                query.json = true;
            }
            opts['json'] = JSON.stringify(query);
        }
    }

    try {

        // Fetch
        const apiPostResponse = await fetch(reqUrl, {
            method: "POST",
            body: request.method === 'POST' ? opts['body'] : (opts['json'] ?? JSON.stringify({json:true}))
        });

        const len = apiPostResponse.headers.get('content-length');
        const apiResponse = await apiPostResponse.json();

        reply.headers({"Content-Type": "application/json"});

        if (request.method === 'HEAD') {
            reply.headers({"Content-Length": len ?? 0});
            reply.send("");
            return '';
        } else {
            reply.send(apiResponse);
            return apiResponse;
        }

    } catch (error: any) {

        if (error.response) {
            reply.status(error.response.statusCode).send(error.response.body);
        } else {
            hLog(error);
            reply.status(500).send();
        }

        if (fastify.manager.config.api.chain_api_error_log) {
            try {
                if (error.response) {
                    const error_msg = JSON.parse(error.response.body).error.details[0].message;
                    hLog(`endpoint: ${request.raw.url} | status: ${error.response.statusCode} | error: ${error_msg}`);
                } else {
                    hLog(error);
                }
                // if (request.req.url === '/v1/chain/push_transaction') {
                //     const packedTrx = JSON.parse(opts['body']).packed_trx;
                //     const trxBuffer = Buffer.from(packedTrx, 'hex');
                //     const trxData = await fastify.eosjs.api.deserializeTransactionWithActions(trxBuffer);
                //     console.log(trxData);
                // }
            } catch (e) {
                hLog(e);
            }
        }

        return '';
    }
}

export function addChainApiRoute(fastify: FastifyInstance, routeName, description, props?, required?) {

    const baseSchema: FastifySchema = {
        description: description,
        summary: description,
        tags: ['chain']
    };

    addApiRoute(
        fastify,
        ['GET', 'HEAD'],
        routeName,
        chainApiHandler,
        {
            ...baseSchema,
            querystring: props ? {
                type: 'object',
                properties: props,
                required: required
            } : {}
        }
    );

    addApiRoute(
        fastify,
        'POST',
        routeName,
        chainApiHandler,
        {
            ...baseSchema,
            body: props ? {
                anyOf: [{
                    type: 'object',
                    properties: props,
                    required: required
                },{
                    type: 'string'
                }]
            } : {}
        }
    );
}

export function addSharedSchemas(fastify: FastifyInstance) {
    fastify.addSchema({
        $id: "WholeNumber",
        title: "Integer",
        description: "Integer or String",
        anyOf: [
            {
                type: "string",
                pattern: "^\\d+$"
            },
            {
                type: "integer"
            }
        ],
    });

    fastify.addSchema({
        $id: "Symbol",
        type: "string",
        description: "A symbol composed of capital letters between 1-7.",
        pattern: "^([A-Z]{1,7})$",
        title: "Symbol"
    });

    fastify.addSchema({
        $id: "Signature",
        type: "string",
        description: "String representation of an EOSIO compatible cryptographic signature",
        pattern: "^SIG_([RK]1|WA)_[1-9A-HJ-NP-Za-km-z]+$",
        title: "Signature"
    })

    fastify.addSchema({
        $id: "AccountName",
        description: "String representation of an EOSIO compatible account name",
        anyOf: [
            {
                "type": "string",
                "description": "String representation of privileged EOSIO name type",
                "pattern": "^(eosio[\\.][a-z1-5]{1,6})([a-j]{1})?$",
                "title": "NamePrivileged"
            },
            {
                "type": "string",
                "description": "String representation of basic EOSIO name type, must be 12 characters and contain only a-z and 0-5",
                "pattern": "^([a-z]{1}[a-z1-5]{11})([a-j]{1})?$",
                "title": "NameBasic"
            },
            {
                "type": "string",
                "description": "String representation of EOSIO bid name type, 1-12 characters and only a-z and 0-5 are allowed",
                "pattern": "^([a-z1-5]{1,12})([a-j]{1})?$",
                "title": "NameBid"
            },
            {
                "type": "string",
                "description": "String representation of EOSIO name type",
                "pattern": "^([a-z1-5]{1}[a-z1-5\\.]{0,10}[a-z1-5]{1})([a-j]{1})?$",
                "title": "NameCatchAll"
            }
        ],
        "title": "Name"
    });

    fastify.addSchema({
        $id: "Expiration",
        description: "Time that transaction must be confirmed by.",
        type: "string",
        pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$",
        title: "DateTime"
    });

    fastify.addSchema({
        $id: "BlockExtensions",
        type: "array",
        items: {
            anyOf: [
                {type: "integer"},
                {type: "string"}
            ]
        },
        title: "Extension"
    })

    fastify.addSchema({
        $id: "ActionItems",
        type: "object",
        additionalProperties: false,
        minProperties: 5,
        required: [
            "account",
            "name",
            "authorization",
            "data",
            "hex_data"
        ],
        properties: {
            "account": {$ref: 'AccountName#'},
            "name": {$ref: 'AccountName#'},
            "authorization": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "minProperties": 2,
                    "required": [
                        "actor",
                        "permission"
                    ],
                    "properties": {
                        "actor": {$ref: 'AccountName#'},
                        "permission": {$ref: 'AccountName#'}
                    },
                    "title": "Authority"
                }
            },
            "data": {
                "type": "object",
                "additionalProperties": true
            },
            "hex_data": {
                "type": "string"
            }
        },
        "title": "Action"
    });
}
