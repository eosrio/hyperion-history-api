/** Real DSPool constructor/cargo/processMessages, with inert protocol startup and controlled failed source I/O.
 * This is a native Antelope branch regression, not native-addon, broker or database qualification. */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';

const previous = process.cwd(), previousConfig = process.env.CONFIG_JSON, previousRole = process.env.worker_role;
const parent = resolve(tmpdir()), directory = mkdtempSync(join(parent, 'hyperion-action-cargo-failure-'));
const originalExit = process.exit;
const workers: any[] = [], restored: Array<() => void> = [];
const signals = new Map(['SIGINT', 'SIGTERM', 'message'].map(event => [event, new Set(process.listeners(event))]));
function gate() {let release!: () => void; const promise = new Promise<void>(done => {release = done;}); return {promise, release};}
async function ticks() {for (let index = 0; index < 5; index++) await new Promise<void>(done => setImmediate(done));}
async function until(check: () => boolean) {
    for (let index = 0; index < 500; index++) {if (check()) return; await new Promise<void>(done => setTimeout(done, 2));}
    assert.fail('Constructor cargo did not request supervised replacement');
}
class Consumer extends EventEmitter {
    acked: any[] = []; nacked = 0;
    ack(message: any) {this.acked.push(message);}
    nackAll() {this.nacked++;}
}
try {
    const chain = 'cargo-failure', config = {settings: {chain, parser: '3.2', eosio_alias: 'eosio', debug: false},
        indexer: {}, features: {}, scaling: {}, api: {}, whitelists: {actions: [], deltas: []}, plugins: {}, prefetch: {block: 1}};
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({amqp: {protocol: 'http'},
        elasticsearch: {host: '127.0.0.1:1', user: '', pass: ''},
        redis: {host: '127.0.0.1', port: 1, lazyConnect: true, enableOfflineQueue: false, retryStrategy: null},
        chains: {[chain]: {chain_id: '1'.repeat(64), http: 'http://127.0.0.1:1', ship: 'ws://127.0.0.1:1'}}}));
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json'); process.env.worker_role = 'ds_pool';
    const [{HyperionWorker}, {HyperionModuleLoader}, {default: Pool}, {actionSourceAdmissionHeader}] = await Promise.all([
        import('../../src/indexer/workers/hyperionWorker.js'), import('../../src/indexer/modules/loader.js'),
        import('../../src/indexer/workers/ds-pool.js'), import('../../src/indexer/history/action-source-admission.js')]);
    const replace = (owner: any, name: string, value: unknown) => {
        const original = owner[name]; owner[name] = value; restored.push(() => {owner[name] = original;});
    };
    // Leave the Pool constructor, its cargo callback and processMessages untouched.
    // The base startup boundaries do not connect or import the native decoder for this controlled I/O failure.
    replace(HyperionWorker.prototype, 'initializeProtocol', async function (this: any) {
        this.protocolId = 'antelope'; this.protocolComponents = []; this.protocol = {profileId: 'antelope-default-v1'};
    });
    replace(HyperionModuleLoader.prototype, 'init', async () => {});
    replace(HyperionWorker.prototype, 'connectAMQP', async () => {});
    replace(Pool.prototype, 'onConnect', () => {});
    const checks: any[] = [];
    for (const replacedConsumer of [false, true]) {
        const pool: any = new Pool(); workers.push(pool); await pool.protocolReady; await ticks();
        Object.defineProperty(pool, 'actionSourceAdmissionEnabled', {value: true});
        assert.equal(pool.usesExtensionProtocol, false);
        const original = new Consumer(), replacement = new Consumer(), publisher = new EventEmitter();
        Object.assign(pool, {ch: original, cch: publisher, ch_ready: true, cch_ready: true});
        const entered = gate(), release = gate(), failure = new Error('controlled source admission I/O unavailable');
        let resolutions = 0;
        pool.getActionAdmissionStore = () => ({async resolve() {resolutions++; entered.release(); await release.promise; throw failure;}});
        const first: any = {content: Buffer.from('{}'), properties: {headers: {[actionSourceAdmissionHeader]: 'h45actionadmission1:' + 'a'.repeat(64)}}, fields: {deliveryTag: 1}};
        const second = {...first, fields: {deliveryTag: 2}};
        pool.captureActionAdmissionDelivery(first, original); pool.captureActionAdmissionDelivery(second, original);
        const batches: any[][] = [], processMessages = pool.processMessages.bind(pool);
        pool.processMessages = async (messages: any[]) => {batches.push(messages); return processMessages(messages);};
        const exits: any[] = []; let callbacks = 0;
        process.exit = ((code?: number) => {exits.push(code);}) as never;
        pool.consumerQueue.push(first, () => {callbacks++;}); await entered.promise;
        pool.consumerQueue.push(second, () => {callbacks++;}); assert.equal(pool.consumerQueue.length(), 1);
        if (replacedConsumer) pool.ch = replacement;
        release.release(); await until(() => exits.length > 0); await ticks();
        assert.deepEqual(exits, [1]); assert.equal(pool.ch_ready, false);
        assert.equal(pool.consumerQueue.length(), 0, 'Supervised failure kills queued stale cargo');
        assert.equal(batches.length, 1, 'Cargo callback must not resume queued work after an admitted failure');
        assert.equal(resolutions, 1); assert.equal(callbacks, 0, 'Failed cargo must not settle through the legacy success callback');
        assert.deepEqual(original.acked, []); assert.deepEqual(replacement.acked, []);
        assert.equal(original.nacked, 0); assert.equal(replacement.nacked, 0, 'Replacement consumer must not own nackAll for old work');
        checks.push({replacedConsumer, supervisedExit: true, staleCargoDropped: true});
        pool.consumerQueue.kill(); pool.preIndexingQueue.kill(); pool.ioRedisClient.disconnect();
        await pool.manager.esIngestClient.close(); process.exit = originalExit;
    }
    console.log(JSON.stringify({passed: true, actualConstructorCargo: true, nativeProtocolPath: true,
        nativeQualification: false, checks}));
} finally {
    process.exit = originalExit; for (const restore of restored.reverse()) restore();
    for (const worker of workers) {
        worker.consumerQueue?.kill(); worker.preIndexingQueue?.kill(); worker.profiler?.stopReporting(); worker.ioRedisClient?.disconnect();
        await worker.manager?.esIngestClient?.close();
    }
    for (const [event, previousListeners] of signals) for (const listener of process.listeners(event))
        if (!previousListeners.has(listener)) process.off(event, listener);
    process.chdir(previous);
    if (previousConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = previousConfig;
    if (previousRole === undefined) delete process.env.worker_role; else process.env.worker_role = previousRole;
    const owned = resolve(directory); assert.equal(dirname(owned), parent); assert.match(basename(owned), /^hyperion-action-cargo-failure-/);
    rmSync(owned, {recursive: true, force: true});
}
