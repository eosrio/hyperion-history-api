import {EventEmitter} from 'node:events';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, basename} from 'node:path';
import Fastify from 'fastify';
import assert from 'node:assert/strict';
import {preparedStatefulInputs, capture} from './portable-state-source-fixture.mjs';
import {definition, limits} from '../../packages/backend-mongodb/tests/stateful-fixture.mjs';
import {ownerFixture} from '../../packages/backend-mongodb/tests/stateful-owner-v2-fixture.mjs';
import {completeFixture, totals, offer} from '../../packages/backend-mongodb/tests/stateful-complete-kind-fixture.mjs';
import {retainedCall,retainedMark,retainedCounter,retainedFixtureCopyObserver,observeRetainedMethod} from '../native/retained-workload-progress.mjs';

const code = process.versions.bun ? '../../src/' : '../../build/';
const load = path => import(new URL(code + path, import.meta.url));
const {HyperionModuleLoader} = await load('indexer/modules/loader.js');
const {StatefulProjectionRegistryV2} = await load('indexer/projection/stateful-registry.js');
const {StatefulProjectionControllerV2} = await load('indexer/projection/stateful-controller.js');
const {createStatefulCandidateCustodyV2} = await load('indexer/projection/stateful-custody.js');
const {StatefulApiProbeClient, StatefulWorkerProbeBroker} = await load('indexer/projection/stateful-control.js');
const {WorkerAttemptSupervisor, describeWorkerAttemptEnd} = await load('indexer/protocol/worker-attempt-supervisor.js');
const {WorkerAttemptClient} = await load('indexer/protocol/worker-attempt-client.js');
const {default: ProjectionWorker} = await load('indexer/workers/projection.js');
const {installStatefulApiHostV2} = await load('api/helpers/stateful-owner.js');
const {resolveStatefulOwnerConfigurationV2} = await load('indexer/projection/stateful-config.js');

/** Actual emitted/source host and worker methods, with explicit native-command and transport fixtures. */
export async function statefulHostFixture({timeoutMs = 1000, hooks = {}, requiredSourceCapabilities = [], preparedSource,
    pluginDirectory, pluginConfiguration, projectionId, through = 3, completeKind = false} = {}) {
    const {p} = preparedSource ? {p: preparedSource} : await preparedStatefulInputs();
    retainedMark('before','host.initialize',{through});
    observeRetainedMethod(p.source,'statefulBlock','source.stateful-block',args=>args[0]);
    observeRetainedMethod(p.source,'open','proof.open',args=>args[0]?.blockNum);
    observeRetainedMethod(p.source,'revalidate','proof.revalidate');
    observeRetainedMethod(p.source,'assertStatefulView','proof.stateful-view');
    retainedCounter('fixture.frontier.calls',()=>p.memory.calls.length);
    const rawConfiguration = {interfaceVersion: 2, sourceInputVersion: 2,
        backend: {kind: 'mongodb', id: 'stateful-fixture', database: 'stateful_fixture'}, recovery: {bytes: 8 * 1024 * 1024},
        api: {timeoutMs, maximumPendingProbes: 8}};
    const configuration = resolveStatefulOwnerConfigurationV2(rawConfiguration);
    const selected = definition(), {binding: _suppliedBinding, ...template} = selected;
    if (projectionId) selected.id = projectionId;
    template.selectors = [{id: 'update', kind: 'action', contract: 'target', name: 'update'},
        {id: 'records', kind: 'table', contract: 'target', name: 'records'}];
    const tempParent = pluginDirectory ? realpathSync(new URL('../../out/', import.meta.url)) : realpathSync(tmpdir());
    const pluginRoot = mkdtempSync(join(tempParent, 'hapi-stateful-plugin-'));
    mkdirSync(join(pluginRoot, 'entry', 'build'), {recursive: true});
    writeFileSync(join(pluginRoot, '.state.json'), JSON.stringify({plugins: {entry: {enabled: true}}}));
    if (pluginDirectory) cpSync(pluginDirectory, join(pluginRoot, 'entry'), {recursive: true});
    else {
    writeFileSync(join(pluginRoot, 'entry', 'package.json'), JSON.stringify({name: 'stateful-host-component', version: '1.0.0', type: 'module'}));
    writeFileSync(join(pluginRoot, 'entry', 'build', 'index.js'), `export default class Plugin {
        constructor(options) {this.options = options; this.internalPluginName = 'stateful-component';}
        getStatefulProjectionsV2(context) {
            if(this.options.requiredSourceCapabilities.some(capability=>!context.sourceCapabilities.includes(capability)))
                throw new Error('Required source capability is missing');
            return {interfaceVersion:2,sourceInputVersion:2,projections:[{
            definition:this.options.template,limits:this.options.limits,requiredSourceCapabilities:this.options.requiredSourceCapabilities,reduce:async port => {
                port.put('collection','last',{height:port.source.block.blockNum,occurrences:port.source.inputs.length});
            },...(this.options.requiredCompleteKindRead?{requiredCompleteKindRead:this.options.requiredCompleteKindRead}:{})}]};}
    }`);
    }
    const cm = {config: {settings: {chain: p.options.chain, parser: '3.2'}, indexer: {},
        features: {index_transfer_memo: true, stateful_owner_v2: rawConfiguration}, plugins: {entry: pluginConfiguration ?? {enabled: true, template, limits: limits(), requiredSourceCapabilities,
            ...(completeKind ? {requiredCompleteKindRead: offer(totals())} : {})}}},
        connections: {chains: {[p.options.chain]: {chain_id: capture.chainId}}}, filters: {action_blacklist: new Set(), action_whitelist: new Set(),
            delta_blacklist: new Set(), delta_whitelist: new Set()}};
    const previousConfig = process.env.CONFIG_JSON;
    process.env.CONFIG_JSON = join(pluginRoot, 'chain.json'); writeFileSync(process.env.CONFIG_JSON, JSON.stringify(cm.config));
    const loader = new HyperionModuleLoader(cm, pluginRoot); await retainedCall('host.loader',undefined,()=>loader.init());
    assert.equal(loader.statefulPluginsV2().length, 1);
    const storage = completeKind ? completeFixture() : ownerFixture();
    storage.copyObserver=retainedFixtureCopyObserver();
    retainedCounter('fixture.native.commands',()=>storage.native.length);
    const registry = await retainedCall('host.registry-create',undefined,()=>StatefulProjectionRegistryV2.create({chainId: capture.chainId, configuration, mongo: storage.client,
        ...(completeKind ? {completeKindMongo: async () => storage.client} : {}),
        client: p.options.client, source: p.source, profile: p.options.profile, onError: (_id, error) => {throw error;}}, loader));
    await retainedCall('host.materialize-initialize',undefined,()=>registry.initializeMissing());
    const entry = registry.entries.get(selected.id); assert(entry, 'actual host registry must resolve and capture the loaded template');
    const {declaration, adapter} = entry, native = {adapter, storage};
    const parent = new EventEmitter(), child = new EventEmitter(), ends = [];
    const supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(describeWorkerAttemptEnd(supervisor, end))});
    parent.isConnected = () => true;
    let worker;
    parent.send = (message, callback) => {child.emit('message', structuredClone(message)); worker?.onIpcMessage(message); callback?.(null);};
    child.send = (message, callback) => {parent.emit('message', structuredClone(message)); callback?.(null);};
    supervisor.attach(parent, 'projection');
    const lifecycle = new WorkerAttemptClient({mode: 'managed', role: 'projection', transport: child, timeoutMs: 100, retries: 0});
    worker = Object.create(ProjectionWorker.prototype);
    Object.assign(worker, {workerAttemptClient: lifecycle, stopped: false, probes: new Set(), statefulControllers: new Map()});
    const originalSend = process.send;
    process.send = message => {parent.emit('message', structuredClone(message)); return true;};
    const ownerErrors = [];
    const controller = new StatefulProjectionControllerV2({declaration, adapter: native.adapter, source: p.source,
        identity: {id: 'managed-component', generation: 'one'}, requireAttemptScope: true,
        assertActive: () => worker.assertWorkerAttemptActive(),
        run: (metadata, operation) => worker.runProjectionFrameAttempt(metadata, operation, () => !worker.stopped),
        maximumFramesPerDrain: 1, custody: createStatefulCandidateCustodyV2(p.options.client, p.options.chain, 0, declaration),
        sourceMetadata: entry.sourceMetadata, reduce: async port => {await hooks.source?.(port); await retainedCall('owner.reduce',port.source.block.blockNum,()=>entry.reduce(port));},
        onError: error => ownerErrors.push(error)});
    worker.statefulControllers.set(selected.id, controller);
    observeRetainedMethod(controller,'drain','owner.drain');
    for (let i = 0; i < through && ownerErrors.length === 0; i++) await controller.drain();
    const broker = new StatefulWorkerProbeBroker(8, timeoutMs, physical => physical === parent && supervisor.ownsActiveWorker(physical, 'projection'));
    parent.on('message', message => {if (message.event === 'stateful_owner_probe_reply') broker.accept(parent, message.data);});
    let currentSocket, probeCount = 0;
    const client = new StatefulApiProbeClient(8, timeoutMs, () => currentSocket);
    const socket = {readyState: 1, send(bytes, callback) {
        const message = JSON.parse(bytes); probeCount++;
        const connectionAbort = new AbortController();
        broker.probe(parent, message.target, connectionAbort.signal).then(current => client.accept(socket,
            JSON.stringify({event: 'stateful_owner_probe_reply', requestId: message.requestId, target: message.target, current})));
        callback?.();
    }};
    currentSocket = socket;
    const app = Fastify();
    const context = installStatefulApiHostV2(app, {configuration, registry: async () => registry, probe: client});
    for (const plugin of loader.plugins) if (typeof plugin.addRoutes === 'function') await plugin.addRoutes(app, context);
    app.get('/state', {onSend: [async (request, reply, payload) => {
        await hooks.onSend?.({request, reply, payload}); return hooks.payload ? hooks.payload(payload) : payload;
    }]}, async (request, reply) => {
        await hooks.beforeCompose?.({request, reply});
        const result = await context.statefulQueryHost(request).compose(selected.id, async port => {
            const row = await port.get('collection', 'last'); await hooks.compose?.({port, request, reply});
            return {success: true, data: row.status === 'present' ? row.value : null};
        });
        return result.value;
    });
    app.get('/unrelated', async () => ({ok: true}));
    if (completeKind) app.get('/complete-kind', {onSend: [async (request, reply, payload) => {
        await hooks.onSend?.({request, reply, payload}); return hooks.payload ? hooks.payload(payload) : payload;
    }]}, async (request, reply) => {
        await hooks.beforeCompose?.({request, reply});
        const host = await context.statefulCompleteKindQueryHost(request, selected.id);
        const result = await host.compose(selected.id, async port => {
            const rows = await port.all('collection'); await hooks.compose?.({port, request, reply, host}); return {success: true, data: rows};
        });
        return result.value;
    });
    observeRetainedMethod(app,'inject','api.inject');
    retainedMark('after','host.initialize',{through});
    return {app, native, p, declaration, controller, supervisor, parent, worker, registry, client, broker, socket, ends, ownerErrors, context,
        get probes() {return probeCount;}, replaceSocket() {currentSocket = {...socket};},
        disconnect() {socket.readyState = 3; client.disconnected(socket);},
        async close() {
            retainedMark('before','host.close');
            await app.close(); worker.stopped = true; await controller.stop(); await Promise.allSettled([...worker.probes]);
            supervisor.observeExit(parent); lifecycle.dispose();
            if (originalSend === undefined) delete process.send; else process.send = originalSend;
            if (previousConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = previousConfig;
            assert.equal(dirname(pluginRoot), tempParent); assert(basename(pluginRoot).startsWith('hapi-stateful-plugin-'));
            rmSync(pluginRoot, {recursive: true, force: true});
            retainedMark('after','host.close');
        }};
}
