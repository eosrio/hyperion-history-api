import {createHash} from 'node:crypto';
import {currentProofConsumerScope, assertProofConsumerCapability, trackProofConsumerOperation, proofConsumerSignal, ProofConsumerFencedError, type ProofConsumerScope} from './proof-consumer-scope.js';
import {serialize, deserialize} from 'node:v8';
import {validateProtocolNativeActions, type ProtocolAbiActionInput, type ProtocolNativeActions,
    type ProtocolNativeActionDecision, type ProtocolProvider} from '@eosrio/hyperion-sdk/protocol';
import {deriveProtocolActionOccurrences, type ProtocolOriginalActionOccurrence} from '../history/action-source-inventory.js';
import {ProtocolAbiProofReader, ProtocolAbiProofUnavailableError, type ProtocolAbiProofSource,
    type ProtocolAbiProofView, type ProtocolAbiProofReadOptions} from './abi-proof.js';
import {ProtocolNativeObservationStore, NativeObservationReadError} from './native-observation-store.js';
import type {ProtocolNativeActionProofMetadata, ProtocolNativeActionIncompleteMetadata} from './native-action-metadata.js';
export type {ProtocolNativeActionProofMetadata, ProtocolNativeActionIncompleteMetadata, ProtocolNativeActionSourceMetadata} from './native-action-metadata.js';
import {protocolNativeInputInventory, snapshotProtocolNativeDecisions} from './native-observation-facts.js';
import {protocolImmutableJson, ImmutableProtocolBundleReadError} from './immutable-bundle-store.js';
import {protocolSourceContextId, ProtocolSourceBindingReadError, type ProtocolSourceProfile} from './source-bindings.js';

/** Empty host-owned handles: neither their shape nor serialized copies confer authority. */
declare const viewBrand: unique symbol;
declare const grantBrand: unique symbol;
export interface ProtocolNativeActionView {readonly [viewBrand]: true}
export interface ProtocolNativeActionGrant {readonly [grantBrand]: true}
export type ProtocolNativeActionAuthorization =
    | {readonly kind: 'contract'}
    | {readonly kind: 'incomplete'; readonly error: {readonly code: string; readonly message: string}}
    | {readonly kind: 'native'; readonly grant: ProtocolNativeActionGrant};
export interface ProtocolNativeActionReaderOptions {
    readonly chainId: string;
    /** The host's loader-verified profile and coordinated component set, never journal-selected code. */
    readonly profile: ProtocolSourceProfile;
    readonly provider: ProtocolProvider;
    readonly store: ProtocolNativeObservationStore;
    readonly proofReader: ProtocolAbiProofReader;
}
/** Host-internal worker pairing. Standalone/API construction retains independent issuance. */
export interface ProtocolNativeWorkerReaders {
    readonly proofs: ProtocolAbiProofReader;
    readonly native: ProtocolNativeActionReader;
    waitForOpen(source: ProtocolAbiProofSource, selectionId: string,
        options?: ProtocolAbiProofReadOptions & {timeoutMs?: number}): Promise<{
        readonly view: ProtocolAbiProofView; readonly nativeView: ProtocolNativeActionView;
    }>;
}
export class ProtocolNativeActionUnavailableError extends Error {
    readonly statusCode = 503;
    constructor(readonly code: string, message: string) {super(message); this.name = 'ProtocolNativeActionUnavailableError';}
}
interface IssuedView {
    readonly scope?: ProofConsumerScope;
    readonly proof: ProtocolAbiProofView;
    readonly inputs: ReadonlyMap<string, ProtocolAbiActionInput>;
    readonly decisions: ReadonlyMap<string, ProtocolNativeActionDecision>;
    readonly provenance: Omit<ProtocolNativeActionProofMetadata['native'], 'nativeKind'>;
    readonly occurrences: ReadonlyMap<string, ProtocolOriginalActionOccurrence>;
    readonly receipts: ReadonlyMap<string, ProtocolOriginalActionOccurrence>;
}
interface IssuedGrant {readonly view: IssuedView; readonly input: ProtocolAbiActionInput; readonly nativeKind: string}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const key = (input: {transactionId: string; actionOrdinal: number}) => input.transactionId + ':' + input.actionOrdinal;
const json = (value: unknown) => protocolImmutableJson(value, 64 * 1024 * 1024);
const snapshot = <T>(value: T): T => JSON.parse(json(value));
function unavailable(code: string, message: string): never {throw new ProtocolNativeActionUnavailableError(code, message);}
function requireNative(value: unknown, message: string): asserts value {
    if (!value) unavailable('native_source_mismatch', message);
}
function requireSynchronousValue(value: unknown): void {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
    // Returning a thenable from an async method would resume it after our final canonical check.
    // Inspect descriptors without invoking getters; ordinary protocol values remain opaque.
    let owner: object | null = value;
    for (let depth = 0; owner && depth < 64; depth++, owner = Object.getPrototypeOf(owner)) {
        const property = Object.getOwnPropertyDescriptor(owner, 'then');
        if (!property) continue;
        if (!Object.hasOwn(property, 'value') || typeof property.value === 'function') {
            unavailable('native_value_unavailable', 'Native value decoding must be synchronous');
        }
        return;
    }
    if (owner) unavailable('native_value_unavailable', 'Native value prototype exceeds its bound');
}

/** Internal, read-only native authority. Installation/selection and public consumers remain separate.
 * Every opening replays retained original bytes; only the existing canonical reader issues membership.
 */
export class ProtocolNativeActionReader {
    private readonly chainId: string;
    private readonly profile: ProtocolSourceProfile;
    private readonly native: ProtocolNativeActions;
    private readonly createSession: ProtocolProvider['createShipSession'];
    private readonly store: ProtocolNativeObservationStore;
    private readonly proofs: ProtocolAbiProofReader;
    private readonly views = new WeakMap<ProtocolNativeActionView, IssuedView>();
    private readonly grants = new WeakMap<ProtocolNativeActionGrant, IssuedGrant>();
    private activeOpens = 0;

    constructor(options: ProtocolNativeActionReaderOptions) {
        protocolSourceContextId({schemaVersion: 1, chainId: options.chainId, protocol: options.profile, schemaJson: '{}'});
        this.chainId = options.chainId;
        this.profile = snapshot(options.profile);
        this.profile.components = [...this.profile.components].sort((a, b) => {
            const left = a.runtime + ':' + a.id, right = b.runtime + ':' + b.id;
            return left < right ? -1 : left > right ? 1 : 0;
        });
        if (options.provider.profileId !== this.profile.profileId || typeof options.provider.createShipSession !== 'function') {
            throw new Error('Native authorization requires its selected provider');
        }
        const checked = validateProtocolNativeActions(options.provider.nativeActions, {interfaceVersion: 1});
        if (!checked.valid) throw new Error('Native authorization requires the selected native interface');
        this.native = checked.nativeActions;
        this.createSession = options.provider.createShipSession.bind(options.provider);
        this.store = options.store.asReadOnly();
        this.proofs = options.proofReader.asReadOnly();
    }

    /** One fresh canonical opening, followed by the unchanged whole native-source verification.
     * Only this operation can unpack its own native view into the paired issuer's existing handles.
     * No view-adoption API, retained-pair lookup or cross-attempt opening cache is exposed.
     */
    static forWorker(options: ProtocolNativeActionReaderOptions): ProtocolNativeWorkerReaders {
        const native = new ProtocolNativeActionReader(options), proofs = native.proofs;
        return Object.freeze({native, proofs, async waitForOpen(source: ProtocolAbiProofSource, selectionId: string,
            options: ProtocolAbiProofReadOptions & {timeoutMs?: number} = {}) {
            const scope = currentProofConsumerScope(true), signal = proofConsumerSignal(options.signal);
            return trackProofConsumerOperation(async () => {
                const nativeView = await native.openSelected(source, selectionId, {...options, signal}, true, async proof => {
                    // Ordinary consumption permits monotone head progress. A NEW joint opening
                    // still needs the original bound after replay, within the existing eight slots.
                    await native.read(() => proofs.revalidateOpening(proof, {signal}), signal);
                    assertProofConsumerCapability(scope); currentProofConsumerScope(true); signal?.throwIfAborted();
                });
                assertProofConsumerCapability(scope); currentProofConsumerScope(true); signal?.throwIfAborted();
                const issued = native.views.get(nativeView)!;
                return Object.freeze({view: issued.proof, nativeView});
            }, scope);
        }});
    }

    private consume<T>(issued: IssuedView | undefined, operation: () => Promise<T>): Promise<T> {
        const scope = issued ? issued.scope : currentProofConsumerScope();
        assertProofConsumerCapability(scope); return trackProofConsumerOperation(operation, scope);
    }
    private async read<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        signal?.throwIfAborted();
        try {const result = await trackProofConsumerOperation(operation); signal?.throwIfAborted(); return result;}
        catch (error) {
            if (error instanceof ProofConsumerFencedError) throw error;
            signal?.throwIfAborted();
            if (error instanceof ProtocolAbiProofUnavailableError) unavailable(error.code, error.message);
            if (error instanceof NativeObservationReadError || error instanceof ProtocolSourceBindingReadError
                || error instanceof ImmutableProtocolBundleReadError) {
                unavailable('native_retained_' + error.code, 'Required native source evidence is unavailable or invalid');
            }
            unavailable('native_read_unavailable', 'Native authority or retained evidence cannot be read');
        }
    }
    private async revalidateIssued(view: IssuedView, options: ProtocolAbiProofReadOptions): Promise<void> {
        await this.read(() => this.proofs.revalidate(view.proof, options), options.signal);
    }

    async open(source: ProtocolAbiProofSource, selectionId: string,
               options: ProtocolAbiProofReadOptions = {}): Promise<ProtocolNativeActionView> {
        return this.openSelected(source, selectionId, options, false);
    }

    /** Worker handoff: bound canonical readiness, then verify native evidence once using that issued proof. */
    async waitForOpen(source: ProtocolAbiProofSource, selectionId: string,
                      options: ProtocolAbiProofReadOptions & {timeoutMs?: number} = {}): Promise<ProtocolNativeActionView> {
        return this.openSelected(source, selectionId, options, true);
    }

    private async openSelected(source: ProtocolAbiProofSource, selectionId: string,
                               {signal, timeoutMs}: ProtocolAbiProofReadOptions & {timeoutMs?: number},
                               wait: boolean, finishWorkerOpening?: (proof: ProtocolAbiProofView) => Promise<void>): Promise<ProtocolNativeActionView> {
        return this.consume(undefined,async () => {
        signal = proofConsumerSignal(signal);
        signal?.throwIfAborted();
        if (this.activeOpens >= 8) unavailable('native_busy', 'Native source verification read budget is exhausted');
        // A caller cannot change its request while its first storage read is pending.
        try {source = snapshot(source);}
        catch {signal?.throwIfAborted(); unavailable('native_source_mismatch', 'Native source is not portable');}
        requireNative(source && typeof source === 'object' && source.chainId === this.chainId,
            'Native source belongs to another chain');
        this.activeOpens++;
        try {
            const proof = await this.read(() => wait
                ? this.proofs.waitForOpen(source, selectionId, {signal, timeoutMs})
                : this.proofs.open(source, selectionId, {signal}), signal);
            const retained = await this.read(() => this.store.readSelection(selectionId, signal), signal);
            const {record, context, selection, abiObservation} = retained;
            if (record.inventory === null) unavailable('native_source_incomplete', 'Native source inventory is incomplete');
            const current = {proof, scope: currentProofConsumerScope(), inputs: new Map(), decisions: new Map(), occurrences: new Map(), receipts: new Map(), provenance: snapshot({
                contextId: record.contextId, linkId: retained.linkId, observationId: retained.link.observationId,
                observationDigest: retained.link.observationDigest, captureRef: record.captureRef,
                inventorySha256: record.inventory.sha256, profile: this.profile,
            })} satisfies IssuedView;
            await this.revalidateIssued(current, {signal});
            requireNative(json(record.source) === json(proof.source) && json(selection.source) === json(proof.source)
                && proof.selectionId === selectionId && record.contextId === selection.contextId
                && record.contextId === protocolSourceContextId(context)
                && context.chainId === this.chainId && json(context.protocol) === json(this.profile)
                && json(record.protocol) === json(this.profile), 'Native evidence differs from its canonical source or installed profile');
            if (record.observation.status !== 'observed' || record.inventory === null) {
                unavailable('native_source_incomplete', 'Native extraction for this source is incomplete');
            }
            const capture = abiObservation.capture;
            requireNative(capture.schemaJson === context.schemaJson && !!capture.blockHex && !!capture.tracesHex,
                'Native source requires its original handshake, block and traces');
            let inputs: readonly ProtocolAbiActionInput[], decisions: readonly ProtocolNativeActionDecision[];
            try {
                const session = this.createSession(JSON.parse(context.schemaJson));
                try {
                    const traceBytes = Buffer.from(capture.tracesHex, 'hex');
                    const traceDigest = hash(traceBytes);
                    const occurrences = deriveProtocolActionOccurrences(session.decodeTraces(traceBytes));
                    inputs = occurrences.map(value => value.input);
                    for (const occurrence of occurrences) {
                        requireNative(!current.receipts.has(occurrence.input.globalSequence), 'Original source has duplicate receipt sequences');
                        current.occurrences.set(key(occurrence.input), occurrence);
                        current.receipts.set(occurrence.input.globalSequence, occurrence);
                    }
                    if (hash(traceBytes) !== traceDigest) throw new Error('Trace decoder mutated its source');
                } finally {session.close?.();}
                requireNative(json(protocolNativeInputInventory(inputs)) === json(record.inventory),
                    'Retained native inventory differs from original source');
                const block = Buffer.from(capture.blockHex, 'hex'), traces = Buffer.from(capture.tracesHex, 'hex');
                const blockDigest = hash(block), traceDigest = hash(traces);
                const observed = this.native.observe(Object.freeze({schemaJson: context.schemaJson, block, traces}),
                    Object.freeze({...record.source}));
                if (hash(block) !== blockDigest || hash(traces) !== traceDigest) throw new Error('Native observer mutated its source');
                decisions = snapshotProtocolNativeDecisions(observed, inputs).decisions;
                requireNative(json({schemaVersion: 1, decisions}) === json(record.observation.facts),
                    'Retained native decisions differ from original source verification');
            } catch (error) {
                signal?.throwIfAborted();
                if (error instanceof ProtocolNativeActionUnavailableError) throw error;
                // Provider code may throw arbitrary values; do not inspect accessors or coerce them.
                unavailable('native_verification_unavailable', 'Native source cannot be verified by the pinned provider');
            }
            // Match the entire certified occurrence inventory, including every notification.
            const bindings = new Map(proof.bindings.map(binding => [key(binding), binding]));
            requireNative(bindings.size === inputs.length, 'Canonical proof has a different native source inventory');
            for (const input of inputs) {
                const binding = bindings.get(key(input));
                const {rawHex, ...identity} = input;
                const {stateId: _state, ...certified} = binding ?? {};
                requireNative(binding && json({...identity, rawSha256: hash(Buffer.from(rawHex, 'hex'))}) === json(certified),
                    'Original native occurrence differs from canonical receipt membership');
                current.inputs.set(key(input), Object.freeze({...input}));
            }
            for (const decision of decisions) current.decisions.set(key(decision.origin), decision);
            await this.revalidateIssued(current, {signal});
            if (finishWorkerOpening) await finishWorkerOpening(proof);
            const handle = Object.freeze({}) as ProtocolNativeActionView;
            this.views.set(handle, current); return handle;
        } finally {this.activeOpens--; signal?.throwIfAborted();}
        });
    }

    async authorize(view: ProtocolNativeActionView, input: ProtocolAbiActionInput,
                    {signal}: ProtocolAbiProofReadOptions = {}): Promise<ProtocolNativeActionAuthorization> {
        return this.consume(this.views.get(view),async () => {
        signal = proofConsumerSignal(signal);
        signal?.throwIfAborted();
        const issued = this.views.get(view);
        if (!issued) unavailable('native_invalid_view', 'Native source view was not issued by this reader');
        // Reject accessors and snapshot exact receipt/raw fields before awaiting authority.
        let original: ProtocolAbiActionInput;
        try {original = snapshot(input);}
        catch {signal?.throwIfAborted(); unavailable('native_input_mismatch', 'Original native input is not portable');}
        if (!original || typeof original !== 'object') unavailable('native_input_mismatch', 'Original native input is absent');
        const retained = issued.inputs.get(key(original));
        if (!retained || json(original) !== json(retained)) {
            unavailable('native_input_mismatch', 'Action differs from the retained original occurrence');
        }
        const occurrence = await this.read(() => this.proofs.occurrence(issued.proof, original, {signal}), signal);
        const origin = issued.inputs.get(key({...original, actionOrdinal: occurrence.binding.inputActionOrdinal}));
        requireNative(origin && origin.receiver === origin.account && origin.actionOrdinal === origin.inputActionOrdinal
            && origin.account === original.account && origin.name === original.name && origin.rawHex === original.rawHex,
        'Native notification has no verified first-receiver ancestry');
        const decision = issued.decisions.get(key(origin));
        requireNative(decision && decision.origin.rawSha256 === occurrence.binding.rawSha256,
            'Native first-receiver decision does not match the certified raw bytes');
        await this.revalidateIssued(issued, {signal});
        if (decision.kind === 'contract') return Object.freeze({kind: 'contract'});
        if (decision.kind === 'incomplete') return Object.freeze({kind: 'incomplete', error: Object.freeze({...decision.error})});
        const grant = Object.freeze({}) as ProtocolNativeActionGrant;
        this.grants.set(grant, {view: issued, input: retained, nativeKind: decision.nativeKind});
        return Object.freeze({kind: 'native', grant});
        });
    }

    async decodeValue(grant: ProtocolNativeActionGrant, {signal}: ProtocolAbiProofReadOptions = {}): Promise<unknown> {
        return this.consume(this.grants.get(grant)?.view,async () => {
        signal = proofConsumerSignal(signal);
        signal?.throwIfAborted();
        const issued = this.grants.get(grant);
        if (!issued) unavailable('native_invalid_grant', 'Native value grant was not issued by this reader');
        await this.revalidateIssued(issued.view, {signal});
        const original = Buffer.from(issued.input.rawHex, 'hex'), raw = Buffer.from(original);
        let value: unknown;
        try {
            const decoded = this.native.decodeValue(issued.nativeKind, raw);
            requireSynchronousValue(decoded);
            const snapshot = serialize(decoded);
            if (snapshot.byteLength > 64 * 1024 * 1024) {
                unavailable('native_value_unavailable', 'Native value exceeds its detached snapshot budget');
            }
            // Each deserializer gets distinct owned bytes: typed-array results may alias its input.
            // The returned value is never passed to provider code, including its encoder.
            value = deserialize(Uint8Array.from(snapshot));
            const encodingValue = deserialize(Uint8Array.from(snapshot));
            const encoded = this.native.encodeValue(issued.nativeKind, encodingValue);
            requireSynchronousValue(encodingValue);
            if (!raw.equals(original) || !(encoded instanceof Uint8Array) || !Buffer.from(encoded).equals(original)) {
                unavailable('native_value_mismatch', 'Native value does not reproduce its authorized original bytes');
            }
        } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof ProtocolNativeActionUnavailableError) throw error;
            unavailable('native_value_unavailable', 'Pinned native provider cannot decode and reproduce the authorized value');
        }
        await this.revalidateIssued(issued.view, {signal});
        try {requireSynchronousValue(value);}
        catch {signal?.throwIfAborted(); unavailable('native_value_unavailable', 'Native value decoding must remain synchronous');}
        return value;
        });
    }

    /** Metadata is derived only from an issued grant; stored labels cannot choose a native kind. */
    async metadata(grant: ProtocolNativeActionGrant, {signal}: ProtocolAbiProofReadOptions = {}): Promise<ProtocolNativeActionProofMetadata> {
        return this.consume(this.grants.get(grant)?.view,async () => {
        signal = proofConsumerSignal(signal);
        signal?.throwIfAborted();
        const issued = this.grants.get(grant);
        if (!issued) unavailable('native_invalid_grant', 'Native metadata grant was not issued by this reader');
        const metadata: ProtocolNativeActionProofMetadata = snapshot({schemaVersion: 2, kind: 'native',
            source: {chainId: issued.view.proof.source.chainId, blockNum: issued.view.proof.source.blockNum, blockId: issued.view.proof.source.blockId},
            selectionId: issued.view.proof.selectionId, input: issued.input,
            native: {...issued.view.provenance, nativeKind: issued.nativeKind}});
        await this.revalidateIssued(issued.view, {signal});
        return Object.freeze(metadata);
        });
    }

    /** Certified occurrence and observer failure remain usable as raw history, never value authority. */
    async incompleteMetadata(view: ProtocolNativeActionView, input: ProtocolAbiActionInput,
                             {signal}: ProtocolAbiProofReadOptions = {}): Promise<ProtocolNativeActionIncompleteMetadata> {
        return this.consume(this.views.get(view),async () => {
        signal = proofConsumerSignal(signal);
        signal?.throwIfAborted();
        let requested: ProtocolAbiActionInput;
        try {requested = snapshot(input);}
        catch {signal?.throwIfAborted(); unavailable('native_input_mismatch', 'Original native input is not portable');}
        const decision = await this.authorize(view, requested, {signal});
        if (decision.kind !== 'incomplete') unavailable('native_decision_mismatch', 'Original native decision is not incomplete');
        const issued = this.views.get(view)!;
        const original = issued.inputs.get(key(requested))!;
        const metadata: ProtocolNativeActionIncompleteMetadata = snapshot({schemaVersion: 2, kind: 'incomplete',
            source: {chainId: issued.proof.source.chainId, blockNum: issued.proof.source.blockNum, blockId: issued.proof.source.blockId},
            selectionId: issued.proof.selectionId, input: original, native: issued.provenance,
            status: 'incomplete', error: decision.error});
        await this.revalidateIssued(issued, {signal});
        return Object.freeze(metadata);
        });
    }

    /** Revalidate only this reader's opaque view, for final worker/response/cache/send fences. */
    async revalidate(view: ProtocolNativeActionView, {signal}: ProtocolAbiProofReadOptions = {}): Promise<void> {
        return this.consume(this.views.get(view),async () => {
        signal = proofConsumerSignal(signal);
        signal?.throwIfAborted();
        const issued = this.views.get(view);
        if (!issued) unavailable('native_invalid_view', 'Native source view was not issued by this reader');
        await this.revalidateIssued(issued, {signal});
        });
    }

    /** Authenticate grouped public source fields; filtered notifications may be a subset of this origin only. */
    async verifyEnvelope(grant: ProtocolNativeActionGrant, action: unknown,
                         {signal}: ProtocolAbiProofReadOptions = {}): Promise<Readonly<Record<string, unknown>>> {
        return this.consume(this.grants.get(grant)?.view,async () => {
        signal = proofConsumerSignal(signal);
        signal?.throwIfAborted();
        const issued = this.grants.get(grant);
        if (!issued) unavailable('native_invalid_grant', 'Native envelope grant was not issued by this reader');
        let candidate: any;
        try {candidate = snapshot(action);}
        catch {signal?.throwIfAborted(); unavailable('native_envelope_mismatch', 'Native action envelope is not portable');}
        const input = issued.input, original = issued.view.occurrences.get(key(input))!;
        const source = issued.view.proof.source;
        requireNative(candidate && candidate.block_num === source.blockNum && candidate.block_id === source.blockId
            && candidate.trx_id === input.transactionId && candidate.action_ordinal === input.actionOrdinal
            && candidate.creator_action_ordinal === original.creatorActionOrdinal
            && candidate.global_sequence === input.globalSequence && candidate.act_digest === original.actDigest
            && candidate.code_sequence === original.receipt.code_sequence && candidate.abi_sequence === original.receipt.abi_sequence
            && candidate.act?.account === input.account && candidate.act?.name === input.name
            && json(candidate.act.authorization) === json(original.authorization)
            && Array.isArray(candidate.receipts) && candidate.receipts.length > 0 && candidate.receipts.length <= issued.view.inputs.size,
        'Native action envelope differs from its original occurrence');
        const seen = new Set<string>();
        for (const receipt of candidate.receipts) {
            const member = issued.view.receipts.get(receipt?.global_sequence);
            requireNative(member && member.input.transactionId === input.transactionId
                && member.input.inputActionOrdinal === input.inputActionOrdinal && member.input.account === input.account
                && member.input.name === input.name && member.input.rawHex === input.rawHex
                && member.actDigest === original.actDigest && json(member.authorization) === json(original.authorization)
                && !seen.has(member.input.globalSequence) && json(receipt) === json(member.receipt),
            'Native grouped receipt is not an original member of this input');
            seen.add(member.input.globalSequence);
        }
        requireNative(seen.has(input.globalSequence), 'Native grouped receipts omit the representative occurrence');
        const metadata = await this.metadata(grant, {signal});
        requireNative(candidate.protocol !== undefined && json(candidate.protocol) === json(metadata),
            'Native envelope metadata differs from its authorized original decision');
        await this.revalidateIssued(issued.view, {signal});
        return candidate;
        });
    }

    /** Check a retained value using the authorized kind and return an independently owned snapshot. */
    async verifyValue(grant: ProtocolNativeActionGrant, candidate: unknown,
                      {signal}: ProtocolAbiProofReadOptions = {}): Promise<unknown> {
        return this.consume(this.grants.get(grant)?.view,async () => {
        signal = proofConsumerSignal(signal);
        signal?.throwIfAborted();
        const issued = this.grants.get(grant);
        if (!issued) unavailable('native_invalid_grant', 'Native value grant was not issued by this reader');
        let value: unknown, encodingValue: unknown;
        try {
            requireSynchronousValue(candidate);
            const bytes = serialize(candidate);
            if (bytes.byteLength > 64 * 1024 * 1024) unavailable('native_value_unavailable', 'Native value exceeds its detached snapshot budget');
            value = deserialize(Uint8Array.from(bytes));
            encodingValue = deserialize(Uint8Array.from(bytes));
        } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof ProtocolNativeActionUnavailableError) throw error;
            unavailable('native_value_unavailable', 'Retained native value cannot be detached');
        }
        await this.revalidateIssued(issued.view, {signal});
        try {
            const encoded = this.native.encodeValue(issued.nativeKind, encodingValue);
            requireSynchronousValue(encodingValue);
            if (!(encoded instanceof Uint8Array) || !Buffer.from(encoded).equals(Buffer.from(issued.input.rawHex, 'hex'))) {
                unavailable('native_value_mismatch', 'Retained native value does not reproduce its authorized original bytes');
            }
        } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof ProtocolNativeActionUnavailableError) throw error;
            unavailable('native_value_unavailable', 'Pinned native provider cannot reproduce the retained value');
        }
        await this.revalidateIssued(issued.view, {signal});
        requireSynchronousValue(value);
        return value;
        });
    }
}
