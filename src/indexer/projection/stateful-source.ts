import {createHash} from 'node:crypto';
import type {ProtocolAbiActionInput, ProtocolAbiDeployment, ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import type {StatefulSelector} from '@eosrio/hyperion-sdk/projection-stateful';
import type {StatefulOwnerDeclarationV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {captureStatefulSourceV2, STATEFUL_ACTION_AUTHORIZATION_CAPABILITY_V1,
    type CapturedStatefulSourceV2, type StatefulActionMetadataOptionsV2, type StatefulInputV2} from '@eosrio/hyperion-sdk/projection-stateful-source-v2';
import {deriveProtocolActionOccurrences} from '../history/action-source-inventory.js';
import {ProtocolAbiProofUnavailableError, type ProtocolAbiProofReader} from '../protocol/abi-proof.js';
import type {ProtocolAbiAccountState} from '../protocol/abi-reducer.js';
import {protocolImmutableJson} from '../protocol/immutable-bundle-store.js';
import type {PortableProjectionOriginalBlock} from './source.js';
import {statefulAbiEpoch} from './stateful-abi-epoch.js';

const hash = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
const json = protocolImmutableJson;
/** This producer copies the authorization already validated from the complete original trace. */
export const STATEFUL_SOURCE_CAPABILITIES_V2 = Object.freeze([STATEFUL_ACTION_AUTHORIZATION_CAPABILITY_V1]);
function requireSource(value: unknown, message: string): asserts value {
    if (!value) throw new ProtocolAbiProofUnavailableError('stateful_source_unavailable', message);
}
export function statefulActionMetadataSelection(options: StatefulActionMetadataOptionsV2): StatefulActionMetadataOptionsV2 {
    const metadata = JSON.parse(json(options));
    requireSource(metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
        && (Object.keys(metadata).length === 0 || Object.keys(metadata).length === 1
        && Object.hasOwn(metadata, 'actionMetadataVersion') && metadata.actionMetadataVersion === 1), 'Unsupported stateful action metadata selection');
    return Object.freeze(metadata);
}
function originalTime(value: unknown): string {
    requireSource(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?$/.test(value), 'Original block time is absent');
    const timestamp = value.endsWith('Z') ? value : value + 'Z', time = Date.parse(timestamp);
    requireSource(Number.isSafeInteger(time) && time >= 0, 'Original block time is invalid');
    requireSource(new Date(time).toISOString() === timestamp.replace(/(?:\.(\d{1,3}))?Z$/, (_all, fraction) => '.' + (fraction ?? '').padEnd(3, '0') + 'Z'),
        'Original block time is not canonical');
    return String(time);
}

/** Internal decoder used only after the actual source has admitted and verified its original packet. */
export async function decodeStatefulSourceV2(declaration: StatefulOwnerDeclarationV2, packet: PortableProjectionOriginalBlock,
    provider: ProtocolProvider, reader: ProtocolAbiProofReader,
    authorizeContract?: (input: ProtocolAbiActionInput) => Promise<void>,
    metadataOptions: StatefulActionMetadataOptionsV2 = {}): Promise<CapturedStatefulSourceV2> {
    // Capture the selected mode before the first await; unknown variants never fall back to legacy.
    const metadata = statefulActionMetadataSelection(metadataOptions);
    const actionMetadata = metadata.actionMetadataVersion === 1;
    const d = declaration.projection, {proof, observation, context, target} = packet;
    requireSource(d.definition.binding.chainId === proof.source.chainId, 'Stateful declaration belongs to another chain');
    reader.assertConsumerScope(proof);
    const capture = observation.capture, genesis = target.block.blockNum === 1;
    requireSource(capture.blockHex !== null && (genesis || capture.tracesHex !== null && capture.deltasHex !== null),
        'Stateful source lacks complete original sections');
    const session = provider.createShipSession(JSON.parse(context.schemaJson));
    try {
        const header: any = session.decodeBlock(Buffer.from(capture.blockHex!, 'hex'));
        requireSource(String(header.previous).toLowerCase() === target.block.previousBlockId, 'Stateful header predecessor differs');
        const block = {...target.block, timeMs: originalTime(header.timestamp)};
        const previous = {blockNum: block.blockNum - 1, blockId: block.previousBlockId};
        if (genesis) {
            // The caller verifies native genesis; this issued reader proves empty application state.
            const frame = await reader.nativeGenesisFrame(proof);
            requireSource(json(frame.block) === json(target.block), 'Native genesis block differs');
            return captureStatefulSourceV2(declaration, {previous, block, inputs: [], ...metadata});
        }
        requireSource(block.previousBlockId !== '0'.repeat(64), 'Non-genesis predecessor is absent');
        // Decode both whole vectors before selection. History filters never enter this path.
        const traces: any = session.decodeTraces(Buffer.from(capture.tracesHex!, 'hex'));
        const deltas: any = session.decodeDeltas(Buffer.from(capture.deltasHex!, 'hex'));
        const occurrences = deriveProtocolActionOccurrences(traces);
        requireSource(Array.isArray(deltas), 'Original stateful deltas are not a vector');
        const inputs: StatefulInputV2[] = [];
        const deployments = new Map<string, ProtocolAbiDeployment>();
        const deployment = (state: ProtocolAbiAccountState) => {
            const epoch = statefulAbiEpoch(state);
            let selected = deployments.get(epoch.id);
            if (!selected) {
                selected = {id: epoch.id, from: {blockNum: state.source.blockNum, ordinal: 0}, abiHex: state.abiHex,
                    abi: provider.contractCodec.decodeAbi(Buffer.from(state.abiHex, 'hex'))};
                deployments.set(epoch.id, selected);
            }
            return {...epoch, deployment: selected};
        };
        const matching = (kind: 'action' | 'table', contract: string, name: string) =>
            d.definition.selectors.filter(value => value.kind === kind && value.contract === contract && value.name === name);
        const select = (selectors: readonly StatefulSelector[], epoch: ReturnType<typeof deployment>) => {
            const matches = selectors.filter(value => value.abiDeployment === epoch.id && value.abiSha256 === epoch.abiSha256);
            requireSource(matches.length === 1, 'Applicable stateful selector ABI epoch is missing or ambiguous');
            return matches[0];
        };
        // Immutable journal addresses are stable across later head certificates and exact retries.
        const {certificateId: _headCertificate, ...originalEvidence} = packet.evidence;
        const evidence = (coordinate: unknown) => hash(json(['hyperion-stateful-original-input-v2', originalEvidence, coordinate]));
        const common = (selector: StatefulSelector, rawHex: string, coordinate: unknown) => ({selector: selector.id,
            order: inputs.length, contract: selector.contract, name: selector.name, abiDeployment: selector.abiDeployment,
            abiSha256: selector.abiSha256, mappingRevision: d.definition.binding.mappingRevision,
            codecRevision: d.definition.binding.codecRevision, normalizerRevision: d.definition.binding.normalizerRevision,
            rawHex, rawSha256: hash(Buffer.from(rawHex, 'hex')), sourceEvidence: evidence(coordinate)});
        const add = (input: StatefulInputV2) => {
            requireSource(inputs.length < d.limits.inputOccurrences, 'Stateful original occurrence budget exceeded');
            inputs.push(input);
        };
        const coordinates = new Map<string, {traceOrdinal: number; receiptOrdinal: number}>();
        for (const [traceOrdinal, trace] of traces.entries()) for (const [receiptOrdinal, item] of trace[1].action_traces.entries())
            coordinates.set(`${trace[1].id}:${item[1].action_ordinal}`, {traceOrdinal, receiptOrdinal});
        // Receipt sequence establishes execution order; coordinates remain the original vector positions.
        const actions = [...occurrences].sort((a, b) => BigInt(a.input.globalSequence) < BigInt(b.input.globalSequence) ? -1 : 1);
        for (const occurrence of actions) {
            const original = occurrence.input, selectors = matching('action', original.account, original.name);
            if (!selectors.length) continue;
            await authorizeContract?.(original);
            const resolved = await reader.action(proof, original), epoch = deployment(resolved.state), selector = select(selectors, epoch);
            const abi: any = epoch.deployment.abi;
            const type = abi.actions?.find((value: any) => value.name === original.name)?.type;
            requireSource(typeof type === 'string' && type.length > 0, 'Selected original action has no ABI type');
            const coordinate = coordinates.get(`${original.transactionId}:${original.actionOrdinal}`);
            requireSource(coordinate, 'Original action coordinate is absent');
            const data = provider.contractCodec.decodeValue(abi, type, Buffer.from(original.rawHex, 'hex'));
            const authorization = occurrence.authorization.map(value => {
                const {actor, permission} = value;
                requireSource(typeof actor === 'string' && typeof permission === 'string', 'Validated original authorization is invalid');
                return {actor, permission};
            });
            add({...common(selector, original.rawHex, {kind: 'action', ...coordinate, input: original,
                ...(actionMetadata ? {authorization} : {})}), kind: 'action',
                transactionId: original.transactionId, actionOrdinal: original.actionOrdinal, receiver: original.receiver,
                receiptOrdinal: coordinate.receiptOrdinal, sequence: original.globalSequence, data: data as Record<string, any>,
                ...(actionMetadata ? {authorization} : {})});
        }
        const hasTables = d.definition.selectors.some(value => value.kind === 'table');
        const tables = provider.statefulTables;
        requireSource(!hasTables || tables?.interfaceVersion === 2, 'Stateful source requires original table interface2');
        let ordinal = 0;
        for (const [deltaOrdinal, delta] of deltas.entries()) {
            requireSource(Array.isArray(delta) && ['table_delta_v0', 'table_delta_v1'].includes(delta[0])
                && typeof delta[1]?.name === 'string' && Array.isArray(delta[1]?.rows), 'Invalid original delta framing');
            for (const [rowOrdinal, row] of delta[1].rows.entries()) {
                requireSource([true, false, 0, 1].includes(row.present) && typeof row.data === 'string'
                    && /^(?:[0-9a-fA-F]{2})*$/.test(row.data), 'Invalid original delta row');
                const rawHex = row.data.toLowerCase(), raw = Buffer.from(rawHex, 'hex');
                const value = session.decodeRow(delta[1].name, raw);
                const position = {chainId: proof.source.chainId, blockNum: block.blockNum, blockId: block.blockId, ordinal: ordinal++};
                if (!hasTables) continue;
                const original = {stream: delta[1].name, present: row.present === true || row.present === 1, raw, value};
                let normalized = tables!.normalizeDelta(original, position), epoch: ReturnType<typeof deployment> | undefined;
                if (normalized.kind === 'abi-required') {
                    const account = normalized.account;
                    if (!d.definition.selectors.some(value => value.kind === 'table' && value.contract === account)) continue;
                    epoch = deployment(await reader.finalState(proof, account));
                    normalized = tables!.normalizeDelta(original, {...position, abiDeployment: epoch.deployment});
                }
                requireSource(normalized.kind !== 'abi-required', 'Stateful table provider repeated ABI dependency');
                if (normalized.kind !== 'table') continue;
                const selectors = matching('table', normalized.contract, normalized.tableName);
                if (!selectors.length) continue;
                requireSource(epoch && json(normalized.source) === json({...position, abiDeployment: epoch.id})
                    && normalized.present === original.present, 'Stateful table provider changed original provenance');
                const selector = select(selectors, epoch);
                add({...common(selector, rawHex, {kind: 'table', deltaOrdinal, rowOrdinal, position}), kind: 'table',
                    transactionId: null, identity: normalized.identity, payer: normalized.payer, present: original.present,
                    deltaOrdinal, rowOrdinal, data: normalized.value as Record<string, any> | null});
            }
        }
        await reader.revalidate(proof);
        return captureStatefulSourceV2(declaration, {previous, block, inputs, ...metadata});
    } finally {session.close?.();}
}
