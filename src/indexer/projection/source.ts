import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
import type {ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import type {StatefulOwnerDeclarationV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import type {CapturedStatefulSourceV2} from '@eosrio/hyperion-sdk/projection-stateful-source-v2';
import type {StatefulSelector} from '@eosrio/hyperion-sdk/projection-stateful';
import {ProjectionContractError, validateContextualProjectionDefinition, type ContextualProjectionDefinition,
    type ProjectionBlock, type ProjectionCheckpoint, type ProjectionDefinition} from '@eosrio/hyperion-sdk/projection';
import {ProtocolAbiFrontierStore, ProtocolAbiFrontierRecordMemo} from '../protocol/abi-frontier-store.js';
import {ProtocolAbiProofReader, ProtocolAbiProofUnavailableError, type ProtocolAbiProofView} from '../protocol/abi-proof.js';
import {ProtocolAbiObservationStore, protocolAbiObservationId, type ProtocolAbiObservationRecord} from '../protocol/abi-observation-store.js';
import {ProtocolSourceBindingStore, type ProtocolSourceContext, type ProtocolSourceSelection, type ProtocolSourceProfile} from '../protocol/source-bindings.js';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';
import {protocolDeployment} from '../protocol/deployments.js';
import {verifyNativeGenesisRecord} from '../protocol/native-genesis.js';
import type {ProjectionFrame, ProjectionTableChange} from './runtime.js';
import {currentProofConsumerScope, trackProofConsumerOperation} from '../protocol/proof-consumer-scope.js';
import {ProtocolNativeActionReader} from '../protocol/native-authorization.js';
import {ProtocolNativeObservationStore} from '../protocol/native-observation-store.js';
import {decodeStatefulSourceV2, statefulActionMetadataSelection} from './stateful-source.js';
import {statefulAbiEpoch} from './stateful-abi-epoch.js';
import {diskAbiHistoryOptions} from '../protocol/disk-abi-history-options.js';
import type {DiskAbiHistoryConfiguration} from '../protocol/disk-abi-history.js';
import {ProtocolSourceBindingReadError} from '../protocol/source-bindings.js';
import {contextualChecked, originalProjectionTimeMs, type ContextualProjectionFrame} from './contextual-contract.js';

const json = protocolImmutableJson;
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const zero = '0'.repeat(64);
const unavailable = (message: string): never => {throw new ProtocolAbiProofUnavailableError('projection_source_unavailable', message);};
export interface PortableProjectionSourceOptions {
    client: Client; chain: string; chainId: string; profile: ProtocolSourceProfile; provider: ProtocolProvider;
    maxAncestryBlocks?: number; replicas?: number; requireAttemptScope?: boolean;
    historicalCertificates?: boolean;
    diskAbiHistory?:DiskAbiHistoryConfiguration;
}
export interface PortableProjectionSourceEvidence {
    readonly certificateId: string; readonly commitId: string; readonly selectionId: string;
    readonly observationId: string; readonly observationDigest: string; readonly captureSha256: string;
    readonly frameSha256: string;
}
export interface PortableProjectionFrame {
    readonly frame: ProjectionFrame; readonly proof: ProtocolAbiProofView; readonly evidence: PortableProjectionSourceEvidence;
}
/** Original certified locators available before reading or interpreting retained capture bodies. */
export interface PortableProjectionRawTarget {
    readonly block: ProjectionBlock;
    readonly reference: {readonly commitId: string; readonly selectionId: string;
        readonly observationId: string; readonly observationDigest: string};
}
/** Internal source boundary; this packet is not a plugin input or a public serving grant. */
export interface PortableProjectionOriginalBlock {
    readonly target: PortableProjectionRawTarget;
    readonly proof: ProtocolAbiProofView;
    readonly selection: ProtocolSourceSelection;
    readonly context: ProtocolSourceContext;
    readonly observation: ProtocolAbiObservationRecord;
    readonly evidence: PortableProjectionSourceEvidence;
}
export interface PortableStatefulFrameV2 {
    readonly source: CapturedStatefulSourceV2;
    readonly proof: ProtocolAbiProofView;
    readonly evidence: PortableProjectionSourceEvidence;
}
export interface PortableContextualProjectionFrame extends Omit<PortableProjectionFrame, 'frame'> {
    readonly frame: ContextualProjectionFrame;
}
type SourceDefinition = Pick<ProjectionDefinition, 'source'>;
/** A known canonical target can be durably fenced even when its retained input cannot be used. */
export class PortableProjectionFrameError extends Error {
    constructor(readonly block: ProjectionBlock, cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause), {cause});
        this.name = 'PortableProjectionFrameError';
    }
}

/** Read-only journal consumer. Stored inputs alone never establish canonical membership. */
export class PortableProjectionSource {
    private readonly store: ProtocolAbiFrontierStore;
    private readonly bindings: ProtocolSourceBindingStore;
    private readonly observations: ProtocolAbiObservationStore;
    private readonly reader: ProtocolAbiProofReader;
    private readonly options: PortableProjectionSourceOptions;
    private readonly maximumAncestry: number;
    // In-process fence only; the applied checkpoint is the durable finality floor.
    private lastIrreversible?: ProjectionCheckpoint;
    private readonly diskHistory:ReturnType<typeof diskAbiHistoryOptions>;
    constructor(options: PortableProjectionSourceOptions) {
        this.maximumAncestry = options.maxAncestryBlocks ?? 256;
        this.options = {...options, profile: JSON.parse(json(options.profile))};
        this.store = new ProtocolAbiFrontierStore(options.client, options.chain, options.replicas ?? 0, {readOnly: true, recordMemo: new ProtocolAbiFrontierRecordMemo()});
        this.bindings = new ProtocolSourceBindingStore(options.client, options.chain, options.replicas ?? 0, {readOnly: true});
        this.observations = new ProtocolAbiObservationStore(options.client, options.chain, options.replicas ?? 0, undefined, {readOnly: true});
        this.diskHistory=diskAbiHistoryOptions(options.diskAbiHistory,options.client,options.chain,options.chainId,
            this.options.profile,options.provider,options.replicas??0);
        this.reader = new ProtocolAbiProofReader({chainId: options.chainId, profile: this.options.profile,
            store: this.store, maxAncestryBlocks: this.maximumAncestry, requireAttemptScope: options.requireAttemptScope,
            historicalCertificates: options.historicalCertificates,diskHistory:this.diskHistory});
    }
    get chainId(): string {return this.options.chainId;}
    private async retained<T>(operation: () => Promise<T>): Promise<T> {
        const scope = currentProofConsumerScope(this.options.requireAttemptScope);
        const value = await trackProofConsumerOperation(operation, scope);
        scope?.assertActive(); return value;
    }
    private async control() {
        const control: any = (await this.retained(() => this.store.readControl()))?.value;
        if (control?.chainId !== this.options.chainId || json(control.profile) !== json(this.options.profile)
            || control.phase !== 'following' || control.replayFromBlock !== null || !control.source
            || control.head?.coverageStart !== 1) unavailable('Source lacks current complete coverage from block one');
        return control;
    }
    async open(checkpoint: ProjectionCheckpoint): Promise<ProtocolAbiProofView> {
        if (!Number.isSafeInteger(checkpoint.blockNum) || checkpoint.blockNum < 1) unavailable('Checkpoint zero grants no source coverage');
        if(this.diskHistory&&await this.diskHistory.catalog.covers({chainId:this.options.chainId,...checkpoint}))
            return this.reader.open({chainId:this.options.chainId,...checkpoint});
        await this.control();
        return this.reader.open({chainId: this.options.chainId, ...checkpoint});
    }
    async head(): Promise<ProjectionCheckpoint> {
        if(this.diskHistory){const baseline=await this.diskHistory.catalog.baseline();
            try{const control=await this.control();if(control.head.blockNum>baseline.source.blockNum){
                const proof=await this.open({blockNum:control.head.blockNum,blockId:control.head.blockId});await this.revalidate(proof);
                return Object.freeze({blockNum:proof.source.blockNum,blockId:proof.source.blockId});}}
            catch(error){if(!(error instanceof ProtocolAbiProofUnavailableError)||error.code!=='projection_source_unavailable')throw error;}
            return Object.freeze({blockNum:baseline.source.blockNum,blockId:baseline.source.blockId});}
        const control = await this.control();
        const proof = await this.open({blockNum: control.head.blockNum, blockId: control.head.blockId});
        await this.revalidate(proof);
        return Object.freeze({blockNum: proof.source.blockNum, blockId: proof.source.blockId});
    }
    /** The source's reported LIB, proven on the current canonical branch. Never above the covered head. */
    async irreversibleTarget(): Promise<ProjectionCheckpoint> {
        const head = await this.head();
        // The disk catalog ends at its irreversible boundary, so its head needs no live report.
        if (this.diskHistory && await this.diskHistory.catalog.covers({chainId: this.options.chainId, ...head})) return head;
        const proof = await this.open(head);
        const {selection, context} = await this.retained(() => this.bindings.readSelection(proof.selectionId));
        if (json(selection.source) !== json(proof.source) || context.chainId !== this.options.chainId
            || json(context.protocol) !== json(this.options.profile)) unavailable('Source finality selection does not match its head');
        const reported = Object.freeze({blockNum: selection.irreversible.blockNum, blockId: selection.irreversible.blockId});
        this.assertIrreversibleProgress(reported);
        let target: ProjectionCheckpoint = reported;
        // During replay the reported LIB can pass coverage: every covered block is then already irreversible.
        if (reported.blockNum > head.blockNum) target = head;
        else if (reported.blockNum > 0) {
            const irreversible = await this.open(reported);
            if (irreversible.source.blockId !== reported.blockId) unavailable('Reported irreversible block is not canonical');
            await this.revalidate(irreversible);
        }
        await this.revalidate(proof);
        // Probes and drains overlap on this source, so a slower older call must not lower the fence.
        this.assertIrreversibleProgress(reported);
        this.lastIrreversible = reported;
        return target;
    }
    private assertIrreversibleProgress(reported: ProjectionCheckpoint): void {
        const prior = this.lastIrreversible;
        if (prior && (reported.blockNum < prior.blockNum || (reported.blockNum === prior.blockNum && reported.blockId !== prior.blockId)))
            unavailable('Source irreversible position regressed or changed identity');
    }
    /** Resolve one immutable template version from an actual canonical view, never from operator ABI pins. */
    async statefulSelectors(templates: readonly Omit<StatefulSelector, 'abiDeployment' | 'abiSha256'>[]): Promise<{
        selectors: readonly StatefulSelector[]; proof: ProtocolAbiProofView}> {
        const selected = JSON.parse(json(templates)) as typeof templates;
        const proof = await this.open(await this.head()), epochs = new Map<string, ReturnType<typeof statefulAbiEpoch>>();
        const selectors: StatefulSelector[] = [];
        for (const template of selected) {
            let epoch = epochs.get(template.contract);
            if (!epoch) {epoch = statefulAbiEpoch(await this.reader.finalState(proof, template.contract)); epochs.set(template.contract, epoch);}
            selectors.push(Object.freeze({...template, abiDeployment: epoch.id, abiSha256: epoch.abiSha256}));
        }
        await this.revalidate(proof);
        return Object.freeze({selectors: Object.freeze(selectors), proof});
    }
    async revalidate(proof: ProtocolAbiProofView): Promise<void> {
        this.reader.assertConsumerScope(proof);
        if(this.diskHistory&&await this.diskHistory.catalog.covers(proof.source)){await this.reader.revalidate(proof);return;}
        await this.control();
        await this.reader.revalidate(proof);
    }
    private async definitionState(proof: ProtocolAbiProofView, definition: SourceDefinition, allowBeforeDeployment: boolean) {
        const state = await this.reader.inspectFinalState(proof, definition.source.contract);
        if (state?.present && state.abiHex) {
            const deployment = protocolDeployment(this.options.provider, {account: state.account, block: state.source.blockNum,
                block_id: state.source.blockId, abi_hex: state.abiHex, protocol_profile: state.protocol.profileId},
            state.account, proof.source.blockNum, proof.source.blockId);
            if (deployment.id !== definition.source.abiDeployment || digest(Buffer.from(deployment.abiHex, 'hex')) !== definition.source.abiSha256)
                throw new ProjectionContractError('projection.invalid-contract', 'Canonical ABI epoch does not match this fixed projection definition');
            return deployment;
        }
        if (!allowBeforeDeployment) throw new ProjectionContractError('projection.incomplete', 'Projection definition ABI is not currently deployed');
        // Null under complete genesis coverage means never observed. Empty/deleted states retain provenance:
        // look behind each empty epoch so an active ABI clear cannot masquerade as first deployment absence.
        let prior = state;
        for (let count = 0; prior !== null && count <= this.maximumAncestry; count++) {
            if (prior.present && prior.abiHex)
                throw new ProjectionContractError('projection.invalid-contract', 'An active projection ABI was cleared or removed');
            if (prior.source.blockNum === 1) return undefined;
            prior = await this.reader.inspectFinalState(proof, definition.source.contract, {atBlockNum: prior.source.blockNum - 1});
        }
        if (prior !== null) unavailable('Pre-deployment ABI history exceeds bounded inspection');
        return undefined;
    }
    /** Serving requires the fixed ABI at both the completed view and current canonical head. */
    assertDefinition(proof: ProtocolAbiProofView, definition: ProjectionDefinition): Promise<void> {
        return this.assertSourceDefinition(proof, definition);
    }
    async assertContextualDefinition(proof: ProtocolAbiProofView, definition: ContextualProjectionDefinition): Promise<void> {
        return this.assertSourceDefinition(proof, contextualChecked(validateContextualProjectionDefinition(definition)));
    }
    private async assertSourceDefinition(proof: ProtocolAbiProofView, definition: SourceDefinition): Promise<void> {
        this.reader.assertConsumerScope(proof);
        await this.definitionState(proof, definition, false);
        const control = await this.control();
        const current = await this.open({blockNum: control.head.blockNum, blockId: control.head.blockId});
        await this.definitionState(current, definition, false);
        await this.revalidate(proof);
        // Revalidation accepts newer canonical ancestry. Only the final exact head check can settle this ABI decision.
        const settled = await this.control();
        if (settled.ownerId !== control.ownerId || settled.generation !== control.generation
            || settled.head.commitId !== control.head.commitId)
            throw new ProjectionContractError('projection.stale-view', 'Canonical ABI head changed during definition validation');
    }
    private async canonicalTarget(blockNum: number, admitCanonicalTarget?: (block: ProjectionBlock) => Promise<void>) {
        if (!Number.isSafeInteger(blockNum) || blockNum < 1) unavailable('Invalid source height');
        if(this.diskHistory){const blockId=await this.diskHistory.catalog.blockId(blockNum);
            if(blockId){let publication;
                try{publication=await this.retained(()=>this.bindings.readPublishedSource(this.options.chainId,blockId));}
                catch(error){if(error instanceof ProtocolSourceBindingReadError&&['missing','incomplete'].includes(error.code))
                    throw new ProtocolAbiProofUnavailableError('source_publication_pending','Original source capture has not been published');throw error;}
                const proof=await this.reader.open({chainId:this.options.chainId,blockNum,blockId},publication.selectionId);
                await admitCanonicalTarget?.(Object.freeze({blockNum,blockId,previousBlockId:proof.source.previousBlockId??zero}));
                return {proof,commit:publication};}}
        const control = await this.control();
        if (blockNum > control.head.blockNum) unavailable('Next projection source has not committed');
        if (control.head.blockNum - blockNum > this.maximumAncestry && this.options.historicalCertificates === true) {
            const proof = await this.reader.openHistorical(blockNum);
            const commit: any = await this.retained(() => this.store.readCommit(proof.commitId));
            await this.revalidate(proof);
            if (proof.source.blockNum !== blockNum || commit.selectionId !== proof.selectionId)
                unavailable('Historical projection source authority changed');
            await admitCanonicalTarget?.(Object.freeze({blockNum, blockId: proof.source.blockId,
                previousBlockId: proof.source.previousBlockId ?? zero}));
            return {commit, proof};
        }
        if (control.head.blockNum - blockNum > this.maximumAncestry) {
            const head = await this.open({blockNum: control.head.blockNum, blockId: control.head.blockId});
            const target = Object.freeze({blockNum: head.source.blockNum, blockId: head.source.blockId,
                previousBlockId: head.source.previousBlockId ?? zero});
            await admitCanonicalTarget?.(target);
            throw new PortableProjectionFrameError(target,
            new Error('Projection source is outside bounded canonical ancestry; historical recovery input is required'));
        }
        let commitId: string = control.head.commitId, commit: any, child: any;
        for (let distance = 0; distance <= this.maximumAncestry; distance++) {
            commit = await this.retained(() => this.store.readCommit(commitId));
            if (child && (commit.source?.blockNum + 1 !== child.source?.blockNum
                || commit.source?.blockId !== child.source?.previousBlockId)) unavailable('Projection ancestry is not contiguous');
            if (commit.source?.blockNum === blockNum) break;
            if (!commit.previousCommitId || commit.source?.blockNum < blockNum) unavailable('Projection source is not retained');
            child = commit; commitId = commit.previousCommitId;
        }
        const proof = await this.open({blockNum, blockId: commit.source?.blockId});
        if (proof.commitId !== commitId || proof.selectionId !== commit.selectionId) unavailable('Projection source authority changed');
        // A failed capture/ABI/provider interpretation must not leave an older completed view serving.
        // Admission failures stay outside the interpretation catch: no contract work has started yet.
        await admitCanonicalTarget?.(Object.freeze({blockNum, blockId: proof.source.blockId,
            previousBlockId: proof.source.previousBlockId ?? zero}));
        return {commit, proof};
    }
    private rawTarget(commit: any, proof: ProtocolAbiProofView): PortableProjectionRawTarget {
        if (!/^h45abi1:[0-9a-f]{64}$/.test(commit.observationId) || !/^[0-9a-f]{64}$/.test(commit.observationDigest))
            unavailable('Canonical source lacks an original observation reference');
        return Object.freeze({block: Object.freeze({blockNum: proof.source.blockNum, blockId: proof.source.blockId,
            previousBlockId: proof.source.previousBlockId ?? zero}), reference: Object.freeze({commitId: proof.commitId,
            selectionId: proof.selectionId, observationId: commit.observationId as string, observationDigest: commit.observationDigest as string})});
    }
    private async originalCapture(commit: any, proof: ProtocolAbiProofView): Promise<Omit<PortableProjectionOriginalBlock, 'target'>> {
        const {selection, context} = await this.retained(() => this.bindings.readSelection(proof.selectionId));
        const link = await this.retained(() => this.bindings.readObservationLink(proof.selectionId));
        const observation = await this.retained(() => this.observations.read(link.observationId));
        if (link.observationId !== commit.observationId || link.observationDigest !== commit.observationDigest
            || protocolAbiObservationId(observation) !== link.observationId || digest(json(observation)) !== link.observationDigest
            || json(selection.source) !== json(proof.source) || json(context.protocol) !== json(this.options.profile)
            || json(observation.protocol) !== json(this.options.profile) || context.chainId !== this.options.chainId
            || observation.source.inputSha256 !== selection.captureSha256
            || json({...proof.source, inputSha256: selection.captureSha256}) !== json(observation.source)
            || observation.capture.schemaJson !== context.schemaJson) unavailable('Projection source capture/link identity mismatch');
        const evidence = Object.freeze({certificateId: proof.certificateId, commitId: proof.commitId,
            selectionId: proof.selectionId, observationId: link.observationId, observationDigest: link.observationDigest,
            captureSha256: selection.captureSha256, frameSha256: selection.frameSha256});
        return Object.freeze({proof, selection, context, observation, evidence});
    }
    /**
     * The actual mixed-input owner must retain the raw target before a missing/malformed capture
     * can fail. No decoded data/time/hash placeholder is needed by that admission callback.
     */
    async originalBlock(blockNum: number, admitRawTarget: (target: PortableProjectionRawTarget) => Promise<void>): Promise<PortableProjectionOriginalBlock> {
        if (!Number.isSafeInteger(blockNum) || blockNum < 1) unavailable('Invalid source height');
        const scope = currentProofConsumerScope(this.options.requireAttemptScope);
        const {commit, proof} = await this.canonicalTarget(blockNum);
        scope?.assertActive();
        const target = this.rawTarget(commit, proof);
        await trackProofConsumerOperation(() => admitRawTarget(target), scope);
        scope?.assertActive();
        const original = await this.originalCapture(commit, proof);
        await this.revalidate(proof);
        return Object.freeze({...original, target});
    }
    /** Complete original action/table input under the version2 owner, independent of history filters. */
    async statefulBlock(blockNum: number, declaration: StatefulOwnerDeclarationV2,
        admitRawTarget: (target: PortableProjectionRawTarget) => Promise<void>,
        metadataOptions: import('@eosrio/hyperion-sdk/projection-stateful-source-v2').StatefulActionMetadataOptionsV2 = {}): Promise<PortableStatefulFrameV2> {
        const metadata = statefulActionMetadataSelection(metadataOptions);
        const packet = await this.originalBlock(blockNum, admitRawTarget);
        if (blockNum === 1) verifyNativeGenesisRecord(packet.observation, this.options.provider.verifyNativeGenesis?.bind(this.options.provider));
        let native: ProtocolNativeActionReader | undefined;
        let nativeView: Awaited<ReturnType<ProtocolNativeActionReader['open']>> | undefined;
        const authorize = this.options.provider.nativeActions ? async (input: Parameters<ProtocolNativeActionReader['authorize']>[1]) => {
            if (!native) native = new ProtocolNativeActionReader({chainId: this.options.chainId, profile: this.options.profile,
                provider: this.options.provider, proofReader: this.reader,
                store: new ProtocolNativeObservationStore(this.options.client, this.options.chain, this.options.replicas ?? 0,
                    undefined, {readOnly: true})});
            nativeView ??= await native.open(packet.proof.source, packet.proof.selectionId);
            const decision = await native.authorize(nativeView, input);
            if (decision.kind !== 'contract') unavailable('Selected stateful action is not a qualified contract action');
        } : undefined;
        const source = await decodeStatefulSourceV2(declaration, packet, this.options.provider, this.reader, authorize, metadata);
        if (native && nativeView) await native.revalidate(nativeView);
        await this.revalidate(packet.proof);
        return Object.freeze({source, proof: packet.proof, evidence: packet.evidence});
    }
    /** The completed view's applicable epochs and current ancestry govern version2 serving. */
    async assertStatefulView(proof: ProtocolAbiProofView, declaration: StatefulOwnerDeclarationV2): Promise<void> {
        this.reader.assertConsumerScope(proof);
        if (declaration.projection.definition.binding.chainId !== this.options.chainId) unavailable('Stateful view chain differs');
        const groups = new Map<string, typeof declaration.projection.definition.selectors[number][]>();
        for (const selector of declaration.projection.definition.selectors) {
            const key = json([selector.kind, selector.contract, selector.name]);
            groups.set(key, [...groups.get(key) ?? [], selector]);
        }
        for (const selectors of groups.values()) {
            const epoch = statefulAbiEpoch(await this.reader.finalState(proof, selectors[0].contract));
            if (!selectors.some(selector => selector.abiDeployment === epoch.id && selector.abiSha256 === epoch.abiSha256))
                unavailable('Completed stateful view lacks its applicable selector ABI epoch');
        }
        await this.revalidate(proof);
    }
    /** Bounded certified ancestry; missing old input never becomes an empty frame. */
    frame(blockNum: number, definition: ProjectionDefinition,
                admitCanonicalTarget?: (block: ProjectionBlock) => Promise<void>): Promise<PortableProjectionFrame> {
        return this.readFrame(blockNum, definition, admitCanonicalTarget, frame => frame, false);
    }
    /** Separate opt-in source shape; legacy frames never gain a contextual field implicitly. */
    async contextualFrame(blockNum: number, definition: ContextualProjectionDefinition,
        admitCanonicalTarget?: (block: ProjectionBlock) => Promise<void>): Promise<PortableContextualProjectionFrame> {
        const selected = contextualChecked(validateContextualProjectionDefinition(definition));
        return this.readFrame(blockNum, selected, admitCanonicalTarget, (frame, timestamp) => ({...frame,
            context: {contract: selected.source.contract, table: selected.source.table,
                blockTimeMs: originalProjectionTimeMs(timestamp)}}), true);
    }
    /** Recheck the original source-point ABI/mapping after an awaited host/adapter operation. */
    async revalidateContextualFrame(proof: ProtocolAbiProofView, definition: ContextualProjectionDefinition): Promise<void> {
        const selected = contextualChecked(validateContextualProjectionDefinition(definition));
        this.reader.assertConsumerScope(proof);
        await this.definitionState(proof, selected, true);
        await this.revalidate(proof);
    }
    private async readFrame<F extends ProjectionFrame>(blockNum: number, definition: SourceDefinition,
        admitCanonicalTarget: ((block: ProjectionBlock) => Promise<void>) | undefined,
        finish: (frame: ProjectionFrame, timestamp: unknown) => F, contextual: boolean):
        Promise<{frame: F; proof: ProtocolAbiProofView; evidence: PortableProjectionSourceEvidence}> {
        if (!Number.isSafeInteger(blockNum) || blockNum < 1) unavailable('Invalid source height');
        const scope = currentProofConsumerScope(this.options.requireAttemptScope);
        const {commit, proof} = await this.canonicalTarget(blockNum, admitCanonicalTarget);
        try {
        const {selection, context, observation, evidence} = await this.originalCapture(commit, proof);
        const selectedDefinitionDeployment = await this.definitionState(proof, definition, true);
        if (blockNum === 1) {
            verifyNativeGenesisRecord(observation, this.options.provider.verifyNativeGenesis?.bind(this.options.provider));
            const frame = await this.reader.nativeGenesisFrame(proof);
            let timestamp: unknown;
            if (contextual) {
                const blockHex = observation.capture.blockHex;
                if (!blockHex) unavailable('Original genesis header is unavailable for contextual mapping');
                const session = this.options.provider.createShipSession(JSON.parse(context.schemaJson));
                try {timestamp = (session.decodeBlock(Buffer.from(blockHex!, 'hex')) as {timestamp?: unknown}).timestamp;}
                finally {session.close?.();}
                await this.definitionState(proof, definition, true);
            }
            await this.revalidate(proof);
            return {frame: finish(frame, timestamp), proof, evidence};
        }
        const capture = observation.capture;
        if (!capture.blockHex || capture.tracesHex === null || capture.deltasHex === null
            || !proof.source.previousBlockId || proof.source.previousBlockId === zero) unavailable('Projection source lacks complete original sections');
        const blockHex = capture.blockHex!, tracesHex = capture.tracesHex!, deltasHex = capture.deltasHex!;
        const previousBlockId = proof.source.previousBlockId!;
        const session = this.options.provider.createShipSession(JSON.parse(context.schemaJson));
        try {
            const block: any = session.decodeBlock(Buffer.from(blockHex, 'hex'));
            const originalTimestamp: unknown = contextual ? block.timestamp : undefined;
            if (String(block.previous).toLowerCase() !== previousBlockId) unavailable('Projection header predecessor mismatch');
            // Consume original traces too: missing or malformed source cannot prove an empty table block.
            session.decodeTraces(Buffer.from(tracesHex, 'hex'));
            const deltas: any = session.decodeDeltas(Buffer.from(deltasHex, 'hex'));
            if (!Array.isArray(deltas)) unavailable('Projection deltas are not a complete vector');
            const changes: ProjectionTableChange[] = [];
            let ordinal = 0;
            let deployment: ReturnType<typeof protocolDeployment> | undefined = selectedDefinitionDeployment;
            for (const delta of deltas) {
                if (!Array.isArray(delta) || !['table_delta_v0', 'table_delta_v1'].includes(delta[0])
                    || !Array.isArray(delta[1]?.rows)) unavailable('Invalid projection delta framing');
                for (const row of delta[1].rows) {
                    if (![true, false, 0, 1].includes(row.present)) unavailable('Invalid projection row presence');
                    const raw = Buffer.from(row.data, 'hex'), value = session.decodeRow(delta[1].name, raw);
                    const position = {chainId: this.options.chainId, blockNum, blockId: proof.source.blockId, ordinal: ordinal++};
                    const input = {stream: delta[1].name, present: row.present === true || row.present === 1, raw, value};
                    let normalized = this.options.provider.normalizeDelta(input, position);
                    if (normalized.kind === 'passthrough' && input.stream === 'contract_row') {
                        // The common legacy table stream is not a KV normalization result. Never certify its
                        // selected rows as an empty block merely because this first worker handles normalized rows.
                        const legacy = Array.isArray(normalized.value) ? normalized.value[1] : undefined;
                        if (!legacy || typeof legacy.code !== 'string' || typeof legacy.table !== 'string'
                            || (legacy.code === definition.source.contract && legacy.table === definition.source.table))
                            throw new ProjectionContractError('projection.capability-unavailable', 'Selected legacy table rows require a qualified portable protocol normalizer');
                    }
                    if (normalized.kind === 'abi-required') {
                        if (normalized.account !== definition.source.contract) continue;
                        if (!deployment) {
                            const state = await this.reader.finalState(proof, normalized.account);
                            deployment = protocolDeployment(this.options.provider, {account: state.account, block: state.source.blockNum,
                                block_id: state.source.blockId, abi_hex: state.abiHex, protocol_profile: state.protocol.profileId},
                            state.account, blockNum, proof.source.blockId);
                        }
                        normalized = this.options.provider.normalizeDelta(input, {...position, abiDeployment: deployment});
                        if (normalized.kind === 'abi-required') unavailable('Provider repeated a source ABI dependency');
                    }
                    if (normalized.kind !== 'record' || normalized.metadata.recordKind !== 'row'
                        || normalized.metadata.code !== definition.source.contract || normalized.tableName !== definition.source.table) continue;
                    if (!deployment || normalized.source.chainId !== position.chainId || normalized.source.blockId !== position.blockId
                        || normalized.source.blockNum !== blockNum || normalized.source.ordinal !== position.ordinal
                        || normalized.source.abiDeployment !== deployment.id || normalized.metadata.present !== input.present)
                        unavailable('Provider changed projection source provenance');
                    changes.push({contract: definition.source.contract, table: normalized.tableName, scope: '',
                        primaryKey: normalized.identity, abiDeployment: deployment!.id, abiSha256: digest(Buffer.from(deployment!.abiHex, 'hex')),
                        present: input.present, ...(input.present ? {value: normalized.value} : {})});
                    if (changes.length > 1000) throw new ProjectionContractError('projection.invalid-contract', 'Projection frame exceeds its bounded mutation count');
                }
            }
            if (contextual) await this.definitionState(proof, definition, true);
            await this.revalidate(proof);
            return {frame: finish({chainId: this.options.chainId, block: {blockNum, blockId: proof.source.blockId,
                previousBlockId}, changes}, originalTimestamp), proof, evidence};
        } finally {session.close?.();}
        } catch (error) {
            // Preserve exact error ownership after cancellation; wrapping cannot grant or erase recovery authority.
            if (scope?.signal.aborted) throw error;
            throw new PortableProjectionFrameError({blockNum, blockId: proof.source.blockId,
                previousBlockId: proof.source.previousBlockId ?? zero}, error);
        }
    }
}
