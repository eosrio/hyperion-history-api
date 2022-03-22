import {createHash} from "crypto";
import * as _ from "lodash";
import {FastifyInstance, FastifyReply, FastifyRequest, FastifySchema, HTTPMethods} from "fastify";
import got from "got";

export function extendResponseSchema(responseProps: any) {
    const props = {
        query_time_ms: {type: "number"},
        cached: {type: "boolean"},
        hot_only: {type: "boolean"},
        lib: {type: "number"},
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
    get_creator: 3600 * 24
}

export async function timedQuery(
    queryFunction: (fastify: FastifyInstance, request: FastifyRequest) => Promise<any>,
    fastify: FastifyInstance, request: FastifyRequest, route: string): Promise<any> {

    // get reference time in nanoseconds
    const t0 = process.hrtime.bigint();

    // check for cached data, return the response hash if caching is enabled
    const [cachedResponse, hash] = await getCachedResponse(
        fastify,
        route,
        request.method === 'POST' ? request.body : request.query
    );

    if (cachedResponse && !request.query["ignoreCache"]) {
        // add cached query time
        cachedResponse['query_time_ms'] = bigint2Milliseconds(process.hrtime.bigint() - t0);
        return cachedResponse;
    }

    // call query function
    const response = await queryFunction(fastify, request);

    // save response to cash
    if (hash) {
        let EX = null;
        if (defaultRouteCacheMap[route]) {
            EX = defaultRouteCacheMap[route];
        }
        setCacheByHash(fastify, hash, response, EX);
    }

    // add normal query time
    if (response) {
        response['query_time_ms'] = bigint2Milliseconds(process.hrtime.bigint() - t0);
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
            // console.log('cache hit:', path, hash);
            reply.headers({'hyperion-cached': true}).send(cachedData);
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

    const opts = {};

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
        opts['json'] = request.query;
    }

    try {
        const apiResponse = await got.post(reqUrl, opts);
        reply.headers({"Content-Type": "application/json"});
        if (request.method === 'HEAD') {
            reply.headers({"Content-Length": apiResponse.body.length});
            reply.send("");
            return '';
        } else {
            reply.send(apiResponse.body);
            return apiResponse.body;
        }
    } catch (error) {

        if (error.response) {
            reply.status(error.response.statusCode).send(error.response.body);
        } else {
            console.log(error);
            reply.status(500).send();
        }

        if (fastify.manager.config.api.chain_api_error_log) {
            try {
                if (error.response) {
                    const error_msg = JSON.parse(error.response.body).error.details[0].message;
                    console.log(`endpoint: ${request.raw.url} | status: ${error.response.statusCode} | error: ${error_msg}`);
                } else {
                    console.log(error);
                }
                // if (request.req.url === '/v1/chain/push_transaction') {
                //     const packedTrx = JSON.parse(opts['body']).packed_trx;
                //     const trxBuffer = Buffer.from(packedTrx, 'hex');
                //     const trxData = await fastify.eosjs.api.deserializeTransactionWithActions(trxBuffer);
                //     console.log(trxData);
                // }
            } catch (e:any) {
                console.log(e);
            }
        }

        return '';
    }
}

export function addChainApiRoute(fastify: FastifyInstance, routeName, description, props?, required?) {
    const baseSchema = {
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
            } : undefined
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
                type: ['object', 'string'],
                properties: props,
                required: required
            } : undefined
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
        "anyOf": [
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
        "description": "Time that transaction must be confirmed by.",
        "type": "string",
        "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$",
        "title": "DateTime"
    });

    fastify.addSchema({
        $id: "BlockExtensions",
        "type": "array",
        "items": {
            "anyOf": [
                {"type": "integer"},
                {"type": "string"}
            ]
        },
        "title": "Extension"
    })

    fastify.addSchema({
        $id: "ActionItems",
        "type": "object",
        "additionalProperties": false,
        "minProperties": 5,
        "required": [
            "account",
            "name",
            "authorization",
            "data",
            "hex_data"
        ],
        "properties": {
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
