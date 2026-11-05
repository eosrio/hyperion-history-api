import {createHash} from 'node:crypto';
import {ProtocolSourceBindingStore} from './source-bindings.js';
import {ProtocolAbiObservationStore, protocolAbiObservationId} from './abi-observation-store.js';
import {protocolImmutableJson} from './immutable-bundle-store.js';

/** Evidence only: canonical membership is issued separately by the settled proof reader. */
export class ProtocolSourceEquivalence {
    constructor(private readonly bindings:ProtocolSourceBindingStore, private readonly observations:ProtocolAbiObservationStore) {}
    async matches(candidateId:string, canonicalId:string, commit:{source:unknown;observationId:string|null;observationDigest:string|null}, signal?:AbortSignal):Promise<boolean> {
        signal?.throwIfAborted();
        {
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
                || canonicalLink.observationId!==commit.observationId || canonicalLink.observationDigest!==commit.observationDigest) return false;
            const observation=await this.observations.read(link.observationId,signal);signal?.throwIfAborted();
            return protocolAbiObservationId(observation)===link.observationId
                && createHash('sha256').update(json(observation)).digest('hex')===link.observationDigest
                && observation.source.inputSha256===candidate.selection.captureSha256
                && json({...candidate.selection.source,inputSha256:candidate.selection.captureSha256})===json(observation.source)
                && json(observation.protocol)===json(candidate.context.protocol)
                && observation.capture.schemaJson===candidate.context.schemaJson;
        }
    }
}
