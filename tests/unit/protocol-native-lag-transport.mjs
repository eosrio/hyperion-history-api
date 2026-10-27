/** #277 diagnostic transport. Real-ES mode forwards every decision-bearing read/write to the pinned client.
 * The local mirror is used only by fixture inventory/report helpers; it never answers a production store read. */
import assert from 'node:assert/strict';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

export async function proofMeasurementTransport({chain, url}) {
    if (!url) return {...frontierMemoryClient(), kind: 'controlled-memory', async close() {}};
    assert.match(chain, /^h45proof277-[a-z0-9-]{8,48}$/, 'real ES diagnostics require an owned unique chain prefix');
    const endpoint = new URL(url);
    assert.equal(endpoint.username, ''); assert.equal(endpoint.password, ''); assert.equal(endpoint.search, '');
    const {Client} = await import('@elastic/elasticsearch');
    const transport = new Client({node: endpoint.toString(), requestTimeout: 10000});
    let info;
    try {
        info = await transport.info();
        assert.equal(info.version.number, '9.5.5', 'this diagnostic qualifies the selected 9.5.5 server only');
        assert.equal(await transport.indices.exists({index: chain + '-*', expand_wildcards: 'all', allow_no_indices: false}), false,
            'the complete owned namespace must be fresh before any diagnostic write');
    } catch (error) {await transport.close(); throw error;}
    const documents = new Map(), mappings = new Map(), settings = new Map(), calls = [], faults = {}, ownedIndices = [];
    const key = (index, id) => index + '\0' + id;
    const note = (method, request) => calls.push({method, request: structuredClone(request)});
    const client = {
        indices: {
            async get(request, options) {
                note('getIndex', request); const result = await transport.indices.get(request, options);
                return faults.metadata?.(result, request) ?? result;
            },
            async create(request, options) {
                assert(request.index.startsWith(chain + '-'), 'diagnostic writes must stay inside the owned namespace');
                note('createIndex', request);
                const result = await transport.indices.create(request, options);
                if (result.acknowledged && result.index === request.index) {
                    ownedIndices.push(request.index); mappings.set(request.index, structuredClone(request.mappings ?? {}));
                }
                return result;
            },
            async getMapping(request, options) {
                note('getMapping', request); const result = await transport.indices.getMapping(request, options);
                return faults.mapping?.(result, request) ?? result;
            },
            async getSettings(request, options) {
                note('getSettings', request); const result = await transport.indices.getSettings(request, options);
                return faults.settings?.(result, request) ?? result;
            },
            exists: (request, options) => transport.indices.exists(request, options),
        },
        async create(request, options) {
            assert(request.index.startsWith(chain + '-')); note('create', request);
            const result = await transport.create(request, options);
            documents.set(key(request.index, request.id), {document: structuredClone(request.document), seq: result._seq_no, primaryTerm: result._primary_term});
            return result;
        },
        async index(request, options) {
            assert(request.index.startsWith(chain + '-')); note('index', request);
            const result = await transport.index(request, options);
            documents.set(key(request.index, request.id), {document: structuredClone(request.document), seq: result._seq_no, primaryTerm: result._primary_term});
            return result;
        },
        async get(request, options) {
            note('get', request); await faults.beforeRead?.(request);
            const result = await transport.get(request, options);
            await faults.afterRead?.(result, request);
            return faults.read?.(result, request) ?? result;
        },
        search: (request, options) => transport.search(request, options),
    };
    return {kind: 'actual-elasticsearch', serverVersion: info.version.number, serverBuildHash: info.version.build_hash,
        clusterUuid: info.cluster_uuid, client, documents, mappings, settings, calls, faults, key, ownedIndices,
        async initializeTarget(index) {
            assert.equal(await transport.indices.exists({index}), false, 'owned target must be fresh');
            await client.indices.create({index, settings: {number_of_shards: 1, number_of_replicas: 0, 'translog.durability': 'request',
                auto_expand_replicas: 'false', default_pipeline: '_none', final_pipeline: '_none'},
                mappings: {_meta: {hyperion_kind: 'hapi277-owned-action-target', schema_version: 1}}});
            const response = await transport.indices.getSettings({index, flat_settings: true});
            assert.equal(Object.keys(response).length, 1);
            assert(response[index].settings['index.uuid']);
            settings.set(index, response[index].settings);
        },
        async close() {await transport.close();},
    };
}
