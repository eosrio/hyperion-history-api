import {setTimeout as delay} from 'node:timers/promises';
import {HyperionWorker} from './hyperionWorker.js';
import {resolvePortableStateConfiguration} from '../projection/config.js';
import {createPortableStateBackend} from '../projection/backend.js';
import {PortableProjectionSource} from '../projection/source.js';
import {PortableStateController} from '../projection/controller.js';
import {hLog} from '../helpers/common_functions.js';

/** Uses the shared retained journal inbox; it never consumes or settles a history/source delivery. */
export default class ProjectionWorker extends HyperionWorker {
    private controller?: PortableStateController;
    private stopped = false;
    async assertQueues(): Promise<void> {} // Existing worker lifecycle/AMQP connection; no second source fan-out queue.
    onIpcMessage(message: any): void {
        if (message.event === 'stop') this.stopped = true;
    }
    async run(): Promise<void> {
        try {
            await this.protocolReady;
            const configuration = resolvePortableStateConfiguration(this.conf.features.portable_state, this.chainId);
            if (!configuration) throw new Error('Projection worker requires explicit portable state configuration');
            if (!this.usesExtensionProtocol || !this.protocol.verifyNativeGenesis || !this.conf.indexer.live_reader)
                throw new Error('Portable genesis projections require a live selected source with native genesis verification');
            if (!this.manager.conn.mongodb) throw new Error('Portable MongoDB backend requires a configured connection');
            if (!this.manager.mongodbClient) this.manager.prepareMongoClient();
            const client = this.manager.mongodbClient!;
            await client.connect();
            const adapter = createPortableStateBackend(client, configuration);
            const source = new PortableProjectionSource({client: this.client, chain: this.chain, chainId: this.chainId,
                profile: {id: this.protocolId, profileId: this.protocol.profileId, components: this.protocolComponents ?? []},
                provider: this.protocol, replicas: this.conf.settings.es_replicas ?? 0,
                maxAncestryBlocks: this.conf.settings.protocol_abi_coordination?.recovery_window_blocks});
            this.controller = await PortableStateController.create({chainId: this.chainId, configuration, adapter, source,
                onProgress: data => {try {process.send?.({event: 'portable_state_progress', data});} catch {}}});
            while (!this.stopped) {
                await this.controller.drain();
                if (!this.stopped) await delay(100);
            }
            await this.controller.stop();
            await client.close();
            this.profiler.stopReporting();
            process.exit(0);
        } catch (error) {
            hLog('Portable state worker failed; history indexing remains independent:', error);
            this.profiler.stopReporting();
            process.exit(1);
        }
    }
}
