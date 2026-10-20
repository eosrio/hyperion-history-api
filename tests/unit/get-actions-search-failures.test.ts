import {afterEach, describe, expect, it} from 'bun:test';
import Fastify, {type FastifyInstance} from 'fastify';
import {errors} from '@elastic/elasticsearch';
import {request as httpRequest} from 'node:http';
import registerV1 from '../../src/api/routes/v1-history/get_actions/index.js';
import registerV2 from '../../src/api/routes/v2-history/get_actions/index.js';

const servers: FastifyInstance[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()));
});

function searchResult(extra: Record<string, unknown> = {}) {
    return {
        took: 1,
        timed_out: false,
        _shards: {total: 2, successful: 2, failed: 0, skipped: 0},
        hits: {
            total: {value: 1, relation: 'eq'},
            hits: [{_source: {
                global_sequence: 1, block_num: 100, '@timestamp': '2026-10-19T01:00:00.000',
                trx_id: 'a'.repeat(64),
                act: {account: 'eosio.token', name: 'transfer', authorization: [], data: {from: 'alice', to: 'bob'}},
                receipts: [{receiver: 'alice', recv_sequence: 1, global_sequence: 1, auth_sequence: []}]
            }}]
        },
        ...extra
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return {promise, resolve};
}

async function within<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture event did not arrive')), 1000); })
        ]);
    } finally {
        clearTimeout(timer!);
    }
}

async function fixture(version: 1 | 2, search: (...args: any[]) => Promise<any>, getInfo?: () => Promise<any>) {
    const app = Fastify({logger: false});
    servers.push(app);
    const cache = new Map<string, string>();
    const cacheWrites: string[] = [];
    const routeErrors: Error[] = [];
    const nextError = deferred<Error>();
    app.decorate('manager', {
        chain: 'qualification', readIndexset: () => 'qualification-action-*',
        config: {api: {enable_caching: true, cache_life: 60, limits: {get_actions: 10}, query_timeout: '10s'}}
    });
    app.decorate('redis', {
        get: async (key: string) => cache.get(key) ?? null,
        set: async (key: string, value: string) => { cacheWrites.push(value); cache.set(key, value); return 'OK'; }
    });
    app.decorate('elastic', {search});
    app.decorate('antelope', {chain: {get_info: getInfo ?? (async () => ({last_irreversible_block_num: {toNumber: () => 99}}))}});
    app.decorate('allowedActionQueryParamSet', new Set());
    app.addHook('onError', (_request, _reply, error, done) => { routeErrors.push(error); nextError.resolve(error); done(); });
    await app.register(version === 1 ? registerV1 : registerV2, {prefix: `/v${version}/history`});
    await app.ready();
    const request = version === 1
        ? {method: 'POST' as const, url: '/v1/history/get_actions', payload: {account_name: 'alice'}}
        : {method: 'GET' as const, url: '/v2/history/get_actions?hydrate=false'};
    async function startHttp(extraQuery = '') {
        const address = await app.listen({host: '127.0.0.1', port: 0});
        const body = version === 1 ? JSON.stringify({account_name: 'alice'}) : undefined;
        const req = httpRequest(address + `/v${version}/history/get_actions?hydrate=false${extraQuery}`, {
            method: version === 1 ? 'POST' : 'GET',
            headers: body ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)} : {}
        });
        const response = new Promise<{status: number | undefined; body: any}>((resolve, reject) => {
            req.on('response', res => {
                let text = '';
                res.on('data', chunk => { text += chunk; });
                res.on('end', () => resolve({status: res.statusCode, body: JSON.parse(text)}));
            });
            req.on('error', reject);
        });
        // A destroyed client is intentional in cancellation controls.
        void response.catch(() => {});
        req.end(body);
        return {req, response};
    }
    return {app, request, cacheWrites, routeErrors, nextError, startHttp};
}

for (const version of [1, 2] as const) {
    describe(`v${version} get_actions search failures`, () => {
        for (const [kind, incomplete] of [
            ['timed out', {timed_out: true}],
            ['failed shard', {_shards: {total: 2, successful: 1, failed: 1, skipped: 0}}],
            ['missing shards', {_shards: undefined}],
            ['missing completion', {_shards: {failed: 0}}],
            ['inconsistent completion', {_shards: {total: 2, successful: 1, failed: 0, skipped: 0}}],
            ['malformed completion', {_shards: {total: 2, successful: 2, failed: -1, skipped: 0}}]
        ] as const) {
            it(`rejects ${kind} hits before response shaping or caching and can retry`, async () => {
                let calls = 0;
                const {app, request, cacheWrites} = await fixture(version, async () => {
                    calls++;
                    return searchResult(calls === 1 ? incomplete : {});
                });
                const failed = await app.inject(request);
                expect(failed.statusCode).toBe(503);
                expect(failed.json()).toMatchObject({statusCode: 503, error: 'Service Unavailable'});
                expect(failed.json().actions).toBeUndefined();
                expect(cacheWrites).toHaveLength(0);
                const recovered = await app.inject(request);
                expect(recovered.statusCode).toBe(200);
                expect(recovered.json().actions).toHaveLength(1);
                expect(calls).toBe(2);
                expect(cacheWrites).toHaveLength(1);
                expect((await app.inject(request)).statusCode).toBe(200);
                expect(calls).toBe(2);
            });
        }

        it('maps a transport timeout to 504 without caching it', async () => {
            const {app, request, cacheWrites} = await fixture(version, async () => { throw new errors.TimeoutError('fixture'); });
            const response = await app.inject(request);
            expect(response.statusCode).toBe(504);
            expect(response.json()).toMatchObject({statusCode: 504, error: 'Gateway Timeout'});
            expect(cacheWrites).toHaveLength(0);
        });

        it('maps a transport abort to 503 without caching it', async () => {
            const {app, request, cacheWrites} = await fixture(version, async () => { throw new errors.RequestAbortedError('fixture'); });
            const response = await app.inject(request);
            expect(response.statusCode).toBe(503);
            expect(cacheWrites).toHaveLength(0);
        });

        it('preserves an Elasticsearch ResponseError status and Fastify error envelope', async () => {
            const error = new errors.ResponseError({
                statusCode: 429,
                body: {status: 429, error: {type: 'es_rejected_execution_exception', reason: 'fixture'}},
                headers: {}, meta: {} as any
            });
            const {app, request, cacheWrites} = await fixture(version, async () => { throw error; });
            const response = await app.inject(request);
            expect(response.statusCode).toBe(429);
            expect(response.json()).toEqual({statusCode: 429, error: 'Too Many Requests', message: 'es_rejected_execution_exception'});
            expect(cacheWrites).toHaveLength(0);
        });

        it('does not cancel a healthy delayed HTTP request when its body has finished', async () => {
            const {startHttp, cacheWrites} = await fixture(version, async (_params, options) => {
                expect(options?.signal).toBeInstanceOf(AbortSignal);
                await new Promise(resolve => setTimeout(resolve, 20));
                expect(options.signal.aborted).toBe(false);
                return searchResult();
            });
            const {response} = await startHttp();
            const result = await within(response);
            expect(result.status).toBe(200);
            expect(result.body.actions).toHaveLength(1);
            expect(cacheWrites).toHaveLength(1);
        });

        it('aborts upstream search when the HTTP client disconnects', async () => {
            const started = deferred<void>();
            const aborted = deferred<void>();
            let signal: AbortSignal | undefined;
            const {startHttp, cacheWrites} = await fixture(version, async (_params, options) => {
                signal = options?.signal;
                started.resolve();
                await new Promise((resolve, reject) => {
                    signal?.addEventListener('abort', () => { aborted.resolve(); reject(new errors.RequestAbortedError('fixture')); }, {once: true});
                    // Bound failures on the old route, which does not pass a signal.
                    setTimeout(resolve, 150);
                });
                return searchResult();
            });
            const {req} = await startHttp();
            await within(started.promise);
            req.destroy();
            await within(aborted.promise);
            expect(signal?.aborted).toBe(true);
            expect(cacheWrites).toHaveLength(0);
        });

        it('discards a late response from a search that ignores cancellation', async () => {
            const started = deferred<void>();
            const release = deferred<void>();
            const {startHttp, cacheWrites, nextError} = await fixture(version, async () => {
                started.resolve();
                await release.promise;
                return searchResult();
            });
            const {req} = await startHttp();
            await within(started.promise);
            req.destroy();
            await new Promise(resolve => setTimeout(resolve, 20));
            release.resolve();
            await within(nextError.promise);
            expect(cacheWrites).toHaveLength(0);
        });

        it('does not cache a request disconnected during later chain-info work', async () => {
            const infoStarted = deferred<void>();
            const releaseInfo = deferred<void>();
            const {startHttp, cacheWrites, nextError} = await fixture(version, async () => searchResult(), async () => {
                infoStarted.resolve();
                await releaseInfo.promise;
                return {last_irreversible_block_num: {toNumber: () => 99}};
            });
            const {req} = await startHttp('&checkLib=true');
            await within(infoStarted.promise);
            req.destroy();
            await new Promise(resolve => setTimeout(resolve, 20));
            releaseInfo.resolve();
            await within(nextError.promise);
            expect(cacheWrites).toHaveLength(0);
        });
    });
}
