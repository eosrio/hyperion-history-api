import type {Client} from '@elastic/elasticsearch';
import {createHash} from 'node:crypto';
import type {ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import type {ProtocolSourceProfile} from './source-bindings.js';
import {ProtocolSourceBindingStore} from './source-bindings.js';
import {ProtocolAbiObservationStore} from './abi-observation-store.js';
import {protocolImmutableJson} from './immutable-bundle-store.js';
import {assertProtocolAbiObservationFacts} from './abi-observation-facts.js';
import {verifyNativeGenesisRecord} from './native-genesis.js';
import {DiskAbiHistoryCatalog, type DiskAbiHistoryConfiguration} from './disk-abi-history.js';

/** The host selects installed code and explicitly pinned data before constructing a reader. These handles only read. */
export function diskAbiHistoryOptions(configuration:DiskAbiHistoryConfiguration|undefined, client:Client,
    chain:string,chainId:string,profile:ProtocolSourceProfile,provider:ProtocolProvider,replicas=0,
    reads:{metadataReadBoundMs?:number;rememberRecords?:boolean}={}) {
    const catalog=DiskAbiHistoryCatalog.fromConfiguration(configuration,chainId,profile);
    const {metadataReadBoundMs,rememberRecords}=reads;
    return catalog?{catalog,bindings:new ProtocolSourceBindingStore(client,chain,replicas,{readOnly:true,metadataReadBoundMs,rememberRecords}),
        observations:new ProtocolAbiObservationStore(client,chain,replicas,undefined,{readOnly:true,metadataReadBoundMs}),
        verifyNativeGenesis:provider.verifyNativeGenesis?.bind(provider)}:undefined;
}

/**
 * Publish original raw-input readiness separately from the immutable ABI coverage prefix.
 * `position` is the caller's already verified source of this selection: a source past the catalog
 * cannot be covered, so it returns before any store read. Covered sources still read the stored selection.
 */
export async function publishDiskAbiSource(options:ReturnType<typeof diskAbiHistoryOptions>,writer:ProtocolSourceBindingStore,selectionId:string,
    checkpoint:()=>void,position?:{blockNum:number}):Promise<void> {
    if(!options)return;
    if(position!==undefined&&!await options.catalog.mayCover(position.blockNum))return;
    checkpoint();const {selection,context}=await options.bindings.readSelection(selectionId);
    const covered=await options.catalog.covers(selection.source);checkpoint();if(!covered)return;
    await options.catalog.assertSchema(context.schemaJson);checkpoint();
    const link=await options.bindings.readObservationLink(selectionId),record=await options.observations.read(link.observationId);
    if(record.observation.status==='incomplete')return;
    if(record.observation.status==='observed')assertProtocolAbiObservationFacts(record.observation.facts);
    else verifyNativeGenesisRecord(record,options.verifyNativeGenesis);
    const {inputSha256,...source}=record.source;
    if(protocolImmutableJson(source)!==protocolImmutableJson(selection.source)||inputSha256!==selection.captureSha256
        ||protocolImmutableJson(record.protocol)!==protocolImmutableJson(context.protocol)||record.capture.schemaJson!==context.schemaJson
        ||createHash('sha256').update(protocolImmutableJson(record)).digest('hex')!==link.observationDigest)
        throw new Error('Catalog publication differs from original source');
    await writer.preparePublishedSource(selectionId,async()=>{checkpoint();await options.catalog.revalidate();checkpoint();});
}
