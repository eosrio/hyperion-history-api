import type { WriteStream } from 'fs';

/**
 * Resolves the real client IP from proxy headers, most-trusted first.
 *
 * Hyperion is typically fronted by Cloudflare (tunnel or proxy), which sends the
 * originating client address as `cf-connecting-ip`. Generic reverse proxies use
 * `x-forwarded-for` (a comma-separated chain whose FIRST entry is the client).
 * `x-real-ip` is checked last for setups that set it explicitly.
 *
 * NOTE: the previous version read ONLY `x-real-ip`, which Cloudflare's tunnel
 * does not send — so `ip` was empty for all real traffic on CF-fronted
 * deployments. Header precedence here fixes that without any config.
 */
export function resolveClientIp(headers: Record<string, any>): string | undefined {
  const cf = headers['cf-connecting-ip'];
  if (cf) return cf;
  const xff = headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  const xri = headers['x-real-ip'];
  if (xri) return xri;
  return undefined;
}

/**
 * Builds the pino logger options for the API access log.
 *
 * IMPORTANT: `prettyPrint` was removed in pino v7. Hyperion ships pino v10
 * (via fastify v5), so passing `prettyPrint: true` here silently produced NO
 * access-log output when `api.access_log` was enabled. This factory writes
 * structured NDJSON to the provided stream — the supported pino v10 path, and
 * easier to ship/parse downstream.
 *
 * The `req` serializer records the real client IP (see resolveClientIp) and,
 * when present, Cloudflare's `cf-ipcountry` geo hint — enough for a
 * country-level origin map downstream without a GeoIP database.
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
          ip: resolveClientIp(request.headers),
          country: request.headers['cf-ipcountry'],
        };
      },
    },
  };
}
