import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
import {ImmutableProtocolBundleStore,protocolImmutableJson} from './immutable-bundle-store.js';
import type {ProtocolComponent} from '@eosrio/hyperion-sdk/protocol';
import {isProtocolHex} from './hex.js';

export interface ProtocolAbiObservationRecord {
    schemaVersion: 1;
    protocol: {id: string; profileId: string; components: readonly ProtocolComponent[]};
    source: {chainId: string; blockNum: number; blockId: string; previousBlockId: string | null; inputSha256: string};
    capture: {kind: 'unattested-ship-result-sections-v1'; schemaJson: string | null;
        blockHex: string | null; tracesHex: string | null; deltasHex: string | null};
    observation: {status: 'observed' | 'native-genesis'; facts: unknown} | {status: 'incomplete'; error: {code: string; message: string}};
}

export {protocolImmutableJson as protocolAbiObservationJson} from './immutable-bundle-store.js';
const canonical=protocolImmutableJson;
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const hex64 = /^[0-9a-f]{64}$/;
const orderedComponents = (components: readonly ProtocolComponent[]) => [...components].sort((a, b) => {
    const left = a.runtime + ':' + a.id, right = b.runtime + ':' + b.id;
    return left < right ? -1 : left > right ? 1 : 0;
});
/** Stable source digest excludes mutable SHiP result head/LIB metadata. */
export function protocolAbiCaptureDigest(source: Omit<ProtocolAbiObservationRecord['source'], 'inputSha256'>,
                                         capture: ProtocolAbiObservationRecord['capture']): string {
    return sha256(canonical({source, capture}));
}

export function protocolAbiObservationId(record: ProtocolAbiObservationRecord): string {
    const {source, protocol} = record;
    if (record.schemaVersion !== 1 || !source || !protocol || !hex64.test(source.chainId) || !hex64.test(source.blockId)
        || !hex64.test(source.inputSha256) || (source.previousBlockId !== null && !hex64.test(source.previousBlockId))
        || !Number.isSafeInteger(source.blockNum) || source.blockNum < 1 || source.blockNum > 0xffffffff
        || typeof protocol.id !== 'string' || !protocol.id.length || protocol.id.length > 214
        || typeof protocol.profileId !== 'string' || !protocol.profileId.length || protocol.profileId.length > 256
        || !Array.isArray(protocol.components) || !protocol.components.length
        || protocol.components.some(component => !/^[0-9a-f]{40}$/.test(component.sourceRevision) || !hex64.test(component.sha256))
        || !['observed', 'native-genesis', 'incomplete'].includes(record.observation?.status)
        || record.capture?.kind !== 'unattested-ship-result-sections-v1'
        || (record.capture.schemaJson !== null && typeof record.capture.schemaJson !== 'string')
        || ['blockHex', 'tracesHex', 'deltasHex'].some(key => record.capture[key] !== null
            && !isProtocolHex(record.capture[key]))) {
        throw new Error('Invalid ABI observation source or profile');
    }
    const {inputSha256, ...position} = source;
    if (protocolAbiCaptureDigest(position, record.capture) !== inputSha256) throw new Error('ABI observation capture digest mismatch');
    // Distinct raw captures are retained separately; no equivalence/canonical claim is implied.
    const artifacts = orderedComponents(protocol.components);
    return 'h45abi1:' + sha256(canonical(['hyperion-abi-observation-v1', protocol.id, protocol.profileId,
        artifacts, source.chainId, source.blockId, inputSha256]));
}

/** Existing public IDs and payload bytes remain unchanged. */
export class ProtocolAbiObservationStore {
    private readonly bundles:ImmutableProtocolBundleStore;
    get index():string {return this.bundles.index;}

    constructor(client:Client,chain:string,replicas=0,
                bounds={chunkBytes:512*1024,maximumBytes:128*1024*1024,maximumChunks:256},options:{readOnly?:boolean}={}) {
        this.bundles=new ImmutableProtocolBundleStore(client,chain,replicas,
            'protocol-abi-observations','protocol-abi-observations-v1',bounds,options);
    }

    async prepare(record:ProtocolAbiObservationRecord):Promise<{id:string;digest:string}> {
        const id=protocolAbiObservationId(record);
        return this.bundles.prepare(id,{...record,protocol:{...record.protocol,components:orderedComponents(record.protocol.components)}});
    }

    async read(id:string):Promise<ProtocolAbiObservationRecord> {
        const record=await this.bundles.read(id) as ProtocolAbiObservationRecord;
        if(protocolAbiObservationId(record)!==id)throw new Error('ABI observation source identity mismatch');
        return record;
    }
}
