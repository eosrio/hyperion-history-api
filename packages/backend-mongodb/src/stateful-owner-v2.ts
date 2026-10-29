import {randomBytes} from 'node:crypto';
import {WriteConcern, type ClientSession, type Collection, type Db, type MongoClient} from 'mongodb';
import {STATEFUL_RECOVERY_LIMITS, StatefulContractError, type StatefulApplyResult, type StatefulGuard, type StatefulKey,
    type StatefulRead, type StatefulRollback, type StatefulView} from '@eosrio/hyperion-sdk/projection-stateful';
import {assertStatefulOwnerViewV2, captureStatefulOwnerCandidateV2, captureStatefulOwnerRollbackV2, captureStatefulOwnerViewV2,
    captureStatefulRawTargetV2, receiveStatefulOwnerDeclarationV2, STATEFUL_OWNER_ADAPTER_CAPABILITIES_V2, STATEFUL_OWNER_FAMILY_V2,
    type CapturedRawStatefulTargetV2, type StatefulCandidateV2, type StatefulCompletedReadV2, type StatefulOwnerAcquireV2,
    type StatefulOwnerAdapterV2, type StatefulOwnerClaimV2, type StatefulOwnerDeclarationV2, type StatefulOwnerIdentityV2,
    type StatefulOwnedInspectionV2, type StatefulOwnerLeaseV2, type StatefulReductionReadV2}
    from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {captureStatefulSourceV2, type CapturedStatefulSourceV2} from '@eosrio/hyperion-sdk/projection-stateful-source-v2';
import {bsonBytes, MAX_METADATA_BYTES} from './rollback-contract.js';
import {serverErrorCode} from './storage.js';
import {MAX_BSON_BYTES, ZERO, decodeRow, equalPoint, fields, hex, keyId, logicalKey, requireState, sha, size,
    type StatefulImage, type StatefulPolicy, type StatefulReceipt, type StatefulRow, type StatefulUndo} from './stateful-contract.js';
import {commitStatefulCandidate, rollbackStatefulStep, type StatefulEffects, type StatefulNativeCandidate} from './stateful-effects.js';
import {matchingRaw, ownerMetadata, ownerRecovery, ownerSlot, ownerView, STATEFUL_OWNER_STORAGE_V2, type OwnerMetadataV2}
    from './stateful-owner-v2-contract.js';

export interface MongoDbStatefulOwnerAdapterOptionsV2 {
    readonly client: MongoClient; readonly databaseName: string; readonly backendId: string; readonly collectionPrefix: string;
    readonly declaration: StatefulOwnerDeclarationV2;
    readonly receiptRetention: number; readonly rollbackRetentionBlocks: number; readonly rollbackRetentionBytes: number;
    readonly rollbackMaxBlockBytes: number; readonly operationTimeoutMS: number; readonly transactionTimeoutMS: number;
}
interface OwnerContext {readonly identity: StatefulOwnerIdentityV2; readonly claimDigest: string; readonly revision: string; readonly guard: StatefulGuard}
interface ReadContext {readonly kind: 'reduction' | 'completed'; readonly owner: OwnerContext; readonly view: StatefulView;
    readonly targetDigest?: string; readonly sourceDigest?: string; active: boolean}
const token = () => randomBytes(32).toString('hex');
const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered((value as Record<string, unknown>)[key])])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const unavailableAncestor = 'Ancestor outside retained exact-branch undo';

class MongoDbStatefulOwnerAdapterV2 implements StatefulOwnerAdapterV2 {
    readonly capabilities;
    private readonly db: Db; private readonly meta: Collection<OwnerMetadataV2>;
    private readonly rows: Collection<StatefulRow>; private readonly images: Collection<StatefulImage>;
    private readonly concern = new WriteConcern('majority', undefined, true);
    private readonly policy: StatefulPolicy; private readonly operationMS: number; private readonly transactionMS: number;
    private readonly leases = new WeakMap<object, OwnerContext>(); private readonly reads = new WeakMap<object, ReadContext>();
    private readonly guardFailures = new WeakSet<object>();
    constructor(private readonly options: MongoDbStatefulOwnerAdapterOptionsV2, private readonly declaration: StatefulOwnerDeclarationV2) {
        const d = declaration.projection;
        requireState(options.client && /^[a-zA-Z0-9_-]{1,48}$/.test(options.databaseName) && /^[a-z][a-z0-9_]{0,31}$/.test(options.collectionPrefix)
            && options.backendId === d.definition.binding.backendId, 'Explicit native owner configuration differs');
        this.operationMS = size(options.operationTimeoutMS, 30000, 'operationTimeoutMS'); this.transactionMS = size(options.transactionTimeoutMS, 60000, 'transactionTimeoutMS');
        this.policy = Object.freeze({maxBlocks: size(options.rollbackRetentionBlocks, STATEFUL_RECOVERY_LIMITS.retainedBlocks, 'rollbackRetentionBlocks'),
            maxBytes: size(options.rollbackRetentionBytes, STATEFUL_RECOVERY_LIMITS.retainedBytes, 'rollbackRetentionBytes'),
            maxBlockBytes: size(options.rollbackMaxBlockBytes, options.rollbackRetentionBytes, 'rollbackMaxBlockBytes'),
            receiptRetention: size(options.receiptRetention, STATEFUL_RECOVERY_LIMITS.retainedBlocks, 'receiptRetention')});
        requireState(d.limits.value.recordBytes + 2 * d.limits.keyBytes + 1024 <= MAX_BSON_BYTES, 'Offered value/key profile exceeds BSON envelope', 'stateful.capability-unavailable');
        const textBytes = Math.min(d.limits.keyBytes, d.limits.envelope.stringBytes);
        requireState(Buffer.byteLength(unavailableAncestor) <= textBytes, 'Offered owner text profile cannot retain rollback reason', 'stateful.capability-unavailable');
        // Exact fixed structure plus conservative UTF-8 reservations. Includes owner, raw+pending+failure,
        // complete rollback, full receipt/undo arrays and widest native numeric BSON fields together.
        const point = {blockNum: Number.MAX_SAFE_INTEGER, blockId: 'f'.repeat(64)}, previous = {...point, blockNum: point.blockNum - 1};
        const receipt: StatefulReceipt = {...point, sourceDigest: point.blockId, candidateDigest: point.blockId};
        const undo: StatefulUndo = {block: {...point, previousBlockId: point.blockId}, digest: point.blockId, sourceDigest: point.blockId,
            count: d.limits.mutations, imageBytes: this.policy.maxBlockBytes, imagesHash: point.blockId};
        const claim = {identity: {id: '', generation: ''}, claimDigest: point.blockId};
        const sample = {...this.initial(claim), initialized: true, checkpoint: point, floor: point, floorReceipt: receipt,
            receipts: Array(this.policy.receiptRetention).fill(receipt), undo: Array(this.policy.maxBlocks).fill(undo),
            raw: {sourceDigest: point.blockId, target: {digest: point.blockId, target: {schemaVersion: 2, chainId: d.definition.binding.chainId,
                declarationDigest: declaration.digest, owner: claim.identity, previous: {...ownerView(declaration, this.initial(claim)), checkpoint: previous},
                block: {...point, previousBlockId: previous.blockId}, rawSource: {commitId: '', selectionId: '', observationId: '', observationDigest: point.blockId}}}},
            pending: {sourceDigest: point.blockId, candidateDigest: point.blockId, block: point},
            gap: {kind: 'source', targetDigest: point.blockId, sourceDigest: point.blockId, block: point, reason: ''},
            rollback: {operationId: point.blockId, sourceRevision: point.blockId, from: point, ancestor: point, status: 'unavailable', reason: ''}};
        requireState(bsonBytes(sample) + 9 * textBytes <= MAX_METADATA_BYTES, 'Owner declaration/retention profile exceeds metadata envelope', 'stateful.capability-unavailable');
        this.capabilities = Object.freeze({family: STATEFUL_OWNER_FAMILY_V2, interfaceVersion: 2 as const, sourceInputVersions: Object.freeze([2] as const),
            supported: STATEFUL_OWNER_ADAPTER_CAPABILITIES_V2, limits: d.limits});
        this.db = options.client.db(options.databaseName, {readPreference: 'primary'});
        const prefix = options.collectionPrefix + '_stateful_v2';
        this.meta = this.db.collection<OwnerMetadataV2>(prefix + '_metadata'); this.rows = this.db.collection<StatefulRow>(prefix + '_r_' + declaration.digest);
        this.images = this.db.collection<StatefulImage>(prefix + '_u_' + declaration.digest);
    }
    private text(value: unknown): asserts value is string {
        const limits = this.declaration.projection.limits;
        requireState(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= limits.keyBytes
            && Buffer.byteLength(value) <= limits.envelope.stringBytes, 'Expected bounded owner text');
        for (let index = 0; index < value.length; index++) {
            const unit = value.charCodeAt(index);
            if (unit >= 0xd800 && unit <= 0xdbff) {const low = value.charCodeAt(++index); requireState(low >= 0xdc00 && low <= 0xdfff, 'Malformed owner text');}
            else requireState(unit < 0xdc00 || unit > 0xdfff, 'Malformed owner text');
        }
    }
    private identity(input: unknown): StatefulOwnerIdentityV2 {
        fields(input, ['id', 'generation']); this.text(input.id); this.text(input.generation); return Object.freeze({id: input.id, generation: input.generation});
    }
    private claim(input: unknown): StatefulOwnerClaimV2 {
        fields(input, ['identity', 'claimDigest']); const identity = this.identity(input.identity); hex(input.claimDigest); return Object.freeze({identity, claimDigest: input.claimDigest});
    }
    private initial(owner: StatefulOwnerClaimV2, revision = token()): OwnerMetadataV2 {
        const d = this.declaration;
        return {_id: ownerSlot(d), storageVersion: STATEFUL_OWNER_STORAGE_V2, declaration: JSON.stringify(d), declarationDigest: d.digest, policy: this.policy,
            etag: token(), checkpoint: {...ZERO}, revision, initialized: false, owner, raw: null, pending: null, gap: null, rollback: null,
            receipts: [], undo: [], floor: {...ZERO}, floorReceipt: null};
    }
    private lease(input: StatefulOwnerLeaseV2): OwnerContext {
        const context = input && this.leases.get(input); requireState(context, 'Owner lease is not issued by this adapter', 'stateful.stale-view'); context.guard(); return context;
    }
    private assertOwner(m: OwnerMetadataV2, context: OwnerContext): void {
        context.guard(); requireState(same(m.owner.identity, context.identity) && m.owner.claimDigest === context.claimDigest
            && m.revision === context.revision, 'Native owner generation/revision changed', 'stateful.stale-view');
    }
    private async call<T>(context: OwnerContext | StatefulGuard, work: () => Promise<T>): Promise<T> {
        const guard = typeof context === 'function' ? context : context.guard;
        this.fence(guard); try {return await work();} finally {this.fence(guard);}
    }
    private fence(guard: StatefulGuard): void {
        try {guard();} catch (error) {if (error !== null && typeof error === 'object') this.guardFailures.add(error); throw error;}
    }
    private async available<T>(work: () => Promise<T>): Promise<T> {
        try {return await work();} catch (error) {
            if (error instanceof StatefulContractError || error !== null && typeof error === 'object' && this.guardFailures.has(error)) throw error;
            const failure = new StatefulContractError('stateful.apply-unavailable', 'MongoDB outcome is unavailable; inspect the original owner/raw/candidate identity');
            failure.cause = error; throw failure;
        }
    }
    private async load(context?: OwnerContext, session?: ClientSession): Promise<OwnerMetadataV2 | null> {
        const work = () => this.meta.findOne({_id: ownerSlot(this.declaration)}, session ? {session} : {
            readPreference: 'primary', readConcern: {level: 'linearizable'}, maxTimeMS: this.operationMS, timeoutMS: this.operationMS});
        const raw = context ? await this.call(context, work) : await work(); if (raw === null) return null;
        const m = context ? await this.call(context, () => ownerMetadata(this.declaration, this.policy, raw)) : await ownerMetadata(this.declaration, this.policy, raw);
        if (context) this.assertOwner(m, context); return m;
    }
    private async current(context: OwnerContext, session?: ClientSession): Promise<OwnerMetadataV2> {
        const m = await this.load(context, session); requireState(m !== null, 'Owner storage is not initialized', 'stateful.not-initialized'); return m;
    }
    private async save(context: OwnerContext, before: OwnerMetadataV2, changes: Partial<OwnerMetadataV2>, session?: ClientSession, version = token()): Promise<OwnerMetadataV2> {
        this.assertOwner(before, context);
        hex(version);
        const next = await this.call(context, () => ownerMetadata(this.declaration, this.policy, {...before, ...changes, etag: version})), {_id, ...values} = next;
        const result = await this.call(context, () => this.meta.updateOne({_id, etag: before.etag, declarationDigest: before.declarationDigest,
            'owner.claimDigest': context.claimDigest, revision: context.revision}, {$set: values}, session ? {session} : {writeConcern: this.concern, timeoutMS: this.operationMS}));
        requireState(result.acknowledged && result.matchedCount === 1, 'Owner/raw recovery CAS changed', 'stateful.stale-view'); return next;
    }
    private async transaction<T>(context: OwnerContext, work: (session: ClientSession) => Promise<T>, readConcern: 'snapshot' | 'local' = 'snapshot'): Promise<T> {
        context.guard(); const session = this.options.client.startSession({causalConsistency: false});
        try {
            const result = await this.call(context, () => session.withTransaction(() => this.call(context, () => work(session)), {
                readConcern: {level: readConcern}, writeConcern: this.concern, readPreference: 'primary', timeoutMS: this.transactionMS, maxCommitTimeMS: this.operationMS}));
            requireState(result !== undefined, 'Driver returned no transaction result', 'stateful.commit-unknown'); return result;
        } finally {await session.endSession();}
    }
    async recovery() {return this.available(async () => {const m = await this.load(); return m === null ? null : ownerRecovery(this.declaration, m);});}
    async acquireOwner(input: StatefulOwnerAcquireV2, guard: StatefulGuard): Promise<StatefulOwnerLeaseV2> {
        fields(input, ['expected', 'nextOwner']); const nextOwner = this.identity(input.nextOwner), d = this.declaration;
        let expected: StatefulOwnerAcquireV2['expected'] = null;
        if (input.expected !== null) {
            fields(input.expected, ['version', 'view', 'owner']); hex(input.expected.version);
            expected = Object.freeze({version: input.expected.version, view: captureStatefulOwnerViewV2(d, input.expected.view),
                owner: input.expected.owner === null ? null : this.claim(input.expected.owner)});
        }
        const claimFor = (revision: string) => sha(JSON.stringify({declarationDigest: d.digest, expected, nextOwner, revision}));
        return this.available(async () => {
            let m = await this.call(guard, () => this.load());
            if (m === null) {
                requireState(expected === null, 'Owner bootstrap expectation differs', 'stateful.stale-view');
                const hello = await this.call(guard, () => this.db.admin().command({hello: 1}, {readPreference: 'primary', timeoutMS: this.operationMS}));
                requireState(typeof hello.setName === 'string' && hello.setName.length > 0 && hello.isWritablePrimary === true
                    && Number.isSafeInteger(hello.maxWireVersion) && hello.maxWireVersion >= 9 && Number.isFinite(hello.logicalSessionTimeoutMinutes)
                    && hello.logicalSessionTimeoutMinutes > 0, 'Owner MongoDB requires replica-set primary and transactional collection creation', 'stateful.capability-unavailable');
                const revision = token(), initialClaim = {identity: nextOwner, claimDigest: claimFor(revision)};
                const initial = await this.call(guard, () => ownerMetadata(d, this.policy, this.initial(initialClaim, revision)));
                try {await this.call(guard, () => this.meta.insertOne(initial, {writeConcern: this.concern, timeoutMS: this.operationMS}));}
                catch (error) {if (!serverErrorCode(error, 11000)) throw error;}
                m = await this.call(guard, () => this.load());
            }
            requireState(m !== null, 'Owner claim outcome unavailable', 'stateful.commit-unknown');
            // Exact lost-ACK retries may span ordinary progress, never a rollback revision.
            // Bootstrap retries derive their claim from the persisted original initial revision.
            if (expected !== null) requireState(m.revision === expected.view.revision, 'Owner acquire revision changed', 'stateful.stale-view');
            const claimDigest = claimFor(expected?.view.revision ?? m.revision), claim = {identity: nextOwner, claimDigest};
            if (m.owner.claimDigest !== claimDigest || !same(m.owner.identity, nextOwner)) {
                requireState(expected !== null && m.etag === expected.version && same(ownerView(d, m), expected.view) && same(m.owner, expected.owner),
                    'Owner acquire compare-and-set differs', 'stateful.stale-view');
                const before = m, next = await this.call(guard, () => ownerMetadata(d, this.policy, {...before, owner: claim, etag: token()})), {_id, ...values} = next;
                const result = await this.call(guard, () => this.meta.updateOne({_id, etag: before.etag, declarationDigest: d.digest}, {$set: values},
                    {writeConcern: this.concern, timeoutMS: this.operationMS}));
                requireState(result.acknowledged && result.matchedCount === 1, 'Owner acquisition lost CAS', 'stateful.stale-view'); m = next;
            }
            const context: OwnerContext = {identity: nextOwner, claimDigest, revision: m.revision, guard}; this.assertOwner(m, context);
            if (!m.initialized) m = await this.transaction(context, async session => {
                const current = await this.current(context, session); if (current.initialized) return current;
                // Both empty collections and initialized marker commit under the same owner CAS.
                // Existing namespaces fail closed; v2 never adopts v1 or preexisting domain rows.
                for (const collection of [this.rows, this.images]) await this.call(context, () => this.db.createCollection(collection.collectionName,
                    {session, collation: {locale: 'simple'}}));
                return this.save(context, current, {initialized: true}, session);
            }, 'local');
            this.assertOwner(m, context); const lease = Object.freeze({}) as StatefulOwnerLeaseV2; this.leases.set(lease, context); return lease;
        });
    }
    async admitRaw(lease: StatefulOwnerLeaseV2, input: CapturedRawStatefulTargetV2): Promise<void> {
        const context = this.lease(lease); fields(input, ['target', 'digest']); const expectedDigest = input.digest; hex(expectedDigest);
        const target = await this.call(context, () => captureStatefulRawTargetV2(this.declaration, input.target));
        requireState(target.digest === expectedDigest, 'Raw capture digest differs');
        return this.available(async () => {
            const m = await this.current(context); this.writable(m);
            if (m.raw !== null) {requireState(m.raw.target.digest === target.digest && same(m.raw.target, target), 'Another raw target owns recovery', 'stateful.replay-conflict'); return;}
            requireState(same(target.target.owner, context.identity), 'Fresh target owner differs', 'stateful.stale-view');
            assertStatefulOwnerViewV2(this.declaration, ownerView(this.declaration, m), target.target.previous);
            requireState(m.pending === null && m.gap === null, 'Raw slot cannot replace recovery', 'stateful.incomplete');
            await this.save(context, m, {raw: {target, sourceDigest: null}});
        });
    }
    private writable(m: OwnerMetadataV2): void {
        requireState(m.initialized && (!m.rollback || m.rollback.status === 'complete'), 'Owner recovery is incomplete', 'stateful.incomplete');
    }
    private bound(m: OwnerMetadataV2, targetDigest: string, sourceDigest: string): void {
        this.writable(m); matchingRaw(m, targetDigest); hex(sourceDigest);
        requireState(m.raw!.sourceDigest === sourceDigest, 'Raw decoded source differs', 'stateful.replay-conflict');
    }
    private async failure(lease: StatefulOwnerLeaseV2, targetDigest: string, reason: string, sourceDigest?: string): Promise<void> {
        const context = this.lease(lease); this.text(reason); hex(targetDigest); if (sourceDigest !== undefined) hex(sourceDigest);
        return this.available(async () => {
            const m = await this.current(context); this.writable(m); const target = matchingRaw(m, targetDigest);
            if (sourceDigest !== undefined) this.bound(m, targetDigest, sourceDigest);
            const block = {blockNum: target.target.block.blockNum, blockId: target.target.block.blockId};
            const gap = sourceDigest === undefined ? {kind: 'raw' as const, targetDigest, block, reason}
                : {kind: 'source' as const, targetDigest, sourceDigest, block, reason};
            requireState(m.gap === null || same(m.gap, gap), 'Original failure differs', 'stateful.replay-conflict');
            if (m.gap === null) await this.save(context, m, {gap});
        });
    }
    markRawFailure(lease: StatefulOwnerLeaseV2, targetDigest: string, reason: string) {return this.failure(lease, targetDigest, reason);}
    markSourceFailure(lease: StatefulOwnerLeaseV2, targetDigest: string, sourceDigest: string, reason: string) {return this.failure(lease, targetDigest, reason, sourceDigest);}
    async bindSource(lease: StatefulOwnerLeaseV2, targetDigest: string, supplied: CapturedStatefulSourceV2): Promise<void> {
        const context = this.lease(lease); fields(supplied, ['declarationDigest', 'sourceInputVersion', 'source', 'digest']);
        const expectedDigest = supplied.digest, expectedDeclaration = supplied.declarationDigest, expectedVersion = supplied.sourceInputVersion;
        const source = await this.call(context, () => captureStatefulSourceV2(this.declaration, supplied.source));
        requireState(source.digest === expectedDigest && source.declarationDigest === expectedDeclaration && expectedVersion === 2, 'Source-v2 capture differs');
        return this.available(async () => {
            const m = await this.current(context); this.writable(m); const target = matchingRaw(m, targetDigest);
            requireState(equalPoint(source.source.previous, target.target.previous.checkpoint) && equalPoint(source.source.block, target.target.block)
                && source.source.block.previousBlockId === target.target.block.previousBlockId, 'Decoded source is not the original raw target', 'stateful.replay-conflict');
            requireState(m.raw!.sourceDigest === null || m.raw!.sourceDigest === source.digest, 'Original decoded source changed', 'stateful.replay-conflict');
            if (m.raw!.sourceDigest === null) await this.save(context, m, {raw: {...m.raw!, sourceDigest: source.digest}});
        });
    }
    private replay(m: OwnerMetadataV2, source: StatefulNativeCandidate['source'], candidateDigest?: string): StatefulReceipt | null {
        const block = source.source.block, receipt = m.receipts.find(r => r.blockNum === block.blockNum || r.blockId === block.blockId);
        if (receipt) requireState(equalPoint(receipt, block) && receipt.sourceDigest === source.digest && (candidateDigest === undefined || receipt.candidateDigest === candidateDigest),
            'Retained original replay conflicts', 'stateful.replay-conflict'); return receipt ?? null;
    }
    async inspectOwned(lease: StatefulOwnerLeaseV2, targetDigest: string, supplied: CapturedStatefulSourceV2): Promise<StatefulOwnedInspectionV2> {
        const context = this.lease(lease); fields(supplied, ['declarationDigest', 'sourceInputVersion', 'source', 'digest']);
        const expectedDigest = supplied.digest, expectedDeclaration = supplied.declarationDigest, expectedVersion = supplied.sourceInputVersion;
        const source = await this.call(context, () => captureStatefulSourceV2(this.declaration, supplied.source));
        requireState(source.digest === expectedDigest && source.declarationDigest === expectedDeclaration && expectedVersion === 2, 'Source-v2 capture differs');
        return this.available(async () => {
            const m = await this.current(context); this.bound(m, targetDigest, source.digest); const receipt = this.replay(m, source);
            if (m.pending) requireState(m.pending.sourceDigest === source.digest && equalPoint(m.pending.block, source.source.block), 'Pending source differs', 'stateful.replay-conflict');
            return {phase: m.pending ? 'pending' : m.gap ? 'failed' : 'bound', status: receipt ? 'committed' : m.pending ? 'pending'
                : source.source.block.blockNum <= m.checkpoint.blockNum ? 'uncovered' : 'new', targetDigest,
                sourceDigest: receipt?.sourceDigest ?? m.pending?.sourceDigest ?? null, candidateDigest: receipt?.candidateDigest ?? m.pending?.candidateDigest ?? null,
                progress: ownerView(this.declaration, m)};
        });
    }
    private effects(context: OwnerContext, targetDigest?: string): StatefulEffects<OwnerMetadataV2> {
        const d = this.declaration;
        return {declaration: d.projection, policy: this.policy, rows: this.rows, images: this.images, call: work => this.call(context, work),
            load: session => this.current(context, session), save: (m, changes, session) => this.save(context, m, changes, session),
            transaction: work => this.transaction(context, work), assertApply: (m, candidate) => {requireState(targetDigest !== undefined, 'Missing raw apply identity'); this.bound(m, targetDigest, candidate.source.digest);},
            assertView: (m, candidate) => assertStatefulOwnerViewV2(d, ownerView(d, m), candidate.view),
            replay: (m, candidate) => this.replay(m, candidate.source, candidate.digest) !== null, duplicate: m => this.writable(m), view: m => ownerView(d, m)};
    }
    async applyOwned(lease: StatefulOwnerLeaseV2, targetDigest: string, input: StatefulCandidateV2): Promise<StatefulApplyResult> {
        const context = this.lease(lease), d = this.declaration, candidate = await this.call(context, () => captureStatefulOwnerCandidateV2(d, input));
        return this.available(async () => {
            const m = await this.current(context); this.bound(m, targetDigest, candidate.source.digest);
            if (this.replay(m, candidate.source, candidate.digest)) return {status: 'duplicate', progress: ownerView(d, m)};
            requireState(candidate.source.source.block.blockNum > m.checkpoint.blockNum, 'Source receipt coverage expired', 'stateful.receipt-unavailable');
            assertStatefulOwnerViewV2(d, ownerView(d, m), candidate.view);
            const block = candidate.source.source.block, pending = {sourceDigest: candidate.source.digest, candidateDigest: candidate.digest,
                block: {blockNum: block.blockNum, blockId: block.blockId}};
            requireState(m.pending === null || same(m.pending, pending), 'Pending candidate conflicts', 'stateful.replay-conflict');
            await this.save(context, m, {pending}); return commitStatefulCandidate(this.effects(context, targetDigest), candidate, pending);
        });
    }
    async retireRaw(lease: StatefulOwnerLeaseV2, targetDigest: string, sourceDigest: string, candidateDigest: string): Promise<void> {
        const context = this.lease(lease); hex(targetDigest); hex(sourceDigest); hex(candidateDigest);
        return this.available(async () => {
            const m = await this.current(context); this.writable(m);
            const retiredVersion = sha(JSON.stringify({operation: 'owner-v2-raw-retired', declarationDigest: this.declaration.digest,
                ownerClaim: context.claimDigest, revision: m.revision, checkpoint: m.checkpoint, targetDigest, sourceDigest, candidateDigest}));
            if (m.raw === null) {
                // The clear CAS version itself binds the exact original target and receipt. A later
                // metadata write/owner acquisition invalidates this narrow retry; no extra journal exists.
                requireState(m.etag === retiredVersion && m.gap === null && m.pending === null
                    && m.receipts.some(r => equalPoint(r, m.checkpoint) && r.sourceDigest === sourceDigest && r.candidateDigest === candidateDigest),
                    'Raw retirement is not covered by an original receipt', 'stateful.receipt-unavailable'); return;
            }
            this.bound(m, targetDigest, sourceDigest); const target = matchingRaw(m, targetDigest), receipt = m.receipts.find(r => equalPoint(r, target.target.block));
            requireState(m.pending === null && receipt?.sourceDigest === sourceDigest && receipt.candidateDigest === candidateDigest
                && equalPoint(m.checkpoint, target.target.block), 'Original effects/progress/receipt do not prove retirement', 'stateful.incomplete');
            await this.save(context, m, {raw: null, gap: null}, undefined, retiredVersion);
        });
    }
    async rollbackOwned(lease: StatefulOwnerLeaseV2, input: StatefulRollback) {
        const held = this.lease(lease);
        fields(input, ['declarationDigest', 'revision', 'operationId', 'from', 'ancestor', 'maxBlocks']);
        fields(input.from, ['blockNum', 'blockId']); fields(input.ancestor, ['blockNum', 'blockId']);
        const selected = Object.freeze({declarationDigest: input.declarationDigest, revision: input.revision, operationId: input.operationId,
            from: Object.freeze({...input.from}), ancestor: Object.freeze({...input.ancestor}), maxBlocks: input.maxBlocks});
        return this.available(async () => {
            const d = this.declaration; let context = held, m = await this.current(context);
            const recovery = await this.call(context, () => ownerRecovery(d, m));
            const admitted = await this.call(context, () => captureStatefulOwnerRollbackV2(d, selected, recovery));
            const request = admitted.request;
            if (admitted.mode === 'duplicate') return {status: 'duplicate' as const, recovery: await ownerRecovery(d, m)};
            if (admitted.mode === 'start') {
                requireState(m.rollback === null || m.rollback.status === 'complete', 'Unavailable ancestry requires historical recovery', 'stateful.rollback-unavailable');
                const available = equalPoint(m.floor, request.ancestor) || m.undo.some(u => equalPoint(u.block, request.ancestor));
                const rollback = {operationId: request.operationId, sourceRevision: request.revision, from: request.from, ancestor: request.ancestor,
                    status: available ? 'running' as const : 'unavailable' as const, reason: available ? null : unavailableAncestor};
                m = await this.save(context, m, {revision: token(), rollback, raw: null, pending: null, gap: null});
                // Only this bounded recovery call may continue under the new revision. The public old lease remains invalid.
                context = {...context, revision: m.revision}; requireState(available, unavailableAncestor, 'stateful.rollback-unavailable');
            }
            for (let step = 0; step < request.maxBlocks && m.rollback?.status === 'running'; step++) m = await rollbackStatefulStep(this.effects(context), request);
            return {status: m.rollback?.status === 'complete' ? 'rolled-back' as const : 'in-progress' as const, recovery: await ownerRecovery(d, m)};
        });
    }
    async retainedCheckpoints(lease: StatefulOwnerLeaseV2) {
        const context = this.lease(lease); return this.available(async () => {const m = await this.current(context);
            return {recovery: await ownerRecovery(this.declaration, m), checkpoints: [...m.undo].reverse().map(u => ({blockNum: u.block.blockNum, blockId: u.block.blockId})).concat([{...m.floor}])};});
    }
    private readContext(input: StatefulReductionReadV2 | StatefulCompletedReadV2, kind: ReadContext['kind']): ReadContext {
        const read = input && this.reads.get(input); requireState(read && read.active && read.kind === kind, 'Private read capability is unavailable', 'stateful.unavailable');
        read.owner.guard(); return read;
    }
    private assertRead(m: OwnerMetadataV2, read: ReadContext): void {
        requireState(read.active, 'Private read capability is closed', 'stateful.unavailable');
        this.assertOwner(m, read.owner); this.writable(m); assertStatefulOwnerViewV2(this.declaration, ownerView(this.declaration, m), read.view);
        if (read.kind === 'reduction') {
            this.bound(m, read.targetDigest!, read.sourceDigest!); requireState(equalPoint(m.raw!.target.target.previous.checkpoint, m.checkpoint), 'Reduction predecessor changed', 'stateful.stale-view');
        } else requireState(m.gap === null, 'Failed raw/source input cannot serve completed state', 'stateful.incomplete');
    }
    async reductionRead(lease: StatefulOwnerLeaseV2, targetDigest: string, sourceDigest: string): Promise<StatefulReductionReadV2> {
        const context = this.lease(lease); hex(targetDigest); hex(sourceDigest);
        return this.available(async () => {
            const m = await this.current(context); this.bound(m, targetDigest, sourceDigest);
            const read: ReadContext = {kind: 'reduction', owner: {...context, guard: () => {
                context.guard(); requireState(read.active, 'Private read capability is closed', 'stateful.unavailable');
            }}, view: ownerView(this.declaration, m), targetDigest, sourceDigest, active: true};
            this.assertRead(m, read); const cap = Object.freeze({}) as StatefulReductionReadV2; this.reads.set(cap, read); return cap;
        });
    }
    async completedRead(expectedOwner: StatefulOwnerIdentityV2, expectedView: StatefulView, authority: StatefulGuard): Promise<StatefulCompletedReadV2> {
        const identity = this.identity(expectedOwner), view = captureStatefulOwnerViewV2(this.declaration, expectedView);
        return this.available(async () => {
            const m = await this.call(authority, () => this.load()); requireState(m !== null && same(m.owner.identity, identity), 'Actual live owner differs', 'stateful.stale-view');
            const read: ReadContext = {kind: 'completed', owner: {identity, claimDigest: m.owner.claimDigest, revision: m.revision, guard: () => {
                authority(); requireState(read.active, 'Private read capability is closed', 'stateful.unavailable');
            }}, view, active: true};
            this.assertRead(m, read); const cap = Object.freeze({}) as StatefulCompletedReadV2; this.reads.set(cap, read); return cap;
        });
    }
    private async privateView(input: StatefulReductionReadV2 | StatefulCompletedReadV2, kind: ReadContext['kind']): Promise<StatefulView> {
        const read = this.readContext(input, kind); return this.available(async () => {const m = await this.current(read.owner); this.assertRead(m, read); return ownerView(this.declaration, m);});
    }
    reductionView(read: StatefulReductionReadV2) {return this.privateView(read, 'reduction');}
    completedView(read: StatefulCompletedReadV2) {return this.privateView(read, 'completed');}
    private async privateRead(input: StatefulReductionReadV2 | StatefulCompletedReadV2, kind: ReadContext['kind'], expected: StatefulView, requested: readonly StatefulKey[]) {
        const read = this.readContext(input, kind), d = this.declaration, view = captureStatefulOwnerViewV2(d, expected);
        assertStatefulOwnerViewV2(d, read.view, view);
        requireState(Array.isArray(requested) && requested.length <= d.projection.limits.readKeys && requested.length <= d.projection.limits.responseRecords, 'Private read key bound');
        const descriptors = Object.getOwnPropertyDescriptors(requested);
        requireState(Object.getOwnPropertySymbols(requested).length === 0 && Object.keys(descriptors).length === requested.length + 1, 'Sparse private key vector');
        const keys: StatefulKey[] = [];
        for (let i = 0; i < requested.length; i++) {const item = descriptors[String(i)]; requireState(item?.enumerable && Object.hasOwn(item, 'value'), 'Accessor/sparse private key'); keys.push(logicalKey(d.projection, item.value));}
        return this.available(async () => {
            this.assertRead(await this.current(read.owner), read);
            const result = await this.transaction(read.owner, async session => {
                this.assertRead(await this.current(read.owner, session), read); const results: StatefulRead[] = [];
                for (const key of keys) {const row = await this.call(read.owner, () => this.rows.findOne({_id: keyId(key)}, {session}));
                    results.push(row === null ? {status: 'covered-absent'} : {status: 'present', value: decodeRow(d.projection, key, row)});}
                requireState(Buffer.byteLength(JSON.stringify({view, results})) <= d.projection.limits.responseBytes, 'Private read response bound'); return {view, results};
            });
            this.assertRead(await this.current(read.owner), read); return result;
        });
    }
    readReduction(read: StatefulReductionReadV2, view: StatefulView, keys: readonly StatefulKey[]) {return this.privateRead(read, 'reduction', view, keys);}
    readCompleted(read: StatefulCompletedReadV2, view: StatefulView, keys: readonly StatefulKey[]) {return this.privateRead(read, 'completed', view, keys);}
    closeRead(input: StatefulReductionReadV2 | StatefulCompletedReadV2): void {const read = input && this.reads.get(input); if (read) {read.active = false; this.reads.delete(input);}}
}

/** Separate explicit opt-in; receiving/constructing alone performs no native action and grants no readiness. */
export async function createMongoDbStatefulOwnerAdapterV2(options: MongoDbStatefulOwnerAdapterOptionsV2): Promise<StatefulOwnerAdapterV2> {
    fields(options, ['client', 'databaseName', 'backendId', 'collectionPrefix', 'declaration', 'receiptRetention', 'rollbackRetentionBlocks',
        'rollbackRetentionBytes', 'rollbackMaxBlockBytes', 'operationTimeoutMS', 'transactionTimeoutMS']);
    const selected = {...options}, declaration = await receiveStatefulOwnerDeclarationV2(selected.declaration);
    return new MongoDbStatefulOwnerAdapterV2(selected, declaration);
}
