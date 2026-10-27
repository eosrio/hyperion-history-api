import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(root, '../..');
const temporary = await mkdtemp(join(tmpdir(), 'hapi-contextual-consumer-'));
assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
assert.ok(basename(temporary).startsWith('hapi-contextual-consumer-'));
const npm = process.env.npm_execpath; assert.ok(npm, 'Run through npm run test:package');
const run = (args, cwd) => execFileSync(process.execPath, [npm, ...args],
    {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 60000});
try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    run(['pack', '--pack-destination', temporary], root);
    const consumer = join(temporary, 'consumer'); await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), JSON.stringify({name: 'hapi-contextual-consumer', private: true, type: 'module',
        dependencies: {'@eosrio/hyperion-sdk': pkg.devDependencies['@eosrio/hyperion-sdk']},
        devDependencies: {'@types/node': pkg.devDependencies['@types/node']}}));
    run(['install', '--allow-git=all', '--include=dev', '--no-audit', '--no-fund', join(temporary, 'eosrio-hyperion-backend-mongodb-' + pkg.version + '.tgz')], consumer);
    const types = JSON.parse(await readFile(join(consumer, 'node_modules/@types/node/package.json'), 'utf8'));
    assert.equal(types.version, pkg.devDependencies['@types/node']);
    await writeFile(join(consumer, 'consumer.mts'), `
import {createMongoDbProjectionAdapter, createMongoDbRollbackAdapter, createMongoDbContextualRecoveryAdapter,
    type MongoDbRollbackAdapterOptions} from '@eosrio/hyperion-backend-mongodb';
import {CONTEXTUAL_PROJECTION_RECOVERY_HOST_CAPABILITIES, CONTEXTUAL_PROJECTION_RECOVERY_ADAPTER_CAPABILITIES,
    validateContextualProjectionRecoveryActivation, type ContextualProjectionDefinition,
    type ContextualProjectionRecoveryAdapter, type ProjectionRollbackAdapter} from '@eosrio/hyperion-sdk/projection';
if ([createMongoDbProjectionAdapter, createMongoDbRollbackAdapter, createMongoDbContextualRecoveryAdapter].some(value => typeof value !== 'function'))
    throw new Error('Installed adapter factories are missing');
const definition: ContextualProjectionDefinition = {schemaVersion:2,id:'installed',mappingRevision:'a'.repeat(64),
    source:{contract:'token',table:'items',abiDeployment:'deployment',abiSha256:'b'.repeat(64)},
    fields:[{name:'created',type:'string',source:{kind:'context',field:'blockNum',format:'decimal'}}],
    initialization:{kind:'genesis'},preserveOnReplace:['created'],onAbsent:'incomplete'};
const binding = {chainId:'c'.repeat(64),backendId:'installed',projectionId:definition.id,mappingRevision:definition.mappingRevision,
    abiDeployment:definition.source.abiDeployment,abiSha256:definition.source.abiSha256,generation:'instance'};
if (!validateContextualProjectionRecoveryActivation(definition,binding,
    {family:'contextual-table-recovery',interfaceVersion:1,supported:CONTEXTUAL_PROJECTION_RECOVERY_HOST_CAPABILITIES},
    {family:'contextual-table-recovery',interfaceVersion:1,supported:CONTEXTUAL_PROJECTION_RECOVERY_ADAPTER_CAPABILITIES}).valid)
    throw new Error('Installed exact SDK recovery family is unavailable');
function contextual(options: MongoDbRollbackAdapterOptions): ContextualProjectionRecoveryAdapter {
    return createMongoDbContextualRecoveryAdapter(options);
}
function legacy(options: MongoDbRollbackAdapterOptions): ProjectionRollbackAdapter {
    return createMongoDbRollbackAdapter(options);
}
function distinct(old: ProjectionRollbackAdapter): void {
    // @ts-expect-error Legacy capabilities and apply batches cannot silently become contextual recovery.
    const contextual: ContextualProjectionRecoveryAdapter = old;
    void contextual;
}
void contextual; void legacy; void distinct;
console.log('Installed legacy/contextual factories and exact SDK declarations passed; no database connection attempted.');
`);
    execFileSync(process.execPath, [join(repository, 'node_modules/typescript/bin/tsc'), '--strict',
        '--target', 'ES2022', '--lib', 'ES2022,ESNext.Disposable', '--types', 'node',
        '--module', 'NodeNext', 'consumer.mts'], {cwd: consumer, stdio: 'inherit', timeout: 60000});
    execFileSync(process.execPath, [join(consumer, 'consumer.mjs')], {cwd: consumer, stdio: 'inherit', timeout: 60000});
} finally {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith('hapi-contextual-consumer-'));
    await rm(temporary, {recursive: true, force: true});
}
