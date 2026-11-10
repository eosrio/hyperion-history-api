import {createHash} from 'node:crypto';
import type {ProtocolProvider, ProtocolShipSession} from '@eosrio/hyperion-sdk/protocol';
import type {DiskAbiHistoryCatalog} from './disk-abi-history.js';
import {DiskCaptureSource, type DiskCaptureConfiguration} from './disk-capture-source.js';
import {protocolAbiObservationEvidence, type ProtocolAbiObservationRecord} from './abi-observation-store.js';
import {protocolNativeObservationEvidence, protocolSourceNativeObservationLinkId,
    type ProtocolNativeObservationRecord} from './native-observation-store.js';
import {protocolSourceContextId, type ProtocolSourcePosition, type ProtocolSourceProfile} from './source-bindings.js';
import {protocolImmutableJson} from './immutable-bundle-store.js';
import {observeProtocolAbiSource, observeProtocolNativeSource, type ProtocolSourceDecode} from './source-observation.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** The deterministic selection of a catalog position: one per canonical block, recomputed, never stored. */
export function protocolDiskSelectionId(position: ProtocolSourcePosition): string {
    return 'h45abidiskselection1:' + hash(protocolImmutableJson(position));
}
export const isProtocolDiskSelectionId = (value: unknown): value is string =>
    typeof value === 'string' && /^h45abidiskselection1:[0-9a-f]{64}$/.test(value);

/** Exactly the records the indexer stores for one source, recomputed from the node's logs. */
export interface DiskSourceRecords {
    readonly position: ProtocolSourcePosition;
    readonly selectionId: string;
    readonly context: {readonly schemaVersion: 1; readonly chainId: string; readonly protocol: ProtocolSourceProfile; readonly schemaJson: string};
    readonly contextId: string;
    readonly abi: {readonly record: ProtocolAbiObservationRecord; readonly id: string; readonly digest: string};
    /** Present when the selected provider classifies native actions. */
    readonly native?: {readonly record: ProtocolNativeObservationRecord; readonly id: string; readonly digest: string; readonly linkId: string};
}

function freeze<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {for (const child of Object.values(value)) freeze(child); Object.freeze(value);}
    return value;
}

/** Recomputes catalog-covered sources from the node's logs with the indexer's own observers, so a
 * disk proof reads the same records a stored proof reads, without Elasticsearch copies. */
export class DiskSourceEvidence {
    private captures?: Promise<DiskCaptureSource>;
    private session?: ProtocolShipSession;
    private readonly cache = new Map<number, Promise<DiskSourceRecords>>();
    private closed = false;
    private readonly profile: ProtocolSourceProfile;
    /** `shipAbiSha256` is the operator-pinned handshake digest the catalog's manifest must also carry. */
    constructor(private readonly configuration: DiskCaptureConfiguration, private readonly shipAbiSha256: string,
                private readonly catalog: DiskAbiHistoryCatalog, private readonly provider: ProtocolProvider,
                private readonly chainId: string, profile: ProtocolSourceProfile, private readonly cacheBlocks = 64) {
        if (typeof provider?.createShipSession !== 'function' || typeof provider.observeBlockAbi !== 'function')
            throw new Error('Disk source evidence requires the selected provider\'s SHiP session and ABI observer');
        if (!Number.isSafeInteger(cacheBlocks) || cacheBlocks < 1 || cacheBlocks > 4096) throw new Error('Invalid disk evidence cache bound');
        // The stores order components by runtime and id; recomputed records must carry them the same way.
        this.profile = freeze(JSON.parse(protocolImmutableJson({...profile, components: [...profile.components]
            .sort((a, b) => {const left = a.runtime + ':' + a.id, right = b.runtime + ':' + b.id; return left < right ? -1 : left > right ? 1 : 0;})})));
    }
    async close(): Promise<void> {
        this.closed = true; this.cache.clear();
        this.session?.close?.(); this.session = undefined;
        const captures = await this.captures?.catch(() => undefined);
        this.captures = undefined;
        await captures?.close();
    }
    private source(): Promise<DiskCaptureSource> {
        if (this.closed) throw new Error('Disk source evidence is closed');
        return this.captures ??= DiskCaptureSource.open(this.configuration, this.shipAbiSha256)
            .catch(error => {this.captures = undefined; throw error;});
    }
    private decoder(schemaJson: string): ProtocolSourceDecode {
        this.session ??= this.provider.createShipSession(JSON.parse(schemaJson));
        const session = this.session;
        return (type, bytes) => type === 'transaction_trace[]' ? session.decodeTraces(bytes)
            : type === 'table_delta[]' ? session.decodeDeltas(bytes) : session.decodeRow(type, bytes);
    }
    /** The records of catalog-covered block `blockNum`, recomputed once and kept for recent blocks. */
    records(blockNum: number): Promise<DiskSourceRecords> {
        let value = this.cache.get(blockNum);
        if (value) {this.cache.delete(blockNum); this.cache.set(blockNum, value); return value;}
        value = this.compute(blockNum);
        this.cache.set(blockNum, value);
        value.catch(() => {if (this.cache.get(blockNum) === value) this.cache.delete(blockNum);});
        while (this.cache.size > this.cacheBlocks) this.cache.delete(this.cache.keys().next().value!);
        return value;
    }
    private async compute(blockNum: number): Promise<DiskSourceRecords> {
        const captures = await this.source();
        const position = await this.catalog.source(blockNum);
        await this.catalog.assertSchema(captures.schemaJson);
        const {capture, captureSha256} = await captures.capture(position);
        const decode = this.decoder(captures.schemaJson);
        const {observation} = observeProtocolAbiSource(this.provider, decode, position, capture, true);
        const abi = protocolAbiObservationEvidence({schemaVersion: 1, protocol: this.profile,
            source: {...position, inputSha256: captureSha256}, capture, observation});
        const context = {schemaVersion: 1 as const, chainId: this.chainId, protocol: this.profile, schemaJson: captures.schemaJson};
        const contextId = protocolSourceContextId(context), selectionId = protocolDiskSelectionId(position);
        let native: DiskSourceRecords['native'];
        if (this.provider.nativeActions !== undefined) {
            const record = observeProtocolNativeSource(this.provider.nativeActions, decode, {contextId, protocol: this.profile,
                schemaJson: captures.schemaJson, abi: abi.record, abiObservationId: abi.id, abiObservationDigest: abi.digest});
            native = {...protocolNativeObservationEvidence(record), linkId: protocolSourceNativeObservationLinkId(selectionId)};
        }
        await this.catalog.revalidate();
        return freeze({position, selectionId, context, contextId, abi, native});
    }
}
