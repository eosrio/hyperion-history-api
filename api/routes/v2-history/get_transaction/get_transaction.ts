import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {mergeActionMeta, timedQuery} from "../../../helpers/functions";
import {GetInfoResult} from "eosjs/dist/eosjs-rpc-interfaces";

async function getTransaction(fastify: FastifyInstance, request: FastifyRequest) {
    const redis = fastify.redis;
    const query: any = request.query;
    const trxId = query.id.toLowerCase();
    const conf = fastify.manager.config;
    const cachedData = await redis.hgetall('trx_' + trxId);
    const response: any = {
        query_time_ms: undefined,
        executed: false,
        cached: undefined,
        cache_expires_in: undefined,
        trx_id: query.id,
        lib: undefined,
        cached_lib: false,
        actions: undefined,
        generated: undefined,
        error: undefined
    };
    let hits;

    // build get_info request with caching
    const $getInfo = new Promise<GetInfoResult | null>(resolve => {
        const key = `${fastify.manager.chain}_get_info`;
        fastify.redis.get(key).then(value => {
            if (value) {
                response.cached_lib = true;
                resolve(JSON.parse(value));
            } else {
                fastify.eosjs.rpc.get_info().then(value1 => {
                    fastify.redis.set(key, JSON.stringify(value1), 'EX', 6);
                    response.cached_lib = false;
                    resolve(value1);
                }).catch((reason) => {
                    console.log(reason);
                    response.error = 'failed to get last_irreversible_block_num'
                    resolve(null);
                });
            }
        });
    });

    // reconstruct hits from cached data
    if (cachedData && Object.keys(cachedData).length > 0) {
        const gsArr: any[] = [];
        for (let cachedDataKey in cachedData) {
            gsArr.push(cachedData[cachedDataKey]);
        }
        gsArr.sort((a, b) => {
            return a.global_sequence - b.global_sequence;
        });
        hits = gsArr.map(value => {
            return {
                _source: JSON.parse(value)
            };
        });
        const promiseResults = await Promise.all([
            redis.ttl('trx_' + trxId),
            $getInfo
        ]);
        response.cache_expires_in = promiseResults[0];
        response.lib = promiseResults[1]?.last_irreversible_block_num;
    }

    // search on ES if cache is not present
    if (!hits) {
        const _size = conf.api.limits.get_trx_actions || 100;
        const blockHint = parseInt(query.block_hint, 10);
        let indexPattern = '';
        if (blockHint) {
            const idxPart = Math.ceil(blockHint / conf.settings.index_partition_size).toString().padStart(6, '0');
            indexPattern = fastify.manager.chain + `-action-${conf.settings.index_version}-${idxPart}`;
        } else {
            indexPattern = fastify.manager.chain + '-action-*';
        }
        let pResults;
        try {

            // build search request
            const $search = fastify.elastic.search<any>({
                index: indexPattern,
                size: _size,
                body: {
                    query: {bool: {must: [{term: {trx_id: trxId}}]}},
                    sort: {global_sequence: "asc"}
                }
            });

            // execute in parallel
            pResults = await Promise.all([$getInfo, $search]);
        } catch (e: any) {
            console.log(e.message);
            if (e.meta.statusCode === 404) {
                response.error = 'no data near block_hint'
                return response;
            }
        }
        hits = pResults[1].hits.hits;
        response.lib = pResults[0].last_irreversible_block_num;
    }

    if (hits.length > 0) {
        let highestBlockNum = 0;
        for (let action of hits) {
            if (action._source.block_num > highestBlockNum) {
                highestBlockNum = action._source.block_num;
            }
        }
        response.actions = [];
        for (let action of hits) {
            if (action._source.block_num === highestBlockNum) {
                mergeActionMeta(action._source);
                response.actions.push(action._source);
            }
        }
        response.executed = true;
    }
    return response;
}

export function getTransactionHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getTransaction, fastify, request, route));
    }
}
