import {expect, test} from 'bun:test';
import {CRASH_BOUNDARIES, classifyMongoCommand, matchesCrashBoundary, validateWorkerJob}
    from '../../scripts/qualification/projection-rollback-worker.mjs';
import {runRollbackWorker} from '../../scripts/qualification/projection-rollback.mjs';

const job = () => ({schemaVersion: 1, action: 'inspect', uri: 'mongodb://127.0.0.1:58321/?directConnection=true',
    databaseName: 'owned_fixture', collectionPrefix: 'h45_rollback', backendId: 'fixture-backend', definition: {}, binding: {}});

test('native child launch requires successful resource ownership proof before parsing or connecting', async () => {
    const children = new Set();
    await expect(runRollbackWorker(job(), {children})).rejects.toThrow('prove ownership');
    let checked = 0;
    await expect(runRollbackWorker({...job(), uri: 'mongodb://operator:27017'}, {children, assertOwned() {
        checked++; throw new Error('Owned fixture identity changed');
    }})).rejects.toThrow('Owned fixture identity changed');
    expect(checked).toBe(1);
    expect(children.size).toBe(0);
});

test('crash child rejects default/remote/authenticated endpoints and storage override injection', () => {
    expect(validateWorkerJob(job())).toEqual(job());
    expect(validateWorkerJob({...job(), uri: 'mongodb://127.0.0.1:58321/?replicaSet=hyp45p21&directConnection=true'}).databaseName)
        .toBe('owned_fixture');
    for (const uri of ['mongodb://127.0.0.1:27017', 'mongodb://localhost:58321', 'mongodb://10.0.0.1:58321',
        'mongodb://user:secret@127.0.0.1:58321', 'mongodb://127.0.0.1:58321/operator',
        'mongodb://127.0.0.1:58321/?directConnection=false',
        'mongodb://127.0.0.1:58321/?directConnection=true&directConnection=false',
        'mongodb://127.0.0.1:58321/?authSource=admin', 'mongodb+srv://127.0.0.1:58321'])
        expect(() => validateWorkerJob({...job(), uri})).toThrow();
    for (const fields of [{databaseName: undefined}, {collectionPrefix: undefined}, {backendId: ''},
        {databaseName: 'unsafe.name'}, {collectionPrefix: '$unsafe'}, {adapterOptions: {databaseName: 'operator'}},
        {adapterOptions: {client: {}}}, {adapterOptions: {rollbackRetentionBlocks: 0}}, {adapterOptions: []},
        {crash: 'arbitrary-boundary'}, {action: 'drop'}]) expect(() => validateWorkerJob({...job(), ...fields})).toThrow();
});

test('durable barriers classify only this fixture metadata and the required write shape', () => {
    const event = (name: string, command: object, databaseName = 'fixture') => ({commandName: name, command, databaseName});
    const classify = (value: object) => classifyMongoCommand(value, 'fixture', 'h45_rollback');
    expect(classify(event('findAndModify', {findAndModify: 'h45_rollback_metadata', update: {$set: {pending: {digest: 'a'.repeat(64)}}}})))
        .toBe('apply-intent');
    expect(classify(event('findAndModify', {findAndModify: 'h45_rollback_metadata', update: {$set: {revision: 'b'.repeat(64), rollback: {status: 'running'}}}})))
        .toBe('rollback-intent');
    expect(classify(event('update', {update: 'h45_rollback_metadata', updates: [{u: {$set: {checkpoint: {}, undo: []}}}]})))
        .toBe('apply');
    for (const status of ['running', 'complete'])
        expect(classify(event('update', {update: 'h45_rollback_metadata', updates: [{u: {$set: {checkpoint: {}, undo: [], rollback: {status}}}}]})))
            .toBe('rollback-step');
    for (const value of [
        event('findAndModify', {findAndModify: 'h45_rollback_metadata', update: {$set: {pending: {digest: null}}}}),
        event('findAndModify', {findAndModify: 'h45_rollback_metadata', update: {$set: {pending: {digest: 'a'.repeat(64)}}}}, 'operator'),
        event('findAndModify', {findAndModify: 'operator_metadata', update: {$set: {revision: 'a', rollback: {}}}}),
        event('update', {update: 'h45_rollback_records', updates: [{u: {$set: {checkpoint: {}, undo: []}}}]}),
        event('update', {update: 'h45_rollback_metadata', updates: [{u: {$set: {checkpoint: {}}}}]}),
        event('delete', {delete: 'h45_rollback_metadata'}),
    ]) expect(classify(value)).toBeUndefined();
});

test('crash matrix separates prepare, transaction send, durable commit and undo progress', () => {
    const examples = [
        ['after-apply-intent', 'apply-intent', 'succeeded'],
        ['before-apply-commit', 'apply', 'commit-started'],
        ['after-apply-commit', 'apply', 'commit-succeeded'],
        ['after-rollback-intent', 'rollback-intent', 'succeeded'],
        ['after-rollback-step', 'rollback-step', 'commit-succeeded'],
    ];
    expect(CRASH_BOUNDARIES).toContain('after-result');
    for (const [boundary, phase, stage] of examples) {
        expect(matchesCrashBoundary(boundary, phase, stage)).toBe(true);
        for (const other of CRASH_BOUNDARIES.filter((value: string) => value !== boundary))
            expect(matchesCrashBoundary(other, phase, stage)).toBe(false);
        expect(matchesCrashBoundary(boundary, 'unrelated', stage)).toBe(false);
    }
});
