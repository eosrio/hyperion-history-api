import { describe, it, expect } from 'bun:test';
import { buildAccessLoggerOptions } from '../../src/api/helpers/access-logger.js';

// A stand-in for the fs.WriteStream — the factory only stores the reference.
const fakeStream = {} as any;

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

    it('req serializer captures method, url and the real client IP from x-real-ip', () => {
        const opts = buildAccessLoggerOptions(fakeStream);
        const serialized = opts.serializers.req({
            method: 'GET',
            url: '/v2/health',
            headers: { 'x-real-ip': '203.0.113.7', authorization: 'Bearer secret' }
        });
        expect(serialized).toEqual({
            method: 'GET',
            url: '/v2/health',
            ip: '203.0.113.7'
        });
    });

    it('req serializer leaves ip undefined when x-real-ip is absent', () => {
        const opts = buildAccessLoggerOptions(fakeStream);
        const serialized = opts.serializers.req({
            method: 'POST',
            url: '/v1/chain/get_info',
            headers: {}
        });
        expect(serialized.ip).toBeUndefined();
    });

    it('res serializer records only the status code', () => {
        const opts = buildAccessLoggerOptions(fakeStream);
        expect(opts.serializers.res({ statusCode: 200 })).toEqual({ statusCode: 200 });
    });
});
