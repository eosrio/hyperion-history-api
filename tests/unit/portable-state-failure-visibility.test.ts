import {expect, test} from 'bun:test';
import type {ProjectionDefinition} from '@eosrio/hyperion-sdk/projection';
import {PortableStateController} from '../../src/indexer/projection/controller.js';
import {DeclarativeProjectionRuntime} from '../../src/indexer/projection/runtime.js';
import {admissionReason, projectionFailureApi, projectionFailureFixture} from './portable-state-failure-fixture.js';

const chainId = 'c'.repeat(64), checkpoint = {blockNum: 1, blockId: '1'.repeat(64)};
const target = {blockNum: 2, blockId: '2'.repeat(64), previousBlockId: checkpoint.blockId};
const definition: ProjectionDefinition = {schemaVersion: 1, id: 'items', mappingRevision: 'a'.repeat(64),
    source: {contract: 'items', table: 'rows', abiDeployment: 'same-epoch', abiSha256: 'b'.repeat(64)},
    fields: [{name: 'owner', path: ['owner'], type: 'string'}], initialization: {kind: 'genesis'}};
function source() {
    let value: unknown = {};
    return {setValue(next: unknown) {value = next;}, async frame(height: number) {
        expect(height).toBe(2); return {frame: {chainId, block: target, changes: [{...definition.source,
            scope: '', primaryKey: 'new-key', present: true, value}]}, proof: {} as any, evidence: {} as any};
    }, async revalidate() {}, async open() {return {} as any;}, async assertDefinition() {}};
}

test('failed detailed marker cannot reopen an admitted mapping failure; restart retries exact source and restores serving only after commit', async () => {
    const fixture = projectionFailureFixture(definition, chainId, checkpoint), selected = source(), progress: any[] = [];
    fixture.faults.rejectDetailedMarker = true;
    const controller = await PortableStateController.create({chainId, configuration: fixture.configuration, adapter: fixture.adapter,
        source: selected, maximumFramesPerProjection: 1, onProgress: value => progress.push(value)});
    const api = await projectionFailureApi(fixture, selected);
    try {
        expect((await api.query()).statusCode).toBe(200); // Later source remains unadmitted, so ordinary lag is still available.
        await controller.drain();
        const failed = await api.query();
        expect(failed.statusCode).toBe(503); expect(failed.json().retryable).toBe(true);
        expect(failed.headers['hyperion-state-last-valid']).toBeUndefined();
        expect(fixture.metadata().checkpoint).toEqual(checkpoint);
        expect(fixture.metadata().pending).toEqual({block: target, digest: null, reason: admissionReason});
        expect(fixture.calls.some(call => call.command === 'replace')).toBe(false);
        expect(progress.at(-1).status).toBe('incomplete');
        await controller.stop();
        const restarted = await PortableStateController.create({chainId, configuration: fixture.configuration, adapter: fixture.createAdapter(),
            source: selected, maximumFramesPerProjection: 1});
        await restarted.drain(); expect((await api.query()).statusCode).toBe(503);
        fixture.faults.rejectDetailedMarker = false; selected.setValue({owner: 'bob'});
        await restarted.drain();
        const recovered = await api.query(); expect(recovered.statusCode).toBe(200);
        expect(recovered.json().view.checkpoint).toEqual({blockNum: 2, blockId: target.blockId});
        expect(fixture.metadata().pending).toBeNull();
        await restarted.stop();
    } finally {await controller.stop(); await api.app.close();}
});

test('rejected admission stays ordinary unadmitted lag, while a lost receipt after persistence fences reads without mapping', async () => {
    for (const mode of ['reject', 'lost-receipt', 'cas-miss']) {
        const fixture = projectionFailureFixture(definition, chainId, checkpoint), selected = source();
        fixture.faults.rejectAdmission = mode === 'reject'; fixture.faults.loseAdmissionReceipt = mode === 'lost-receipt';
        fixture.faults.casMiss = mode === 'cas-miss';
        const controller = await PortableStateController.create({chainId, configuration: fixture.configuration, adapter: fixture.adapter,
            source: selected, maximumFramesPerProjection: 1});
        const api = await projectionFailureApi(fixture, selected);
        try {
            await controller.drain();
            expect((await api.query()).statusCode).toBe(mode === 'lost-receipt' ? 503 : 200);
            expect(fixture.calls.filter(call => call.command === 'findAndModify')).toHaveLength(1);
            expect(fixture.calls.some(call => call.command === 'replace')).toBe(false);
            expect(fixture.metadata().checkpoint).toEqual(checkpoint);
        } finally {await controller.stop(); await api.app.close();}
    }
});

test('default runtime duplicates remain receipt-based and production admission never changes the captured target or values', async () => {
    const fixture = projectionFailureFixture(definition, chainId, checkpoint), selected = source(); selected.setValue({owner: 'bob'});
    const runtime = await DeclarativeProjectionRuntime.create({adapter: fixture.adapter, definition, binding: fixture.binding,
        genesis: {blockNum: 0, blockId: '0'.repeat(64)}});
    const frame = (await selected.frame(2)).frame;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => {enter = resolve;}), held = new Promise<void>(resolve => {release = resolve;});
    const result = runtime.process(frame, async block => {
        expect(block).toEqual(target); enter(); await held;
        await fixture.adapter.markIncomplete(fixture.binding, block, admissionReason);
    });
    await entered; frame.block = {...target, blockId: 'f'.repeat(64)}; frame.changes[0].value = {owner: 'changed'}; release();
    expect((await result).status).toBe('applied');
    const original = (await selected.frame(2)).frame;
    expect((await runtime.process(original)).status).toBe('duplicate');
    expect(fixture.metadata().checkpoint.blockId).toBe(target.blockId);
    expect(fixture.rows().get('["","new-key"]').value).toEqual({owner: 'bob'});
    expect(fixture.calls.filter(call => call.command === 'findAndModify')).toHaveLength(2); // Admission and apply prepare only.
});

test('failed transactional completion retains the exact admitted source and known mutation digest across restart', async () => {
    const fixture = projectionFailureFixture(definition, chainId, checkpoint), selected = source(); selected.setValue({owner: 'bob'});
    fixture.faults.rejectCompletion = true;
    const controller = await PortableStateController.create({chainId, configuration: fixture.configuration, adapter: fixture.adapter,
        source: selected, maximumFramesPerProjection: 1});
    const api = await projectionFailureApi(fixture, selected);
    try {
        await controller.drain(); expect((await api.query()).statusCode).toBe(503);
        const durable = fixture.metadata(); expect(durable.checkpoint).toEqual(checkpoint);
        expect(durable.pending.block).toEqual(target); expect(durable.pending.digest).toMatch(/^[a-f0-9]{64}$/);
        expect(durable.pending.reason).toBe(admissionReason); expect(fixture.rows().has('["","new-key"]')).toBe(false);
        const restartedAdapter = fixture.createAdapter();
        expect((await restartedAdapter.recovery!(fixture.binding)).pending).toEqual(durable.pending);
    } finally {await controller.stop(); await api.app.close();}
});
