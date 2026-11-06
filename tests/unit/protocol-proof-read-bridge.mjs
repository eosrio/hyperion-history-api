/** Owned loopback document-GET bridge over the controlled ES fixture, not a real Elasticsearch server.
 * The pinned client performs every measured document request through an actual HTTP socket. Mapping
 * reads keep the existing fixture transport and are counted separately from these document GETs. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client} from '@elastic/elasticsearch';

export async function proofReadBridge(memory) {
    const original = memory.client.get;
    let active;
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1'), parts = url.pathname.split('/').map(decodeURIComponent);
        assert.equal(request.method, 'GET'); assert.equal(parts.length, 4); assert.equal(parts[2], '_doc');
        const input = {index: parts[1], id: parts[3], realtime: url.searchParams.get('realtime') === 'true',
            preference: url.searchParams.get('preference')};
        const measurement = active;
        try {
            const result = await original(input), body = JSON.stringify(result);
            measurement?.http.push({index: input.index, id: input.id, bytes: Buffer.byteLength(body),
                kind: result._source.kind, bundleId: result._source.bundle_id});
            response.writeHead(200, {'content-type': 'application/json', 'x-elastic-product': 'Elasticsearch'}); response.end(body);
        } catch (error) {
            const status = error.meta?.statusCode ?? 500, body = JSON.stringify(error.meta?.body ?? {error: {type: 'controlled_read', reason: error.message}});
            measurement?.http.push({index: input.index, id: input.id, bytes: Buffer.byteLength(body), status});
            response.writeHead(status, {'content-type': 'application/json', 'x-elastic-product': 'Elasticsearch'}); response.end(body);
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const transport = new Client({node: `http://127.0.0.1:${server.address().port}`, maxRetries: 0, requestTimeout: 10000});
    memory.client.get = async (request, options) => {
        if (!active) return original(request, options);
        active.logical.push(structuredClone(request)); return transport.get(request, options);
    };
    return {
        begin() {assert.equal(active, undefined); active = {logical: [], http: [], callOffset: memory.calls.length};},
        end() {
            assert(active); const result = active; active = undefined;
            const reads = memory.calls.slice(result.callOffset);
            return {...result, metadataReads: reads.filter(call => ['getIndex', 'getMapping', 'getSettings'].includes(call.method)).length,
                certificateManifests: result.http.filter(call => call.kind === 'manifest' && call.bundleId.startsWith('h45abicert1:')).length,
                commitManifests: result.http.filter(call => call.kind === 'manifest' && call.bundleId.startsWith('h45abicmt1:')).length,
                responseBytes: result.http.reduce((total, call) => total + call.bytes, 0)};
        },
        async close() {memory.client.get = original; await transport.close(); await new Promise(resolve => server.close(resolve));},
    };
}
