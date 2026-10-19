import {describe, expect, it} from 'bun:test';
import {createServer, type IncomingHttpHeaders} from 'node:http';
import {UndiciConnection} from '@elastic/elasticsearch';
import {ConnectionManager} from '../../src/indexer/connections/manager.class.js';
import {ConfigurationModule} from '../../src/indexer/modules/config.js';
import {esConnectionOptions} from '../../src/indexer/helpers/es-connection.js';
import type {HyperionConfig} from '../../src/interfaces/hyperionConfig.js';
import type {ESConfig, HyperionConnections} from '../../src/interfaces/hyperionConnections.js';

async function fakeElasticsearch(name: string) {
    const requests: {path: string; headers: IncomingHttpHeaders; body: string}[] = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push({path: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString()});
        response.setHeader('x-elastic-product', 'Elasticsearch');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(request.url?.startsWith('/_bulk') ? {
            took: 1,
            errors: false,
            items: [{index: {_index: name, _id: '1', status: 201}}]
        } : {name, version: {number: '9.5.5'}}));
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP address');
    return {
        host: `127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections();
        })
    };
}

function createManager(elasticsearch: Partial<ESConfig>) {
    // Exercise the real manager without loading operator configuration from disk.
    const configuration = Object.create(ConfigurationModule.prototype) as ConfigurationModule;
    configuration.config = {settings: {chain: 'test'}} as HyperionConfig;
    configuration.connections = {
        amqp: {},
        elasticsearch: {protocol: 'http', user: 'elastic', pass: 'test-password', ...elasticsearch}
    } as HyperionConnections;
    return new ConnectionManager(configuration);
}

async function closeManager(manager?: ConnectionManager) {
    if (manager) {
        await Promise.all([...new Set([manager.elasticsearchClient, ...manager.ingestClients])]
            .map(client => client.close()));
    }
}

describe('Elasticsearch ingest destinations', () => {
    it('sends each ingest client to its configured host and keeps reads on the default host', async () => {
        const targets = await Promise.all(['read', 'ingest-a', 'ingest-b'].map(fakeElasticsearch));
        let manager: ConnectionManager | undefined;
        try {
            const [read, first, second] = targets;
            manager = createManager({host: read.host, ingest_nodes: [first.host, second.host]});

            expect((await manager.elasticsearchClient.info()).name).toBe('read');
            expect(manager.ingestClients).toHaveLength(2);
            for (const [index, client] of manager.ingestClients.entries()) {
                for (let batch = 0; batch < 2; batch++) {
                    const result = await client.bulk({operations: [
                        {index: {_index: 'test', _id: '1'}}, {batch}
                    ]});
                    expect(result.items[0].index?._index).toBe(['ingest-a', 'ingest-b'][index]);
                }
            }

            expect(read.requests.map(request => request.path)).toEqual(['/']);
            for (const target of [first, second]) {
                expect(target.requests).toHaveLength(2);
                for (const request of target.requests) {
                    expect(request.path).toBe('/_bulk');
                    expect(request.headers.authorization).toBe(
                        `Basic ${Buffer.from('elastic:test-password').toString('base64')}`
                    );
                    expect(request.body).toContain('"_index":"test"');
                }
            }
        } finally {
            await closeManager(manager);
            await Promise.all(targets.map(target => target.close()));
        }
    });

    for (const ingest_nodes of [undefined, []]) {
        it(`falls back to the default client for ${ingest_nodes ? 'empty' : 'omitted'} ingest_nodes`, async () => {
            const target = await fakeElasticsearch('default');
            let manager: ConnectionManager | undefined;
            try {
                manager = createManager({host: target.host, protocol: undefined, ingest_nodes});
                expect(manager.ingestClients).toEqual([manager.elasticsearchClient]);
                expect((await manager.ingestClients[0].info()).name).toBe('default');
                expect(target.requests).toHaveLength(1);
            } finally {
                await closeManager(manager);
                await target.close();
            }
        });
    }

    it('preserves HTTPS, authentication and runtime transport options for each destination', async () => {
        const manager = createManager({
            protocol: 'https',
            host: '127.0.0.1:1',
            ingest_nodes: ['127.0.0.1:2', '127.0.0.1:3']
        });
        try {
            const expectedTransport = esConnectionOptions().Connection ?? UndiciConnection;
            const clients = [manager.elasticsearchClient, ...manager.ingestClients];
            expect(clients.map(client => client.connectionPool.connections[0].url.href)).toEqual([
                'https://127.0.0.1:1/', 'https://127.0.0.1:2/', 'https://127.0.0.1:3/'
            ]);
            for (const client of clients) {
                const connection = client.connectionPool.connections[0];
                expect(connection.tls?.rejectUnauthorized).toBe(false);
                expect(connection.headers.authorization).toBe(
                    `Basic ${Buffer.from('elastic:test-password').toString('base64')}`
                );
                expect(client.connectionPool.Connection).toBe(expectedTransport);
            }
        } finally {
            await closeManager(manager);
        }
    });

    for (const invalidTarget of ['', '127.0.0.1:invalid']) {
        it(`passes invalid target ${JSON.stringify(invalidTarget)} to the Elasticsearch client's URL validation`, () => {
            // connections.ref.json specifies host:port entries. As for the default
            // host, invalid URLs are rejected by Client rather than replaced silently.
            expect(() => createManager({host: '127.0.0.1:1', ingest_nodes: [invalidTarget]}))
                .toThrow('Invalid URL');
        });
    }
});
