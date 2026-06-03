import {FastifyInstance} from "fastify";
import {hLog} from "../../indexer/helpers/common_functions.js";

// How long a resolved hot-index set is reused before re-querying ES. Short enough that a
// freshly rolled-over partition is picked up quickly; long enough that high-frequency polling
// does not turn into a _cat/indices storm.
const HOT_INDEX_TTL_MS = 30_000;

interface CacheEntry {
    value: string;
    expires: number;
    // Shared in-flight refresh so concurrent requests past expiry trigger a single _cat lookup.
    inflight?: Promise<string>;
}

const cache = new Map<string, CacheEntry>();

/**
 * Resolve the newest `window` physical partitions of a tiered type (`<chain>-<type>-<version>-<part>`)
 * as a comma-joined index string for "hot-first" searches. Physical index names sort lexicographically
 * by recency (zero-padded partition, version-prefixed), so the newest `window` names are simply the
 * top of a descending sort.
 *
 * The result is cached per (chain, type, window) with a short TTL and a shared in-flight promise so a
 * burst of polls past expiry costs one `_cat/indices` call. On any error — or when no physical index
 * matches yet — it degrades to the `<chain>-<type>-*` wildcard, so callers always get a searchable
 * target and never fail because of this optimization.
 */
export async function resolveHotIndices(
    fastify: FastifyInstance,
    type: 'action' | 'delta',
    window: number
): Promise<string> {
    const chain = fastify.manager.chain;
    const win = Math.max(1, Math.floor(window));
    const key = `${chain}-${type}-${win}`;
    const fallback = `${chain}-${type}-*`;
    // Scope the lookup to the active index_version so that on a multi-version cluster (during/after a
    // reindex) a higher-version low partition (e.g. <chain>-<type>-v2-000001) can't sort ahead of the
    // live latest partition of the running version and cause newest actions to be missed. When the
    // version is unknown, fall back to all versions (correctness is still preserved by the caller's
    // widen-on-shortfall step).
    const version = fastify.manager.config?.settings?.index_version;
    const searchPattern = version ? `${chain}-${type}-${version}-*` : fallback;
    const now = Date.now();

    const cached = cache.get(key);
    if (cached && cached.expires > now) {
        return cached.value;
    }
    // A refresh is already running — ride along instead of issuing a second _cat call.
    if (cached?.inflight) {
        return cached.inflight;
    }

    const inflight = (async () => {
        try {
            const records = await fastify.elastic.cat.indices({
                index: searchPattern,
                h: 'index',
                s: 'index:desc',
                format: 'json'
            });
            // Some client/transport configurations can return a non-array under error/empty states;
            // guard so we degrade to the wildcard rather than throwing on .map.
            const names = (Array.isArray(records) ? records : [])
                .map((r: { index?: string }) => r.index)
                .filter((n): n is string => typeof n === 'string' && n.length > 0)
                .slice(0, win);
            const value = names.length > 0 ? names.join(',') : fallback;
            cache.set(key, {value, expires: Date.now() + HOT_INDEX_TTL_MS});
            return value;
        } catch (e: any) {
            // Degrade to the wildcard and cache it briefly so a flapping cluster does not get
            // hammered with _cat retries on every request.
            hLog(`hot-index resolve failed for ${key}, using wildcard: ${e?.message ?? e}`);
            cache.set(key, {value: fallback, expires: Date.now() + HOT_INDEX_TTL_MS});
            return fallback;
        }
    })();

    // Publish the in-flight promise (keeping any stale value for readers that prefer it) so
    // concurrent callers dedupe onto this single refresh.
    cache.set(key, {value: cached?.value ?? fallback, expires: cached?.expires ?? 0, inflight});
    return inflight;
}
