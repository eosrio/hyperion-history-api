import {describe, expect, it} from 'bun:test';
import {
    ACTION_SEQUENCE_NAMESPACE as namespace, actionSequenceMapping, ensureActionSequenceMappings,
    assertActionSequenceTemplateReadback, ensureActionSequenceWriteTemplate
} from '../../src/indexer/history/action-sequence-storage.js';

const first = 'fixture-action-v1-000001', second = 'fixture-action-v2-000001';
function fixture() {
    const mappings: any = {
        [first]: {mappings: {properties: {global_sequence: {type: 'long'}, receipts: {properties: {global_sequence: {type: 'long'}}}}}},
        [second]: {mappings: {properties: {global_sequence: {type: 'long'}, [namespace]: actionSequenceMapping()}}}
    };
    const settings: any = Object.fromEntries(Object.keys(mappings).map((index, i) => [index,
        {settings: {'index.uuid': 'generation-' + i, 'index.mapping.source.mode': 'stored',
            'index.default_pipeline': 'operator-default', 'index.final_pipeline': '_none'}}]));
    const writes: any[] = [], reads: any[] = [];
    const client: any = {indices: {
        resolveIndex: async (request: any) => {reads.push(request); return {indices: Object.keys(mappings).map(name => ({name, attributes: ['open']})), aliases: [], data_streams: []};},
        getMapping: async (request: any) => {reads.push(request); return {[request.index]: structuredClone(mappings[request.index])};},
        getSettings: async ({index}: any) => ({[index]: structuredClone(settings[index])}),
        putMapping: async (request: any) => {writes.push(request); mappings[request.index].mappings.properties[namespace] = structuredClone(request.properties[namespace]); return {acknowledged: true};},
        simulateIndexTemplate: async () => ({template: {settings: {'index.mapping.source.mode': 'stored'},
            mappings: {properties: {global_sequence: {type: 'long'}, [namespace]: actionSequenceMapping()}}}})
    }};
    return {client, mappings, settings, writes, reads};
}

describe('exact action sequence mapping initialization', () => {
    it('adds only missing namespaces, preserves old names/sort and retries idempotently with bounded field reads', async () => {
        const {client, writes, reads} = fixture();
        expect(await ensureActionSequenceMappings(client, 'fixture')).toEqual({inspected: 2, updated: 1});
        expect(writes).toEqual([{index: first, properties: {[namespace]: actionSequenceMapping()}}]);
        expect(await ensureActionSequenceMappings(client, 'fixture')).toEqual({inspected: 2, updated: 0});
        expect(writes).toHaveLength(1);
        expect(reads[0]).toMatchObject({name: 'fixture-action-*', expand_wildcards: ['open', 'hidden']});
        const request = reads.find(request => request.index === first);
        expect(request.filter_path).toContain('*.mappings.properties.' + namespace);
        expect(request.filter_path).not.toContain('*.mappings');
    });

    it('keeps blocked legacy partitions usable without requiring an additive write', async () => {
        const {client, writes, settings} = fixture();
        settings[first].settings['index.blocks.write'] = 'true';
        expect(await ensureActionSequenceMappings(client, 'fixture')).toEqual({inspected: 2, updated: 0});
        expect(writes).toEqual([]);
    });

    it('accepts actual Elasticsearch9.5.5 uppercase STORED defaults with no explicit source mode or _source mapping', async () => {
        const {client, settings, mappings} = fixture();
        for (const index of [first, second]) {
            delete settings[index].settings['index.mapping.source.mode'];
            settings[index].defaults = {'index.mapping.source.mode': 'STORED', 'index.default_pipeline': '_none',
                'index.final_pipeline': '_none', 'index.blocks.write': 'false'};
            expect(mappings[index].mappings._source).toBeUndefined();
        }
        expect(await ensureActionSequenceMappings(client, 'fixture')).toEqual({inspected: 2, updated: 1});
    });

    it.each(['synthetic', 'SYNTHETIC', 'disabled', 'DISABLED', 'Stored', 'stored ', 'unknown'])
    ('refuses unsupported effective source mode %s instead of normalizing unknown modes', async mode => {
        const {client, settings, writes} = fixture();
        delete settings[second].settings['index.mapping.source.mode'];
        settings[second].defaults = {'index.mapping.source.mode': mode};
        await expect(ensureActionSequenceMappings(client, 'fixture')).rejects.toThrow('stored _source');
        expect(writes).toEqual([]);
    });

    it('allows an empty fresh-install scope explicitly without inventing an index or changing settings', async () => {
        const {client, writes, reads} = fixture(); let requested: any;
        client.indices.resolveIndex = async (request: any) => {requested = request; return {indices: [], aliases: [], data_streams: []};};
        expect(await ensureActionSequenceMappings(client, 'fixture')).toEqual({inspected: 0, updated: 0});
        expect(requested).toMatchObject({allow_no_indices: true, ignore_unavailable: false});
        expect(writes).toEqual([]); expect(reads).toEqual([]);
    });

    it.each([
        (f: ReturnType<typeof fixture>) => {f.mappings[second].mappings.enabled = false;},
        (f: ReturnType<typeof fixture>) => {f.mappings[second].mappings._source = {enabled: false};},
        (f: ReturnType<typeof fixture>) => {f.mappings[second].mappings._source = {excludes: ['h45_sequences_v1*']};},
        (f: ReturnType<typeof fixture>) => {f.mappings[second].mappings._source = {includes: ['act.*']};},
        (f: ReturnType<typeof fixture>) => {f.settings[second].settings['index.mapping.source.mode'] = 'synthetic';},
        (f: ReturnType<typeof fixture>) => {f.settings[second].settings['index.final_pipeline'] = 'unqualified-final';},
        (f: ReturnType<typeof fixture>) => {f.mappings[second].mappings.properties[namespace].enabled = false;},
        (f: ReturnType<typeof fixture>) => {f.mappings[second].mappings.properties[namespace].dynamic = true;},
        (f: ReturnType<typeof fixture>) => {f.mappings[second].mappings.properties[namespace].properties.extra = {type: 'long'};},
        (f: ReturnType<typeof fixture>) => {f.mappings[second].mappings.properties[namespace].properties.global.properties.value.type = 'long';},
        (f: ReturnType<typeof fixture>) => {f.mappings[second].mappings.properties[namespace].properties.global.properties.value.ignore_malformed = true;},
        (f: ReturnType<typeof fixture>) => {f.mappings[second].mappings.properties[namespace].properties.global.properties.key.doc_values = false;},
        (f: ReturnType<typeof fixture>) => {f.mappings[second].mappings.properties[namespace].properties.receipts.properties.receiver.index = false;},
        (f: ReturnType<typeof fixture>) => {f.mappings[second].mappings.properties[namespace].properties.global.properties.key.normalizer = 'lowercase';},
        (f: ReturnType<typeof fixture>) => {f.mappings[second].mappings.properties[namespace].properties.global.properties.key.ignore_above = 10;},
        (f: ReturnType<typeof fixture>) => {f.mappings[second].mappings.properties.global_sequence.type = 'double';}
    ])('refuses incompatible identity/storage capabilities before altering any retained index', async mutate => {
        const f = fixture(); mutate(f);
        await expect(ensureActionSequenceMappings(f.client, 'fixture')).rejects.toThrow();
        expect(f.writes).toEqual([]);
    });

    it('rejects unowned names and data streams before accessing or updating them', async () => {
        const {client, writes, reads} = fixture();
        client.indices.resolveIndex = async () => ({indices: [{name: 'another-action-1', attributes: ['open']}], aliases: [], data_streams: []});
        await expect(ensureActionSequenceMappings(client, 'fixture')).rejects.toThrow('Unowned');
        expect(reads).toEqual([]); expect(writes).toEqual([]);
        client.indices.resolveIndex = async () => ({indices: [], aliases: [], data_streams: [{name: 'fixture-action-1'}]});
        await expect(ensureActionSequenceMappings(client, 'fixture')).rejects.toThrow('data stream');
    });

    it('requires acknowledged updates, exact readback and a stable index generation', async () => {
        let f = fixture(); f.client.indices.putMapping = async () => ({acknowledged: false});
        await expect(ensureActionSequenceMappings(f.client, 'fixture')).rejects.toThrow('not acknowledged');
        f = fixture(); f.client.indices.putMapping = async () => ({acknowledged: true});
        await expect(ensureActionSequenceMappings(f.client, 'fixture')).rejects.toThrow('readback');
        f = fixture(); const put = f.client.indices.putMapping;
        f.client.indices.putMapping = async (request: any) => {
            const response = await put(request); f.settings[first].settings['index.uuid'] = 'replacement'; return response;
        };
        await expect(ensureActionSequenceMappings(f.client, 'fixture')).rejects.toThrow('generation');
    });
});

describe('exact action sequence future template capabilities', () => {
    it('uses the actual named Elasticsearch index_templates response shape', () => {
        const response = {index_templates: [{name: 'fixture-action', index_template: {
            index_patterns: ['fixture-action-*'], priority: 200,
            template: {mappings: {properties: {[namespace]: actionSequenceMapping()}}}
        }}]};
        expect(() => assertActionSequenceTemplateReadback(response, 'fixture-action')).not.toThrow();
        expect(() => assertActionSequenceTemplateReadback(response, 'other-action')).toThrow('readback');
        expect(() => assertActionSequenceTemplateReadback({template: response.index_templates[0]}, 'fixture-action')).toThrow('readback');
        delete (response.index_templates[0].index_template.template.mappings.properties as any)[namespace];
        expect(() => assertActionSequenceTemplateReadback(response, 'fixture-action')).toThrow();
    });

    it('checks the effective future index template, including operator overrides, without changing settings', async () => {
        const {client} = fixture(); let requested = '';
        const simulate = client.indices.simulateIndexTemplate;
        client.indices.simulateIndexTemplate = async (request: any) => {requested = request.name; return simulate();};
        await ensureActionSequenceWriteTemplate(client, 'fixture-action-v1-000001');
        expect(requested).toBe('fixture-action-v1-000001');
        client.indices.simulateIndexTemplate = async () => ({template: {mappings: {properties: {global_sequence: {type: 'long'}, [namespace]: actionSequenceMapping()}},
            settings: {'index.final_pipeline': 'unqualified-final'}}});
        await expect(ensureActionSequenceWriteTemplate(client, 'fixture-action-v1-000001')).rejects.toThrow('pipeline');
    });
});
