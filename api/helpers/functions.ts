import {createHash} from "crypto";
import * as _ from "lodash";
import {FastifyInstance, FastifyReply, FastifyRequest, HTTPMethod, RouteSchema} from "fastify";
import {ServerResponse} from "http";

export function extendResponseSchema(responseProps: any) {
    const props = {
        query_time_ms: {type: "number"},
        cached: {type: "boolean"},
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

export function setCacheByHash(fastify, hash, response) {
    if (fastify.manager.config.api.enable_caching) {
        const exp = fastify.manager.config.api.cache_life;
        fastify.redis.set(hash, JSON.stringify(response), 'EX', exp).catch(console.log);
    }
}

export function getRouteName(filename: string) {
    const arr = filename.split("/");
    return arr[arr.length - 2];
}

export function addApiRoute(
    fastifyInstance: FastifyInstance,
    method: HTTPMethod | HTTPMethod[],
    routeName: string,
    routeBuilder: (fastify: FastifyInstance, route: string) => (request: FastifyRequest, reply: FastifyReply<ServerResponse>) => Promise<void>, schema: RouteSchema) {
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
        const keystring = JSON.stringify(key);
        [resp, hash] = await getCacheByHash(server.redis, route + keystring, chain);
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

export async function timedQuery(
    queryFunction: (fastify: FastifyInstance, request: FastifyRequest) => Promise<any>,
    fastify: FastifyInstance, request: FastifyRequest, route: string): Promise<any> {

    // get reference time in nanoseconds
    const t0 = process.hrtime.bigint();

    // check for cached data, return the response hash if caching is enabled
    const [cachedResponse, hash] = await getCachedResponse(fastify, route, request.query);

    if (cachedResponse) {
        // add cached query time
        cachedResponse['query_time_ms'] = bigint2Milliseconds(process.hrtime.bigint() - t0);
        return cachedResponse;
    }

    // call query function
    const response = await queryFunction(fastify, request);

    // save response to cash
    if (hash) {
        setCacheByHash(fastify, hash, response);
    }

    // add normal query time
    if (response) {
        response['query_time_ms'] = bigint2Milliseconds(process.hrtime.bigint() - t0);
        return response;
    } else {
        return {};
    }
}
