/** Synthetic protocol, actual coordinator/proof/parser/worker. No installed profile or transport qualification. */
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';

const hooks = registerHooks({resolve(specifier, context, next) {
    if (specifier.includes('node-abieos')) throw new Error('Synthetic native consumer resolved Antelope addon');
    // Execute the fixture's actual coordinator/stores from the same emitted modules as the worker.
    if (context.parentURL?.endsWith('/protocol-native-authorization-host-fixture.ts') && specifier.startsWith('../../src/'))
        return next(new URL(specifier.replace('../../src/', '../../build/'), context.parentURL).href, context);
    return next(specifier, context);
}});
const before = process.cwd(), send = process.send, directory = mkdtempSync(join(tmpdir(), 'hapi-native-worker-isolation-'));
process.send = (_message, callback) => {callback?.(null); return true;};
try {
    const {nativeAuthorizationFixture, chain, chainId, profile} = await import('./protocol-native-authorization-host-fixture.ts');
    const markInline = decisions => {
        const inline = decisions.find(decision => decision.origin.actionOrdinal === 3);
        inline.kind = 'native'; inline.nativeKind = 'opaque.synthetic-inline.v1';
    };
    const fixture = await nativeAuthorizationFixture({nativeActionInterfaceVersion: 1,
        mutateRecord(record) {markInline(record.observation.facts.decisions);}});
    fixture.faults.changeObserved = observation => markInline(observation.decisions);
    const decode = fixture.native.decodeValue.bind(fixture.native), encode = fixture.native.encodeValue.bind(fixture.native);
    fixture.native.decodeValue = (kind, raw) => kind === 'opaque.synthetic-inline.v1' ? {rawHex: Buffer.from(raw).toString('hex')} : decode(kind, raw);
    fixture.native.encodeValue = (kind, value) => kind === 'opaque.synthetic-inline.v1' ? Buffer.from(value.rawHex, 'hex') : encode(kind, value);
    const config = {settings: {chain, parser: '3.2', protocol: {provider: 'extension'}, eosio_alias: 'eosio', es_replicas: 0},
        indexer: {disable_indexing: false}, features: {contract_console: false, streaming: {traces: true}},
        scaling: {ad_idx_queues: 1}, whitelists: {actions: [], deltas: []}, api: {disable_tx_cache: false, tx_cache_mode: 'batch'}};
    mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'chain.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({chains: {[chain]: {chain_id: chainId}}}));
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
    const [{default: Pool}, {default: Parser}, {HyperionModuleLoader}, {protocolSourceSelectionHeader}] = await Promise.all([
        import('../../build/indexer/workers/ds-pool.js'), import('../../build/indexer/modules/parsers/3.2-parser.js'),
        import('../../build/indexer/modules/loader.js'), import('../../build/indexer/protocol/source-bindings.js')]);
    const filters = {action_blacklist: new Set(), action_whitelist: new Set(), delta_blacklist: new Set(), delta_whitelist: new Set()};
    const cm = {config, filters}, parser = new Parser(cm), loader = Object.create(HyperionModuleLoader.prototype);
    Object.assign(loader, {parser, handledActions: new Map(), handledDeltas: new Map(), plugins: []});
    let fault;
    loader.handledActions.set('*', new Map([['dispatch', async action => {
        if (action.action_ordinal !== 1) return;
        if (fault === 'value') action.act.data.rawHex = '99';
        if (fault === 'metadata') action.protocol.native.nativeKind = 'forged-kind';
        if (fault === 'nonportable') action.act.data = {value: 1n};
    }]]));
    const actions = [], streams = [], cache = [], acks = [];
    let cacheWait, cacheEntered;
    const channel = {ack(message) {acks.push(message);}, sendToQueue(_queue, payload) {actions.push(JSON.parse(payload)); return true;},
        publish(_exchange, _queue, payload) {streams.push(JSON.parse(payload)); return true;}};
    const pool = Object.create(Pool.prototype);
    Object.assign(pool, {chain, chainId, conf: config, configModule: cm, filters, mLoader: loader,
        protocol: fixture.provider, protocolId: profile.id, protocolComponents: profile.components,
        protocolReady: Promise.resolve(), client: fixture.client, ch: channel, ch_ready: true,
        profiler: {start: () => () => {}}, common: {attachActionExtras: Pool.prototype.attachActionExtras},
        protocolDeliveryOwners: new WeakMap(), poolAbiCache: new Map(), poolTypeCache: new Map(), protocolCacheViews: new Set(),
        temp_ds_counter: 0, actionDsCounter: 0, act_emit_idx: 1, allowStreaming: true, txCacheExpiration: 3600,
        ioRedisClient: {pipeline() {const entries = []; return {
            hset(key, values) {entries.push({key, values: new Map([...values].map(([key, value]) => [key, Buffer.from(value)]))}); return this;},
            expire() {return this;}, async exec() {if (cacheWait) {cacheEntered?.(); await cacheWait;} cache.push(...entries); return [];},
        };}}});
    Object.defineProperty(pool, 'actionSourceAdmissionEnabled', {value: false});
    const source = await fixture.observations.read(fixture.selected.abi.id);
    const transaction = JSON.parse(Buffer.from(source.capture.tracesHex, 'hex'))[0][1];
    transaction.signatures = [];
    const headers = {block_num: fixture.selected.source.blockNum, block_id: fixture.selected.source.blockId,
        producer: 'producer', ts: '2026-10-22T00:00:00.000', inline_count: 6, filtered: false, live: 'true',
        [protocolSourceSelectionHeader]: fixture.selected.selectionId};
    const consume = async () => {
        const message = {content: Buffer.from(JSON.stringify(transaction)), properties: {headers}};
        pool.captureProtocolActionDelivery(message, channel); await pool.processMessages([message]);
        assert.equal(acks.at(-1), message); return actions.slice(-4);
    };
    const complete = await consume();
    assert.equal(complete.length, 4); assert.deepEqual(complete.map(action => action.receipts.length), [2, 1, 1, 2]);
    assert.deepEqual(complete[0].act.data, {rawHex: '0102'}); assert.equal(complete[0].protocol.kind, 'native');
    assert.equal(complete[0].protocol.input.inputActionOrdinal, 1); assert.equal(complete[0].ds_error, undefined);
    assert.equal(complete[1].protocol.status, undefined); assert.equal(complete[1].protocol.schemaVersion, 2);
    assert.equal(complete[1].protocol.input.inputActionOrdinal, 3); assert.deepEqual(complete[1].act.data, {rawHex: '0102'});
    const incomplete = complete[3];
    assert.equal(incomplete.protocol.schemaVersion, 2); assert.equal(incomplete.protocol.kind, 'incomplete');
    assert.equal(incomplete.protocol.input.inputActionOrdinal, 5); assert.equal(incomplete.protocol.status, 'incomplete');
    assert.equal(incomplete.act.data, '04'); assert.equal(incomplete.ds_error, true);
    assert.deepEqual(incomplete.receipts.map(receipt => receipt.global_sequence), ['18446744073709551614', '18446744073709551615']);
    assert.equal(fixture.calls.contract, 0);
    for (const mode of ['value', 'metadata', 'nonportable']) {
        fault = mode; const output = await consume();
        assert.equal(output[0].protocol.schemaVersion, 2); assert.equal(output[0].protocol.kind, 'native');
        assert.equal(output[0].protocol.status, 'incomplete'); assert.equal(output[0].act.data, '0102');
        assert.equal(output[0].receipts.length, 2); assert.equal(output[0].ds_error, true);
        assert.equal(output[3].protocol.kind, 'incomplete'); assert.equal(output[3].receipts.length, 2);
        assert.deepEqual(output[1].act.data, {rawHex: '0102'}); assert.equal(output[1].protocol.status, undefined);
        assert.notEqual(output[0].protocol.native.nativeKind, 'forged-kind');
    }
    fault = undefined;
    fixture.faults.decodedValue = {rawHex: '0102', exactInteger: 1n};
    assert.equal(Buffer.from(encode('opaque.host-native.v1', fixture.faults.decodedValue)).toString('hex'), '0102');
    const nonportable = await consume();
    assert.equal(nonportable[0].protocol.status, 'incomplete'); assert.equal(nonportable[0].act.data, '0102');
    assert.equal(nonportable[0].receipts.length, 2);
    assert.equal(nonportable[1].protocol.status, undefined); assert.deepEqual(nonportable[1].act.data, {rawHex: '0102'});
    delete fixture.faults.decodedValue;
    assert.deepEqual(streams, actions);
    assert.equal(cache.length, 5);
    assert.equal(fixture.calls.contract, 0);
    // A native-aware canonical source cannot be downgraded to contract ABI decoding by omitting its capability.
    pool.protocol = {...fixture.provider, nativeActions: undefined};
    const markerStart = actions.length, missingCapability = {content: Buffer.from(JSON.stringify(transaction)), properties: {headers}};
    pool.captureProtocolActionDelivery(missingCapability, channel); await pool.processMessages([missingCapability]);
    const markedRaw = actions.slice(markerStart); assert.equal(markedRaw.length, 6);
    assert(markedRaw.every(action => action.ds_error === true && typeof action.act.data === 'string'
        && action.protocol.error.code === 'native_capability_unavailable'));
    assert.equal(fixture.calls.contract, 0); pool.protocol = fixture.provider;
    let enterCache, releaseCache;
    const entered = new Promise(resolve => {enterCache = resolve;}); cacheEntered = enterCache;
    cacheWait = new Promise(resolve => {releaseCache = resolve;});
    const ackBefore = acks.length;
    const message = {content: Buffer.from(JSON.stringify(transaction)), properties: {headers}};
    pool.captureProtocolActionDelivery(message, channel);
    const lateCache = pool.processMessages([message]); await entered;
    await fixture.revoke(); releaseCache();
    await assert.rejects(lateCache, error => error.statusCode === 503);
    assert.equal(acks.length, ackBefore);
    console.log(JSON.stringify({passed: true, syntheticProtocol: true, actualCoordinator: true, actualEmittedWorker: true,
        incompleteOriginIsolated: true, certifiedNotificationGrouping: true, independentInlineOrigin: true,
        unknownAbiIndependent: true, tamperedNativeRawIncomplete: true, publicSerializationIsolated: true,
        finalCacheRevocationFenced: true, canonicalCapabilityDowngradeRefused: true,
        nativeAbiFallback: false, liveQualification: false}));
} finally {
    process.send = send; process.chdir(before); hooks.deregister();
    const owned = resolve(directory); assert.equal(dirname(owned), resolve(tmpdir())); assert.match(basename(owned), /^hapi-native-worker-isolation-/);
    rmSync(owned, {recursive: true, force: true});
}
