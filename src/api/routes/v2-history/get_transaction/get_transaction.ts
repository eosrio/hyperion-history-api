import {FastifyInstance, FastifyReply, FastifyRequest} from "fastify";
import {mergeActionMeta, timedQuery} from "../../../helpers/functions.js";
import {resolveHotIndices} from "../../../helpers/hot-index.js";
import {regroupActions} from "../../../helpers/regroup-actions.js";
import {API} from "@wharfkit/antelope";

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
    const $getInfo = new Promise<API.v1.GetInfoResponse | null>(resolve => {
        const key = `${fastify.manager.chain}_get_info`;
        fastify.redis.get(key).then(value => {
            if (value) {
                response.cached_lib = true;
                resolve(JSON.parse(value));
            } else {
                fastify.antelope.chain.get_info().then(value1 => {
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
        const fullPattern = fastify.manager.chain + '-action-*';

        // Resolve the index target. A block_hint pins the single partition (no fan-out). Without one,
        // a trx_id term query has no block range to prune on, so it fans out across EVERY action
        // partition — including cold-tier shards holding old history (the dominant cold-node CPU
        // sink observed on the WAX cluster). All of a transaction's documents share one block, hence
        // one partition, so a recent-first probe is exact: if the hot window returns any hit it
        // returns them all, and only a miss (older or non-existent trx) needs to widen to the full
        // set. Opt-in via api.hot_first_transaction; reuses hot_first_window. See memory:
        // filter-context-query-cache-tradeoff / stream-replay-cold-tier-hardening.
        let indexPattern: string;
        let recentFirst = false;
        if (blockHint) {
            const idxPart = Math.ceil(blockHint / conf.settings.index_partition_size).toString().padStart(6, '0');
            indexPattern = fastify.manager.chain + `-action-${conf.settings.index_version}-${idxPart}`;
        } else if (conf.api.hot_first_transaction === true) {
            const hotWindow = conf.api.hot_first_window ?? 2;
            indexPattern = await resolveHotIndices(fastify, 'action', hotWindow);
            // Only a recent-first probe if the resolver actually narrowed to the hot window; a
            // degrade to the wildcard means this first search is already the full set.
            recentFirst = indexPattern !== fullPattern;
        } else {
            indexPattern = fullPattern;
        }

        const runSearch = (index: string) => fastify.elastic.search<any>({
            index,
            size: _size,
            query: {bool: {must: [{term: {trx_id: trxId}}]}},
            sort: {global_sequence: "asc"}
        }).catch((err: any) => {
            // Without a block_hint a 404 just means the probed index set isn't present yet (e.g. a
            // hot window that resolved to a not-yet-created name, or a freshly provisioned chain).
            // Treat it as a miss so we fall back to the full pattern instead of surfacing the
            // (here misleading) "no data near block_hint" error. With a block_hint the 404 is real
            // and is handled by the outer catch below.
            if (err?.meta?.statusCode === 404 && !blockHint) {
                return {hits: {hits: []}};
            }
            throw err;
        });

        let pResults;
        try {
            // execute get_info and the (phase-1) search in parallel
            pResults = await Promise.all([$getInfo, runSearch(indexPattern)]);
        } catch (e: any) {
            console.log(e.message);
            if (e?.meta?.statusCode === 404) {
                // Only reachable with a block_hint now (see runSearch catch), so the message fits.
                response.error = 'no data near block_hint'
                return response;
            }
            throw e;
        }
        hits = pResults[1].hits.hits;
        // $getInfo resolves null on failure — don't turn a recoverable lib-lookup miss into a 500.
        response.lib = pResults[0]?.last_irreversible_block_num;

        // Recent-first miss: the trx isn't in the hot window, so widen to the full set — the only
        // path that can reach cold shards. A non-empty hit set is already complete (single partition).
        if (recentFirst && hits.length === 0) {
            const widened = await runSearch(fullPattern);
            hits = widened.hits.hits;
        }
    }

    if (hits.length > 0) {
        let highestBlockNum = 0;
        for (let action of hits) {
            if (action._source.block_num > highestBlockNum) {
                highestBlockNum = action._source.block_num;
            }
        }
        const rawActions: any[] = [];
        for (let action of hits) {
            if (action._source.block_num === highestBlockNum) {
                mergeActionMeta(action._source);
                rawActions.push(action._source);
            }
        }

        // re-group notifications that were indexed as separate documents
        const grouped = regroupActions(rawActions);

        // add notified field derived from receipts
        response.actions = grouped.map(action => {
            if (action.receipts && action.receipts.length > 0) {
                const receivers = new Set<string>(
                    action.receipts.map((r: any) => r.receiver)
                );
                action.notified = [...receivers].join(',');
            }
            return action;
        });

        response.executed = true;
    }
    return response;
}

export function getTransactionHandler(fastify: FastifyInstance, route: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.send(await timedQuery(getTransaction, fastify, request, route));
    }
}
