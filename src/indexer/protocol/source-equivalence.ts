import {createHash} from 'node:crypto';
import {ProtocolSourceBindingStore} from './source-bindings.js';
import {ProtocolAbiObservationStore, protocolAbiObservationId} from './abi-observation-store.js';
import {protocolImmutableJson} from './immutable-bundle-store.js';

declare const receiptBrand: unique symbol;
/** Reader-owned evidence of one complete immutable verification; no payload or canonical authority. */
export interface ProtocolSourceEquivalenceReceipt {readonly [receiptBrand]: true}
type CommitEvidence={source:unknown;observationId:string|null;observationDigest:string|null};

/** Evidence only: canonical membership is issued separately by the settled proof reader. */
export class ProtocolSourceEquivalence {
    private readonly receipts=new WeakMap<ProtocolSourceEquivalenceReceipt,string>();
    constructor(private readonly bindings:ProtocolSourceBindingStore, private readonly observations:ProtocolAbiObservationStore) {}
    private async selected(candidateId:string,canonicalId:string,commit:CommitEvidence,signal?:AbortSignal) {
        signal?.throwIfAborted();
        const candidate=await this.bindings.readSelection(candidateId,signal);
        const canonical=await this.bindings.readSelection(canonicalId,signal);
        const link=await this.bindings.readObservationLink(candidateId,signal);
        const canonicalLink=await this.bindings.readObservationLink(canonicalId,signal);
        signal?.throwIfAborted();
        const json=protocolImmutableJson;
        if(candidate.selection.contextId!==canonical.selection.contextId || json(candidate.context)!==json(canonical.context)
            || json(candidate.selection.source)!==json(commit.source) || json(canonical.selection.source)!==json(commit.source)
            || candidate.selection.captureSha256!==canonical.selection.captureSha256
            || link.observationId!==canonicalLink.observationId || link.observationDigest!==canonicalLink.observationDigest
            || canonicalLink.observationId!==commit.observationId || canonicalLink.observationDigest!==commit.observationDigest) return null;
        const seal=createHash('sha256').update(json([candidateId,canonicalId,commit.source,commit.observationId,commit.observationDigest,
            candidate.selection.contextId,candidate.selection.captureSha256])).digest('hex');
        return {candidate,link,seal};
    }
    /** Each new proof opening verifies the complete observation independently. Retain only its seal. */
    async open(candidateId:string,canonicalId:string,commit:CommitEvidence,signal?:AbortSignal):Promise<ProtocolSourceEquivalenceReceipt|null> {
        const selected=await this.selected(candidateId,canonicalId,commit,signal);
        if(!selected)return null;
        const {candidate,link,seal}=selected,json=protocolImmutableJson;
        const observation=await this.observations.read(link.observationId,signal);signal?.throwIfAborted();
        if(!(protocolAbiObservationId(observation)===link.observationId
            && createHash('sha256').update(json(observation)).digest('hex')===link.observationDigest
            && observation.source.inputSha256===candidate.selection.captureSha256
            && json({...candidate.selection.source,inputSha256:candidate.selection.captureSha256})===json(observation.source)
            && json(observation.protocol)===json(candidate.context.protocol)
            && observation.capture.schemaJson===candidate.context.schemaJson))return null;
        const receipt=Object.freeze({}) as ProtocolSourceEquivalenceReceipt;
        this.receipts.set(receipt,seal);return receipt;
    }
    /** Fresh selection/context/link reads remain mandatory; the issued view owns prior immutable evidence. */
    async revalidate(receipt:ProtocolSourceEquivalenceReceipt,candidateId:string,canonicalId:string,commit:CommitEvidence,signal?:AbortSignal):Promise<boolean> {
        signal?.throwIfAborted();const seal=this.receipts.get(receipt);
        if(!seal)return false;
        const selected=await this.selected(candidateId,canonicalId,commit,signal);
        signal?.throwIfAborted();return selected?.seal===seal;
    }
}
