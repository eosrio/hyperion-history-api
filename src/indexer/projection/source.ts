import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
import type {ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import {ProjectionContractError, type ProjectionBlock, type ProjectionCheckpoint, type ProjectionDefinition} from '@eosrio/hyperion-sdk/projection';
import {ProtocolAbiFrontierStore} from '../protocol/abi-frontier-store.js';
import {ProtocolAbiProofReader, ProtocolAbiProofUnavailableError, type ProtocolAbiProofView} from '../protocol/abi-proof.js';
import {ProtocolAbiObservationStore, protocolAbiObservationId} from '../protocol/abi-observation-store.js';
import {ProtocolSourceBindingStore, type ProtocolSourceProfile} from '../protocol/source-bindings.js';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';
import {protocolDeployment} from '../protocol/deployments.js';
import {verifyNativeGenesisRecord} from '../protocol/native-genesis.js';
import type {ProjectionFrame, ProjectionTableChange} from './runtime.js';
import {currentProofConsumerScope, trackProofConsumerOperation} from '../protocol/proof-consumer-scope.js';

const json = protocolImmutableJson;
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const zero = '0'.repeat(64);
const unavailable = (message: string): never => {throw new ProtocolAbiProofUnavailableError('projection_source_unavailable', message);};
export interface PortableProjectionSourceOptions {
    client: Client; chain: string; chainId: string; profile: ProtocolSourceProfile; provider: ProtocolProvider;
    maxAncestryBlocks?: number; replicas?: number; requireAttemptScope?: boolean;
}
export interface PortableProjectionSourceEvidence {
    readonly certificateId: string; readonly commitId: string; readonly selectionId: string;
    readonly observationId: string; readonly observationDigest: string; readonly captureSha256: string;
    readonly frameSha256: string;
}
export interface PortableProjectionFrame {
    readonly frame: ProjectionFrame; readonly proof: ProtocolAbiProofView; readonly evidence: PortableProjectionSourceEvidence;
}
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
    constructor(options: PortableProjectionSourceOptions) {
        this.maximumAncestry = options.maxAncestryBlocks ?? 256;
        this.options = {...options, profile: JSON.parse(json(options.profile))};
        this.store = new ProtocolAbiFrontierStore(options.client, options.chain, options.replicas ?? 0, {readOnly: true});
        this.bindings = new ProtocolSourceBindingStore(options.client, options.chain, options.replicas ?? 0, {readOnly: true});
        this.observations = new ProtocolAbiObservationStore(options.client, options.chain, options.replicas ?? 0, undefined, {readOnly: true});
        this.reader = new ProtocolAbiProofReader({chainId: options.chainId, profile: this.options.profile,
            store: this.store, maxAncestryBlocks: this.maximumAncestry, requireAttemptScope: options.requireAttemptScope});
    }
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
        await this.control();
        return this.reader.open({chainId: this.options.chainId, ...checkpoint});
    }
    async revalidate(proof: ProtocolAbiProofView): Promise<void> {
        this.reader.assertConsumerScope(proof);
        await this.control();
        await this.reader.revalidate(proof);
    }
    private async definitionState(proof: ProtocolAbiProofView, definition: ProjectionDefinition, allowBeforeDeployment: boolean) {
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
    async assertDefinition(proof: ProtocolAbiProofView, definition: ProjectionDefinition): Promise<void> {
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
    /** Bounded certified ancestry; missing old input never becomes an empty frame. */
    async frame(blockNum: number, definition: ProjectionDefinition,
                admitCanonicalTarget?: (block: ProjectionBlock) => Promise<void>): Promise<PortableProjectionFrame> {
        if (!Number.isSafeInteger(blockNum) || blockNum < 1) unavailable('Invalid source height');
        const scope = currentProofConsumerScope(this.options.requireAttemptScope);
        const control = await this.control();
        if (blockNum > control.head.blockNum) unavailable('Next projection source has not committed');
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
        try {
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
        const selectedDefinitionDeployment = await this.definitionState(proof, definition, true);
        if (blockNum === 1) {
            verifyNativeGenesisRecord(observation, this.options.provider.verifyNativeGenesis?.bind(this.options.provider));
            const frame = await this.reader.nativeGenesisFrame(proof);
            await this.revalidate(proof);
            return {frame, proof, evidence};
        }
        const capture = observation.capture;
        if (!capture.blockHex || capture.tracesHex === null || capture.deltasHex === null
            || !proof.source.previousBlockId || proof.source.previousBlockId === zero) unavailable('Projection source lacks complete original sections');
        const blockHex = capture.blockHex!, tracesHex = capture.tracesHex!, deltasHex = capture.deltasHex!;
        const previousBlockId = proof.source.previousBlockId!;
        const session = this.options.provider.createShipSession(JSON.parse(context.schemaJson));
        try {
            const block: any = session.decodeBlock(Buffer.from(blockHex, 'hex'));
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
            await this.revalidate(proof);
            return {frame: {chainId: this.options.chainId, block: {blockNum, blockId: proof.source.blockId,
                previousBlockId}, changes}, proof, evidence};
        } finally {session.close?.();}
        } catch (error) {
            // Preserve exact error ownership after cancellation; wrapping cannot grant or erase recovery authority.
            if (scope?.signal.aborted) throw error;
            throw new PortableProjectionFrameError({blockNum, blockId: proof.source.blockId,
                previousBlockId: proof.source.previousBlockId ?? zero}, error);
        }
    }
}
