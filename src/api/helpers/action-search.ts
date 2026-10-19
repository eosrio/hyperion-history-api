import {errors, estypes} from '@elastic/elasticsearch';
import {FastifyInstance, FastifyRequest} from 'fastify';

function searchError(statusCode: number, message: string) {
    return Object.assign(new Error(message), {statusCode});
}

/** Also call after asynchronous response shaping, before timedQuery can cache it. */
export function assertActionSearchActive(request: FastifyRequest) {
    if (request.raw.aborted || request.raw.socket?.destroyed) {
        throw searchError(503, 'Elasticsearch search was cancelled');
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
        if (result.timed_out) {
            throw searchError(503, 'Elasticsearch search timed out');
        }
        if (result._shards.failed > 0) {
            throw searchError(503, 'Elasticsearch search returned failed shards');
        }
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
