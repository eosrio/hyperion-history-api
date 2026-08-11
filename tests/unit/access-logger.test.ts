import { describe, it, expect } from 'bun:test';
import { buildAccessLoggerOptions, resolveClientIp } from '../../src/api/helpers/access-logger.js';

// A stand-in for the fs.WriteStream — the factory only stores the reference.
const fakeStream = {} as any;

describe('resolveClientIp', () => {
    it('prefers cf-connecting-ip (Cloudflare tunnel/proxy)', () => {
        expect(resolveClientIp({
            'cf-connecting-ip': '203.0.113.7',
            'x-forwarded-for': '198.51.100.9, 10.0.0.1',
            'x-real-ip': '192.0.2.5'
        })).toBe('203.0.113.7');
    });

    it('falls back to the FIRST hop of x-forwarded-for', () => {
        expect(resolveClientIp({
            'x-forwarded-for': '198.51.100.9, 10.0.0.1, 10.0.0.2'
        })).toBe('198.51.100.9');
    });

    it('falls back to x-real-ip last', () => {
        expect(resolveClientIp({ 'x-real-ip': '192.0.2.5' })).toBe('192.0.2.5');
    });

    it('returns undefined when no client-ip header is present', () => {
        expect(resolveClientIp({})).toBeUndefined();
    });
});

describe('buildAccessLoggerOptions', () => {
    it('does NOT set prettyPrint (removed in pino v7; would silence the log on pino v10)', () => {
        const opts = buildAccessLoggerOptions(fakeStream);
        expect('prettyPrint' in opts).toBe(false);
    });

    it('writes to the provided stream at info level with auth redaction', () => {
        const opts = buildAccessLoggerOptions(fakeStream);
        expect(opts.stream).toBe(fakeStream);
        expect(opts.level).toBe('info');
        expect(opts.redact).toEqual(['req.headers.authorization']);
    });

    it('req serializer captures method, url, real client IP and cf country', () => {
        const opts = buildAccessLoggerOptions(fakeStream);
        const serialized = opts.serializers.req({
            method: 'GET',
            url: '/v2/health',
            headers: {
                'cf-connecting-ip': '203.0.113.7',
                'cf-ipcountry': 'US',
                authorization: 'Bearer secret'
            }
        });
        expect(serialized).toEqual({
            method: 'GET',
            url: '/v2/health',
            ip: '203.0.113.7',
            country: 'US'
        });
    });

    it('req serializer leaves ip/country undefined when the headers are absent', () => {
        const opts = buildAccessLoggerOptions(fakeStream);
        const serialized = opts.serializers.req({
            method: 'POST',
            url: '/v1/chain/get_info',
            headers: {}
        });
        expect(serialized.ip).toBeUndefined();
        expect(serialized.country).toBeUndefined();
    });

    it('res serializer records only the status code', () => {
        const opts = buildAccessLoggerOptions(fakeStream);
        expect(opts.serializers.res({ statusCode: 200 })).toEqual({ statusCode: 200 });
    });
});
