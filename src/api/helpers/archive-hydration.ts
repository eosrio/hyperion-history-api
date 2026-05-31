import {request as undiciRequest} from 'undici';
import {FastifyInstance} from "fastify";
import {hLog} from "../../indexer/helpers/common_functions.js";
import {ArchiveRegistry} from "./archive-registry.js";

/**
 * Archive hydration
 * -----------------
 * Cold-tier Hyperion actions have their `act.data` dropped from Elasticsearch
 * to save storage. When such a document is returned by a v2 route, this module
 * transparently re-fetches the full `act.data` from the archive that owns the
 * block and writes it back onto the hit, so the API response is
 * indistinguishable from a hot (in-ES) document.
 *
 * WIRE CONTRACT (must match the archive's `/actions` endpoint):
 *
 *   POST <archive>/actions
 *   request body: JSON array
 *     [{"block_num": <number>, "global_sequence": <number|string>}, ...]
 *   response 200:
 *     {"actions":[
 *        {"block_num":<n>,"global_sequence":<g>,"account":"..","name":"..",
 *         "data":<decoded act.data JSON, OR {"hex":"<UPPERCASE>"} if undecodable>,
 *         "found":true},
 *        ...
 *     ]}  -- SAME ORDER as the request.
 *   not-found entry -> {"block_num","global_sequence","found":false} (no "data").
 *   malformed body  -> 400 ; more than 20000 items -> 413.
 *
 * DELTA WIRE CONTRACT (must match the archive's `/deltas` endpoint):
 *
 *   POST <archive>/deltas
 *   request body: JSON array
 *     [{"block_num": <number>, "code": "<name>", "scope": "<name>",
 *       "table": "<name>", "primary_key": "<u64 as string OR number>"}, ...]
 *   response 200:
 *     {"deltas":[
 *        // found + decoded   -> carries "data" (decoded row JSON object)
 *        {"block_num":<n>,"code":"..","scope":"..","table":"..","primary_key":"..",
 *         "data":<decoded row JSON>,"found":true},
 *        // found + undecodable -> carries "value" (UPPERCASE raw hex string)
 *        {"block_num":<n>,"code":"..","scope":"..","table":"..","primary_key":"..",
 *         "value":"<UPPERCASE hex>","found":true},
 *        // not found          -> carries NEITHER "data" NOR "value"
 *        {"block_num":<n>,"code":"..","scope":"..","table":"..","primary_key":"..",
 *         "found":false},
 *        ...
 *     ]}  -- SAME ORDER as the request.
 *   not-found when: block out of archived range, the block has no contract_row
 *     delta for that (code,scope,table,primary_key), or the row is absent.
 *   malformed body -> 400 ; more than 20000 items / >64 MiB -> 413.
 *
 * This mirrors how Hyperion stores delta docs: a hot delta doc carries EITHER a
 * `data` (decoded object) OR a `value` (raw hex); a cold (metadata-only) doc
 * carries NEITHER and is exactly what gets hydrated here.
 *
 * Failure policy: hydration is strictly best-effort. Any archive error,
 * timeout, non-200 status, malformed response, or order/length mismatch is
 * logged and the affected hits are simply left without `act.data` (actions) or
 * without `data`/`value` (deltas) — exactly the pre-hydration behavior.
 * Hydration NEVER fails the surrounding request.
 */

/** A minimal view of an ES hit we mutate in place. */
interface ActionHit {
    _source?: {
        block_num?: number;
        global_sequence?: number | string;
        act?: { data?: any; account?: string; name?: string };
        [key: string]: any;
    };
}

/** Item we send to an archive. */
interface ArchiveRequestItem {
    block_num: number;
    global_sequence: number | string;
}

/** Item we expect back from an archive (in request order). */
interface ArchiveResponseItem {
    block_num: number;
    global_sequence: number | string;
    account?: string;
    name?: string;
    data?: any;
    found: boolean;
}

/** A minimal view of an ES delta hit we mutate in place. */
interface DeltaHit {
    _source?: {
        block_num?: number;
        code?: string;
        scope?: string;
        table?: string;
        primary_key?: string | number;
        data?: any;
        value?: any;
        [key: string]: any;
    };
}

/** Item we send to a delta archive. */
interface ArchiveDeltaRequestItem {
    block_num: number;
    code: string;
    scope: string;
    table: string;
    primary_key: string | number;
}

/** Item we expect back from a delta archive (in request order). */
interface ArchiveDeltaResponseItem {
    block_num: number;
    code: string;
    scope: string;
    table: string;
    primary_key: string | number;
    /** Present (with found:true) when the row was decoded into a JSON object. */
    data?: any;
    /** Present (with found:true) when the row could not be decoded (raw hex). */
    value?: any;
    found: boolean;
}

/**
 * Hydrate cold-tier action hits in place.
 *
 * For each hit whose `block_num` maps to an archive (registry.archiveFor != null),
 * collect {block_num, global_sequence}, group by archive URL, POST the batch,
 * and assign each returned `data` back onto the matching `hit._source.act.data`
 * by request order.
 *
 * @param fastify Fastify instance (used to read `manager.config.api.archives`
 *                if no explicit registry is supplied).
 * @param hits    ES action hits (mutated in place).
 * @param registry Optional pre-built registry. Defaults to one built from config.
 */
export async function hydrateActions(
    fastify: FastifyInstance,
    hits: ActionHit[],
    registry?: ArchiveRegistry
): Promise<void> {

    if (!hits || hits.length === 0) {
        return;
    }

    const reg = registry ?? ArchiveRegistry.forActions(fastify.manager.config.api.archives);

    // Disabled / no archives configured -> no-op. Cold docs just lack act.data.
    if (!reg.isEnabled()) {
        return;
    }

    // Group hits needing hydration by owning archive URL. We keep the hit
    // reference alongside the request item so we can write `data` back in order.
    const byArchive = new Map<string, { items: ArchiveRequestItem[]; hits: ActionHit[] }>();

    for (const hit of hits) {
        const src = hit?._source;
        if (!src) {
            continue;
        }
        const blockNum = src.block_num;
        if (typeof blockNum !== 'number') {
            continue;
        }
        // Already has data (hot doc) -> nothing to do.
        if (src.act && src.act.data !== undefined && src.act.data !== null) {
            continue;
        }
        const url = reg.archiveFor(blockNum);
        if (!url) {
            continue; // hot / not covered by any archive
        }
        const gs = src.global_sequence;
        if (gs === undefined || gs === null) {
            continue; // cannot identify the action without a global_sequence
        }
        let bucket = byArchive.get(url);
        if (!bucket) {
            bucket = {items: [], hits: []};
            byArchive.set(url, bucket);
        }
        bucket.items.push({block_num: blockNum, global_sequence: gs});
        bucket.hits.push(hit);
    }

    if (byArchive.size === 0) {
        return;
    }

    // Fan out to every archive in parallel; each archive is independent and
    // self-isolating on failure.
    const tasks: Promise<void>[] = [];
    for (const [url, bucket] of byArchive) {
        tasks.push(hydrateFromArchive(url, bucket.items, bucket.hits, reg));
    }
    await Promise.all(tasks);
}

/**
 * POST a single archive's batch (chunked to maxBatch) and write `data` back.
 * Best-effort: never throws.
 */
async function hydrateFromArchive(
    url: string,
    items: ArchiveRequestItem[],
    hits: ActionHit[],
    reg: ArchiveRegistry
): Promise<void> {
    const maxBatch = reg.getMaxBatch();
    for (let offset = 0; offset < items.length; offset += maxBatch) {
        const chunkItems = items.slice(offset, offset + maxBatch);
        const chunkHits = hits.slice(offset, offset + maxBatch);
        try {
            const decoded = await postBatch(url, chunkItems, reg.getTimeoutMs());
            if (!decoded) {
                continue; // already logged; leave these hits unhydrated
            }
            assignData(chunkHits, decoded);
        } catch (e: any) {
            hLog(`[archive-hydration] ${url}/actions failed: ${e?.message ?? e}`);
            // leave chunk unhydrated and continue with the next chunk
        }
    }
}

/**
 * Perform the POST and return the response `actions` array, or `null` on any
 * problem (non-200, bad JSON, missing/short array). Throws only on transport
 * errors so the caller's try/catch can log a useful message.
 */
async function postBatch(
    url: string,
    items: ArchiveRequestItem[],
    timeoutMs: number
): Promise<ArchiveResponseItem[] | null> {
    const endpoint = `${url}/actions`;
    const res = await undiciRequest(endpoint, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(items),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs
    });

    if (res.statusCode !== 200) {
        // Drain the body so the connection can be reused, then bail.
        try {
            await res.body.dump();
        } catch {
            // ignore drain errors
        }
        hLog(`[archive-hydration] ${endpoint} returned status ${res.statusCode}`);
        return null;
    }

    let payload: any;
    try {
        payload = await res.body.json();
    } catch (e: any) {
        hLog(`[archive-hydration] ${endpoint} returned non-JSON body: ${e?.message ?? e}`);
        return null;
    }

    const actions = payload?.actions;
    if (!Array.isArray(actions)) {
        hLog(`[archive-hydration] ${endpoint} response missing 'actions' array`);
        return null;
    }
    if (actions.length !== items.length) {
        // Contract requires same-order, same-length. A mismatch means we cannot
        // safely map by index, so we discard the whole chunk.
        hLog(`[archive-hydration] ${endpoint} length mismatch: sent ${items.length}, got ${actions.length}`);
        return null;
    }
    return actions as ArchiveResponseItem[];
}

/**
 * Assign decoded `data` back onto each hit by request order. Entries with
 * `found:false` (or no `data`) are left untouched (act.data stays absent).
 */
function assignData(hits: ActionHit[], decoded: ArchiveResponseItem[]): void {
    for (let i = 0; i < hits.length; i++) {
        const entry = decoded[i];
        const src = hits[i]?._source;
        if (!src || !entry) {
            continue;
        }
        if (entry.found === true && entry.data !== undefined) {
            if (!src.act) {
                src.act = {};
            }
            src.act.data = entry.data;
        }
        // found:false -> leave act.data absent, matching pre-hydration behavior.
    }
}

/**
 * Hydrate cold-tier delta hits in place.
 *
 * A Hyperion delta `_source` carries the row payload as EITHER a `data`
 * (decoded object) OR a `value` (raw hex string). A COLD (metadata-only) delta
 * doc has NEITHER — that payload was dropped to save storage and is re-served
 * on demand from the archive that owns the block.
 *
 * For each cold hit whose `block_num` maps to a delta archive
 * (registry.archiveFor != null), collect {block_num, code, scope, table,
 * primary_key}, group by archive URL, POST the batch to `<archive>/deltas`, and
 * assign each returned payload back onto the matching hit by request order:
 *   found+data  -> hit._source.data = data
 *   found+value -> hit._source.value = value
 *   found:false -> leave the hit untouched
 *
 * @param fastify Fastify instance (reads `manager.config.api.archives`).
 * @param hits    ES delta hits (mutated in place).
 * @param registry Optional pre-built registry. Defaults to one built from config.
 */
export async function hydrateDeltas(
    fastify: FastifyInstance,
    hits: DeltaHit[],
    registry?: ArchiveRegistry
): Promise<void> {

    if (!hits || hits.length === 0) {
        return;
    }

    const reg = registry ?? ArchiveRegistry.forDeltas(fastify.manager.config.api.archives);

    // Disabled / no delta archive configured -> no-op. Cold docs just lack the
    // data/value payload, matching pre-hydration behavior (byte-identical).
    if (!reg.isEnabled()) {
        return;
    }

    // Group cold hits needing hydration by owning archive URL. We keep the hit
    // reference alongside the request item so we can write the payload back in
    // order.
    const byArchive = new Map<string, { items: ArchiveDeltaRequestItem[]; hits: DeltaHit[] }>();

    for (const hit of hits) {
        const src = hit?._source;
        if (!src) {
            continue;
        }
        const blockNum = src.block_num;
        if (typeof blockNum !== 'number') {
            continue;
        }
        // Hot doc: already carries a decoded `data` OR a raw `value` -> nothing
        // to do. A cold doc has NEITHER.
        if ((src.data !== undefined && src.data !== null) ||
            (src.value !== undefined && src.value !== null)) {
            continue;
        }
        const url = reg.archiveFor(blockNum);
        if (!url) {
            continue; // hot / not covered by any archive
        }
        const {code, scope, table, primary_key} = src;
        // Need the full delta identity to locate the row in the archive.
        if (typeof code !== 'string' || typeof scope !== 'string' ||
            typeof table !== 'string' ||
            (typeof primary_key !== 'string' && typeof primary_key !== 'number') ||
            primary_key === null || primary_key === undefined) {
            continue;
        }
        let bucket = byArchive.get(url);
        if (!bucket) {
            bucket = {items: [], hits: []};
            byArchive.set(url, bucket);
        }
        bucket.items.push({block_num: blockNum, code, scope, table, primary_key});
        bucket.hits.push(hit);
    }

    if (byArchive.size === 0) {
        return;
    }

    // Fan out to every archive in parallel; each archive is independent and
    // self-isolating on failure.
    const tasks: Promise<void>[] = [];
    for (const [url, bucket] of byArchive) {
        tasks.push(hydrateDeltasFromArchive(url, bucket.items, bucket.hits, reg));
    }
    await Promise.all(tasks);
}

/**
 * POST a single delta archive's batch (chunked to maxBatch) and write the
 * payload back. Best-effort: never throws.
 */
async function hydrateDeltasFromArchive(
    url: string,
    items: ArchiveDeltaRequestItem[],
    hits: DeltaHit[],
    reg: ArchiveRegistry
): Promise<void> {
    const maxBatch = reg.getMaxBatch();
    for (let offset = 0; offset < items.length; offset += maxBatch) {
        const chunkItems = items.slice(offset, offset + maxBatch);
        const chunkHits = hits.slice(offset, offset + maxBatch);
        try {
            const decoded = await postDeltaBatch(url, chunkItems, reg.getTimeoutMs());
            if (!decoded) {
                continue; // already logged; leave these hits unhydrated
            }
            assignDeltaData(chunkHits, decoded);
        } catch (e: any) {
            hLog(`[archive-hydration] ${url}/deltas failed: ${e?.message ?? e}`);
            // leave chunk unhydrated and continue with the next chunk
        }
    }
}

/**
 * Perform the POST and return the response `deltas` array, or `null` on any
 * problem (non-200, bad JSON, missing/short array). Throws only on transport
 * errors so the caller's try/catch can log a useful message.
 */
async function postDeltaBatch(
    url: string,
    items: ArchiveDeltaRequestItem[],
    timeoutMs: number
): Promise<ArchiveDeltaResponseItem[] | null> {
    const endpoint = `${url}/deltas`;
    const res = await undiciRequest(endpoint, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(items),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs
    });

    if (res.statusCode !== 200) {
        // Drain the body so the connection can be reused, then bail.
        try {
            await res.body.dump();
        } catch {
            // ignore drain errors
        }
        hLog(`[archive-hydration] ${endpoint} returned status ${res.statusCode}`);
        return null;
    }

    let payload: any;
    try {
        payload = await res.body.json();
    } catch (e: any) {
        hLog(`[archive-hydration] ${endpoint} returned non-JSON body: ${e?.message ?? e}`);
        return null;
    }

    const deltas = payload?.deltas;
    if (!Array.isArray(deltas)) {
        hLog(`[archive-hydration] ${endpoint} response missing 'deltas' array`);
        return null;
    }
    if (deltas.length !== items.length) {
        // Contract requires same-order, same-length. A mismatch means we cannot
        // safely map by index, so we discard the whole chunk.
        hLog(`[archive-hydration] ${endpoint} length mismatch: sent ${items.length}, got ${deltas.length}`);
        return null;
    }
    return deltas as ArchiveDeltaResponseItem[];
}

/**
 * Assign decoded payload back onto each delta hit by request order:
 *   found+data  -> src.data = data
 *   found+value -> src.value = value
 * Entries with `found:false` (or carrying neither field) are left untouched —
 * the cold doc keeps lacking both data and value, matching pre-hydration
 * behavior.
 */
function assignDeltaData(hits: DeltaHit[], decoded: ArchiveDeltaResponseItem[]): void {
    for (let i = 0; i < hits.length; i++) {
        const entry = decoded[i];
        const src = hits[i]?._source;
        if (!src || !entry || entry.found !== true) {
            continue;
        }
        if (entry.data !== undefined) {
            src.data = entry.data;
        } else if (entry.value !== undefined) {
            src.value = entry.value;
        }
        // found:false / neither field -> leave the hit untouched.
    }
}
