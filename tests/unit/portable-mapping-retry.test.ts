import {expect, test} from 'bun:test';
import type {ProjectionDefinition} from '@eosrio/hyperion-sdk/projection';
import {PortableStateController} from '../../src/indexer/projection/controller.js';
import {projectionFailureApi, projectionFailureFixture} from './portable-state-failure-fixture.js';

test('emitted controller/runtime eligibility and original Wire controls pass under native Node', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--test',
        'tests/unit/portable-mapping-retry-native.mjs'], {stdout: 'pipe', stderr: 'pipe'});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr}).toEqual({code: 0, stderr: ''});
    expect(stdout).toContain('fail 0');
}, 60000);

const chainId = 'c'.repeat(64), checkpoint = {blockNum: 1, blockId: '1'.repeat(64)};
const block = {blockNum: 2, blockId: '2'.repeat(64), previousBlockId: checkpoint.blockId};
const definition: ProjectionDefinition = {schemaVersion: 1, id: 'items', mappingRevision: 'a'.repeat(64),
    source: {contract: 'items', table: 'rows', abiDeployment: 'same-epoch', abiSha256: 'b'.repeat(64)},
    fields: [{name: 'owner', path: ['owner'], type: 'string'}], initialization: {kind: 'genesis'}};

test('eligibility preserves actual Mongo adapter/API unavailability and never caches a source or advances completion', async () => {
    const fixture = projectionFailureFixture(definition, chainId, checkpoint);
    let calls = 0, value: unknown = {};
    const source = {async frame(height: number) {calls++; expect(height).toBe(2);
        return {frame: {chainId, block, changes: [{...definition.source, scope: '', primaryKey: 'new-key', present: true, value}]},
            proof: {} as any, evidence: {} as any};
    }, async revalidate() {}, async open() {return {} as any;}, async assertDefinition() {}};
    const controller = await PortableStateController.create({chainId, configuration: fixture.configuration,
        adapter: fixture.adapter, source, maximumFramesPerProjection: 1, mappingRetryEligibilityMs: 1000});
    const api = await projectionFailureApi(fixture, source);
    try {
        await controller.drain();
        value = {owner: 'bob'};
        await controller.drain(); expect(calls).toBe(1);
        const unavailable = await api.query(); expect(unavailable.statusCode).toBe(503);
        expect(unavailable.json().retryable).toBe(true); expect(unavailable.headers['hyperion-state-last-valid']).toBeUndefined();
        expect(fixture.metadata().checkpoint).toEqual(checkpoint); expect(fixture.metadata().pending.block).toEqual(block);
        expect(fixture.rows().has('["","new-key"]')).toBe(false);
        controller.invalidateMappingRetryEligibility();
        await controller.drain(); expect(calls).toBe(2);
        expect((await api.query()).statusCode).toBe(200);
        expect(fixture.metadata().checkpoint).toEqual({blockNum: 2, blockId: block.blockId});
        expect(fixture.metadata().pending).toBeNull(); expect(fixture.rows().get('["","new-key"]').value).toEqual({owner: 'bob'});
    } finally {await controller.stop(); await api.app.close();}
});

test('actual Mongo failure-marker rejection remains an immediate retry with the source admission durably pending', async () => {
    const fixture = projectionFailureFixture(definition, chainId, checkpoint); fixture.faults.rejectDetailedMarker = true;
    let calls = 0;
    const source = {async frame() {calls++;
        return {frame: {chainId, block, changes: [{...definition.source, scope: '', primaryKey: 'new-key', present: true, value: {}}]},
            proof: {} as any, evidence: {} as any};
    }, async revalidate() {}, async open() {return {} as any;}, async assertDefinition() {}};
    const controller = await PortableStateController.create({chainId, configuration: fixture.configuration,
        adapter: fixture.adapter, source, maximumFramesPerProjection: 1, mappingRetryEligibilityMs: 1000});
    const api = await projectionFailureApi(fixture, source);
    try {
        await controller.drain(); await controller.drain(); expect(calls).toBe(2);
        expect((await api.query()).statusCode).toBe(503); expect(fixture.metadata().checkpoint).toEqual(checkpoint);
        expect(fixture.metadata().pending.reason).toBe('Canonical projection source admitted; durable application is pending');
    } finally {await controller.stop(); await api.app.close();}
});
