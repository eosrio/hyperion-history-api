import {setTimeout as delay} from 'node:timers/promises';
import {HyperionWorker} from './hyperionWorker.js';
import {resolvePortableStateConfiguration} from '../projection/config.js';
import {createPortableStateBackend} from '../projection/backend.js';
import {PortableProjectionSource} from '../projection/source.js';
import {PortableStateController} from '../projection/controller.js';
import {hLog} from '../helpers/common_functions.js';
import {randomUUID} from 'node:crypto';
import {resolveStatefulOwnerConfigurationV2, type ResolvedStatefulOwnerConfigurationV2} from '../projection/stateful-config.js';
import {StatefulProjectionRegistryV2} from '../projection/stateful-registry.js';
import {StatefulProjectionControllerV2} from '../projection/stateful-controller.js';
import {createStatefulCandidateCustodyV2} from '../projection/stateful-custody.js';
import {validStatefulProbeId, validStatefulProbeTarget} from '../projection/stateful-control.js';

/** Uses the shared retained journal inbox; it never consumes or settles a history/source delivery. */
export default class ProjectionWorker extends HyperionWorker {
    private controller?: PortableStateController;
    private stateful?: StatefulProjectionRegistryV2;
    private statefulSource?: PortableProjectionSource;
    private statefulConfiguration?: ResolvedStatefulOwnerConfigurationV2;
    private readonly statefulControllers = new Map<string, StatefulProjectionControllerV2>();
    private readonly probes = new Set<Promise<void>>();
    private readonly statefulIdentity = Object.freeze({id: 'projection:' + process.env.worker_id, generation: randomUUID()});
    private stopped = false;
    async assertQueues(): Promise<void> {} // Existing worker lifecycle/AMQP connection; no second source fan-out queue.
    onIpcMessage(message: any): void {
        if (['stop', 'worker_attempt_fence', 'worker_attempt_fence_active', 'reload_config', 'reload_contract_config'].includes(message.event))
            this.controller?.invalidateMappingRetryEligibility();
        if (message.event === 'stop') this.stopped = true;
        if (message.event === 'stateful_owner_probe_request' && validStatefulProbeId(message.data?.requestId)
            && validStatefulProbeTarget(message.data?.target)) {
            const {requestId, target} = message.data;
            const work = this.runProjectionFrameAttempt({kind: 'stateful-request-probe-v2', target}, async () => {
                if (this.stopped) return false;
                for (const controller of this.statefulControllers.values()) if (await controller.attestDigest(target)) return true;
                return false;
            }, () => !this.stopped).catch(() => false).then(current => {
                try {process.send?.({event: 'stateful_owner_probe_reply', data: {requestId, target, current: current && !this.stopped}});} catch {}
            });
            this.probes.add(work); void work.finally(() => this.probes.delete(work));
        }
    }
    async run(): Promise<void> {
        try {
            const initialized = await this.runProjectionAttempt('projection-initialization', {chainId: this.chainId,
                portableState: this.conf.features.portable_state}, async () => {
            await this.protocolReady;
            this.assertWorkerAttemptActive();
            const configuration = resolvePortableStateConfiguration(this.conf.features.portable_state, this.chainId);
            const stateful = resolveStatefulOwnerConfigurationV2(this.conf.features.stateful_owner_v2, configuration);
            if (!configuration && !stateful) throw new Error('Projection worker requires explicit state configuration');
            if (configuration && (!this.usesExtensionProtocol || !this.protocol.verifyNativeGenesis || !this.conf.indexer.live_reader))
                throw new Error('Portable genesis projections require a live selected source with native genesis verification');
            if (stateful && !this.conf.indexer.live_reader) throw new Error('Stateful owner requires the selected live source');
            if (!this.manager.conn.mongodb) throw new Error('Portable MongoDB backend requires a configured connection');
            if (!this.manager.mongodbClient) this.manager.prepareMongoClient();
            const client = this.manager.mongodbClient!;
            await client.connect();
            this.assertWorkerAttemptActive();
            const sourceOptions = {client: this.client, chain: this.chain, chainId: this.chainId,
                profile: {id: this.protocolId, profileId: this.protocol.profileId, components: this.protocolComponents ?? []},
                provider: this.protocol, replicas: this.conf.settings.es_replicas ?? 0,
                requireAttemptScope: this.workerAttemptScopeRequired,
                maxAncestryBlocks: this.conf.settings.protocol_abi_coordination?.recovery_window_blocks};
            const source = new PortableProjectionSource(sourceOptions);
            this.statefulSource = stateful && this.conf.settings.protocol_abi_coordination?.historical_certificates
                ? new PortableProjectionSource({...sourceOptions, historicalCertificates: true}) : source;
            if (configuration) this.controller = await PortableStateController.create({chainId: this.chainId, configuration,
                adapter: createPortableStateBackend(client, configuration), source,
                mappingRetryEligibilityMs: 1000,
                attempts: {run: (metadata, operation) => this.runProjectionFrameAttempt(metadata, operation, () => !this.stopped),
                    bind: fields => this.bindWorkerAttempt(fields)},
                onProgress: data => {try {process.send?.({event: 'portable_state_progress', data});} catch {}}});
            if (stateful) {
                this.statefulConfiguration = stateful;
                this.stateful = await StatefulProjectionRegistryV2.create({chainId: this.chainId, configuration: stateful,
                    mongo: client, client: this.client, source: this.statefulSource, profile: {id: this.protocolId, profileId: this.protocol.profileId, components: this.protocolComponents ?? []},
                    completeKindMongo: () => this.manager.statefulCompleteKindMongoClient(stateful.operationTimeoutMS),
                    onError: (projection, error) => hLog(`Stateful projection ${projection} unavailable:`, error)}, this.mLoader);
            }
            this.assertWorkerAttemptActive();
            return {client};
            }, () => !this.stopped);
            while (!this.stopped) {
                await this.controller?.drain();
                if (this.stateful) {
                    await this.runProjectionFrameAttempt({kind: 'stateful-template-resolution-v2'}, async () => {
                        await this.stateful!.initializeMissing();
                        for (const [id, entry] of this.stateful!.entries) if (!this.statefulControllers.has(id)) {
                            const configuration = this.statefulConfiguration!;
                            this.statefulControllers.set(id, new StatefulProjectionControllerV2({declaration: entry.declaration, adapter: entry.adapter,
                                source: this.statefulSource!, identity: this.statefulIdentity, reduce: entry.reduce, requireAttemptScope: true,
                                sourceMetadata: entry.sourceMetadata,
                                custody: createStatefulCandidateCustodyV2(this.client, this.chain, this.conf.settings.es_replicas ?? 0, entry.declaration),
                                assertActive: () => {if (this.stopped) throw new Error('Stateful worker stopped'); this.assertWorkerAttemptActive();},
                                run: (metadata, operation) => this.runProjectionFrameAttempt(metadata, operation, () => !this.stopped),
                                maximumFramesPerDrain: configuration.maximumFramesPerDrain,
                                onError: error => hLog(`Stateful projection ${id} recovery pending:`, error)}));
                        }
                        return true;
                    }, () => !this.stopped);
                    for (const controller of this.statefulControllers.values()) await controller.drain();
                }
                if (!this.stopped) await delay(100);
            }
            await this.controller?.stop();
            for (const controller of this.statefulControllers.values()) await controller.stop();
            await Promise.allSettled([...this.probes]);
            await this.manager.closeStatefulCompleteKindMongoClient();
            await initialized.client.close();
            this.profiler.stopReporting();
            process.exit(0);
        } catch (error) {
            await this.manager.closeStatefulCompleteKindMongoClient();
            this.handleProjectionFailure(error);
        }
    }

    private handleProjectionFailure(error: unknown): void {
        hLog('Portable state worker failed; history indexing remains independent:', error);
        this.profiler.stopReporting();
        process.exit(1);
    }
}
