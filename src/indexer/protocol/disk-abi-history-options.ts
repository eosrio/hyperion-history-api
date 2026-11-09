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
import {DiskSourceEvidence} from './disk-source-evidence.js';

/** The host selects installed code and explicitly pinned data before constructing a reader. */
export function diskAbiHistoryOptions(configuration:DiskAbiHistoryConfiguration|undefined, client:Client,
    chain:string,chainId:string,profile:ProtocolSourceProfile,provider:ProtocolProvider,replicas=0) {
    // Where the node's logs are read from is not part of the catalog's identity or its restart-gated budget.
    const {capture,...pinned}=configuration??({} as Partial<DiskAbiHistoryConfiguration>);
    const catalog=DiskAbiHistoryCatalog.fromConfiguration(configuration?pinned as DiskAbiHistoryConfiguration:undefined,chainId,profile);
    return catalog?{catalog,bindings:new ProtocolSourceBindingStore(client,chain,replicas,{readOnly:true}),
        observations:new ProtocolAbiObservationStore(client,chain,replicas,undefined,{readOnly:true}),
        verifyNativeGenesis:provider.verifyNativeGenesis?.bind(provider),
        evidence:capture?new DiskSourceEvidence(capture,configuration!.ship_abi_sha256,catalog,provider,chainId,profile):undefined}:undefined;
}

/** Publish original raw-input readiness separately from the immutable ABI coverage prefix. */
export async function publishDiskAbiSource(options:ReturnType<typeof diskAbiHistoryOptions>,writer:ProtocolSourceBindingStore,selectionId:string,
    checkpoint:()=>void):Promise<void> {
    if(!options)return;
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
