import {HttpConnection} from '@elastic/elasticsearch';

/**
 * Returns extra options to spread into `new Client(...)` that select the
 * transport connection implementation.
 *
 * Background: Bun's built-in `undici` Pool/Client are currently unimplemented
 * stubs (see bun#27338), so `@elastic/elasticsearch`'s default
 * `UndiciConnection` throws `TypeError: undefined is not an object
 * (evaluating 'response.headers')` on Bun. The workaround is to use the
 * `HttpConnection` (node:http) implementation instead.
 *
 * Selection logic:
 *  - Force ON  when `process.env.ES_HTTP_CONNECTION === '1'`.
 *  - Force OFF when `process.env.ES_HTTP_CONNECTION === '0'` (even on Bun).
 *  - Otherwise, auto-enable on Bun (`process.versions.bun` is defined).
 *  - On Node with no override -> returns `{}` (byte-identical to today: undici).
 *
 * When enabled, also pins a keep-alive agent with a generous socket pool so the
 * node:http path can sustain bulk-ingest concurrency.
 */
export function esConnectionOptions(): Record<string, unknown> {
    const override = process.env.ES_HTTP_CONNECTION;

    let useHttpConnection: boolean;
    if (override === '1') {
        useHttpConnection = true;
    } else if (override === '0') {
        useHttpConnection = false;
    } else {
        useHttpConnection = typeof process.versions.bun === 'string';
    }

    if (!useHttpConnection) {
        return {};
    }

    return {
        Connection: HttpConnection,
        agent: {
            keepAlive: true,
            maxSockets: 256
        }
    };
}
