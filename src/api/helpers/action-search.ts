import {errors, estypes} from '@elastic/elasticsearch';
import {FastifyInstance, FastifyRequest} from 'fastify';
import {normalizeActionSequences} from '../../indexer/helpers/action-sequences.js';

function searchError(statusCode: number, message: string) {
    return Object.assign(new Error(message), {statusCode});
}

/** Also call after asynchronous response shaping, before timedQuery can cache it. */
export function assertActionSearchActive(request: FastifyRequest) {
    if (request.raw.aborted || request.raw.socket?.destroyed) {
        throw searchError(503, 'Elasticsearch search was cancelled');
    }
}

/** Shared by HTTP action queries and each historical stream page. */
export function assertCompleteActionSearch(result: {timed_out?: boolean; _shards?: {total?: number; successful?: number; failed?: number; skipped?: number}}): void {
    if (result.timed_out === true) throw searchError(503, 'Elasticsearch search timed out');
    const shards = result._shards;
    if (result.timed_out !== false || !shards
        || ![shards.total, shards.successful, shards.failed, shards.skipped].every(value => Number.isSafeInteger(value) && value! >= 0)
        || shards.failed !== 0 || shards.successful !== shards.total || shards.skipped! > shards.successful!) {
        throw searchError(503, 'Elasticsearch search returned incomplete shard metadata');
    }
}

/** Normalize only known metadata; an unsafe retained number cannot identify an exact occurrence. */
export function normalizeActionSearchSources(result: {hits: {hits: Array<{_source?: unknown}>}}): void {
    try {
        for (const hit of result.hits.hits) {
            if (hit._source !== undefined) normalizeActionSequences(hit._source as Record<string, any>);
        }
    } catch {
        throw searchError(503, 'Exact action sequence metadata is unavailable');
    }
}

/** Only complete action searches may become successful, cacheable API responses. */
export async function searchActions<T>(
    fastify: FastifyInstance,
    request: FastifyRequest,
    params: estypes.SearchRequest
): Promise<estypes.SearchResponse<T>> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const socket = request.raw.socket;

    // Fastify 5.8.5 request.signal listens to IncomingMessage "close", which also
    // fires after an ordinary POST body finishes. Socket close means the client
    // disconnected; "aborted" covers an interrupted incoming request instead.
    request.raw.once('aborted', abort);
    socket?.once('close', abort);
    try {
        assertActionSearchActive(request);
        const result = await fastify.elastic.search<T>(params, {signal: controller.signal});
        assertActionSearchActive(request);
        if (controller.signal.aborted) {
            throw searchError(503, 'Elasticsearch search was cancelled');
        }
        assertCompleteActionSearch(result);
        normalizeActionSearchSources(result);
        return result;
    } catch (error) {
        if (controller.signal.aborted || error instanceof errors.RequestAbortedError) {
            throw searchError(503, 'Elasticsearch search was cancelled');
        }
        if (error instanceof errors.TimeoutError) {
            throw searchError(504, 'Elasticsearch request timed out');
        }
        throw error;
    } finally {
        request.raw.removeListener('aborted', abort);
        socket?.removeListener('close', abort);
    }
}
