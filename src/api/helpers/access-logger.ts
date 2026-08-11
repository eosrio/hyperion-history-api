import type { WriteStream } from 'fs';

/**
 * Builds the pino logger options for the API access log.
 *
 * IMPORTANT: `prettyPrint` was removed in pino v7. Hyperion ships pino v10
 * (via fastify v5), so passing `prettyPrint: true` here silently produced NO
 * access-log output when `api.access_log` was enabled. This factory writes
 * structured NDJSON to the provided stream — the supported pino v10 path, and
 * easier to ship/parse downstream.
 *
 * The `req` serializer records the real client IP from the `x-real-ip` header
 * (set by the upstream proxy / tunnel; fastify runs with trustProxy).
 */
export function buildAccessLoggerOptions(stream: WriteStream) {
  return {
    stream,
    redact: ['req.headers.authorization'],
    level: 'info',
    serializers: {
      res: (reply: { statusCode: any }) => {
        return {
          statusCode: reply.statusCode,
        };
      },
      req: (request: any) => {
        return {
          method: request.method,
          url: request.url,
          ip: request.headers['x-real-ip'],
        };
      },
    },
  };
}
