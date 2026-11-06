/** Native Node controls over emitted readers, actual coordinator/immutable stores and controlled I/O.
 * Synthetic source negatives supplement the separate unchanged original-Wire DS callback oracle. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {registerHooks} from 'node:module';
import {setImmediate as turn} from 'node:timers/promises';
const hooks = registerHooks({resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/protocol-native-authorization-host-fixture.ts') && specifier.startsWith('../../src/'))
        return next(new URL(specifier.replace('../../src/', '../../build/'), context.parentURL).href, context);
    return next(specifier, context);
}});
const [{ProtocolNativeActionReader}, {ProofConsumerScope, assertProofConsumerEnd}, fixtureModule] = await Promise.all([
    import('../../build/indexer/protocol/native-authorization.js'), import('../../build/indexer/protocol/proof-consumer-scope.js'),
    import('./protocol-native-authorization-host-fixture.ts')]);
const {nativeAuthorizationFixture, chainId, profile, gate, holdRead} = fixtureModule;
hooks.deregister();
const pairFor = fixture => ProtocolNativeActionReader.forWorker({chainId, profile, provider: fixture.provider,
    proofReader: fixture.proofs(), store: fixture.nativeStore});
const open = (pair, fixture, options) => pair.waitForOpen(fixture.selected.source, fixture.selected.selectionId, options);
const readOwners = fixture => [[fixture.client, 'get'], [fixture.client.indices, 'get']];
// Coordinator generations give each fixture different content-addressed IDs. Compare the I/O role
// and manifest/chunk shape, while the real stores still verify each complete source-bound identity.
const readLabel = (method, request) => ({method, index: request.index,
    ...(request.id ? {idKind: request.id.split(':')[0], idSegments: request.id.split(':').length} : {})});
const writes = calls => calls.filter(call => ['createIndex', 'create', 'index'].includes(call.method));

test('worker pair uses the actual native read-only issuer without adopting external or copied authority', async () => {
    const fixture = await nativeAuthorizationFixture(), pair = pairFor(fixture), sibling = pairFor(fixture);
    const scope = new ProofConsumerScope('paired-authority'), other = new ProofConsumerScope('foreign-authority');
    const before = fixture.memory.calls.length;
    const output = await scope.run(async () => {
        const result = await open(pair, fixture);
        assert(Object.isFrozen(result)); assert(Object.isFrozen(result.view)); assert(Object.isFrozen(result.nativeView));
        const occurrence = await pair.proofs.occurrence(result.view, fixture.selected.inputs[1]);
        assert.equal(occurrence.binding.inputActionOrdinal, 1);
        const native = await pair.native.authorize(result.nativeView, fixture.selected.inputs[1]);
        assert.equal(native.kind, 'native'); assert.deepEqual(await pair.native.decodeValue(native.grant), {rawHex: '0102'});
        assert.equal((await pair.native.authorize(result.nativeView, fixture.selected.inputs[3])).kind, 'contract');
        for (const copy of [{}, {...result.view}, structuredClone(result.view), Object.create(result.view)])
            await assert.rejects(pair.proofs.revalidate(copy), {code: 'invalid_proof'});
        for (const copy of [{}, {...result.nativeView}, structuredClone(result.nativeView), Object.create(result.nativeView)])
            await assert.rejects(pair.native.authorize(copy, fixture.selected.inputs[0]), {code: 'native_invalid_view'});
        await assert.rejects(sibling.proofs.revalidate(result.view), {code: 'invalid_proof'});
        await assert.rejects(sibling.native.authorize(result.nativeView, fixture.selected.inputs[0]), {code: 'native_invalid_view'});
        await assert.rejects(fixture.proofs().revalidate(result.view), {code: 'invalid_proof'});
        return result;
    });
    assert.equal(writes(fixture.memory.calls.slice(before)).length, 0);
    await other.run(async () => {
        await assert.rejects(pair.proofs.revalidate(output.view), /another worker attempt/);
        await assert.rejects(pair.native.authorize(output.nativeView, fixture.selected.inputs[0]), /another worker attempt/);
    });
    assertProofConsumerEnd(other, await other.closeAndDrain());
    assertProofConsumerEnd(scope, await scope.closeAndDrain());
    await assert.rejects(pair.proofs.revalidate(output.view), {code: 'worker_attempt_fenced'});
    await assert.rejects(pair.native.authorize(output.nativeView, fixture.selected.inputs[0]), {code: 'worker_attempt_fenced'});
    const replacement = new ProofConsumerScope('replacement-authority'), readsBefore = fixture.memory.calls.length;
    await replacement.run(async () => {
        const fresh = await open(pair, fixture);
        assert.notEqual(fresh.view, output.view); assert.notEqual(fresh.nativeView, output.nativeView);
        assert.equal((await pair.native.authorize(fresh.nativeView, fixture.selected.inputs[0])).kind, 'native');
    });
    assert(fixture.memory.calls.slice(readsBefore).some(call => call.method === 'get' && call.request.id.startsWith('h45abicert1:')),
        'A replacement attempt must perform a fresh canonical opening');
    await replacement.closeAndDrain();
    const calls = fixture.memory.calls.length;
    await assert.rejects(open(pair, fixture), /accepted worker attempt/);
    assert.equal(fixture.memory.calls.length, calls);
    // Existing API construction still has its own unscoped read-only issuance.
    const api = fixture.reader(), view = await api.open(fixture.selected.source, fixture.selected.selectionId);
    assert.equal((await api.authorize(view, fixture.selected.inputs[0])).kind, 'native');
});

test('fresh pair snapshots source/selection, rejects changed identity and never has an adopt/get-view API', async () => {
    const fixture = await nativeAuthorizationFixture(), pair = pairFor(fixture), scope = new ProofConsumerScope('paired-input');
    await scope.run(async () => {
        for (const [source, selection] of [[{...fixture.selected.source, blockId: 'e'.repeat(64)}, fixture.selected.selectionId],
            [fixture.selected.source, 'h45srcsel1:' + 'e'.repeat(64)]])
            await assert.rejects(pair.waitForOpen(source, selection), {code: 'source_not_canonical'});
        const held = holdRead(fixture.client, request => request.index === fixture.frontier.controlIndex);
        const source = {...fixture.selected.source}, opening = pair.waitForOpen(source, fixture.selected.selectionId);
        await held.entered; source.blockNum = 999; source.blockId = 'e'.repeat(64); held.release();
        const result = await opening; held.restore(); assert.equal(result.view.source.blockNum, 2);
        assert.deepEqual(Object.keys(pair).sort(), ['native', 'proofs', 'waitForOpen']);
        assert.equal((await pair.native.authorize(result.nativeView, fixture.selected.inputs[0])).kind, 'native');
    });
    await scope.closeAndDrain();
});

for (const fault of ['owner', 'fork', 'revoke']) test(`pair rechecks canonical ${fault} after retained native source awaits`, async () => {
    const fixture = await nativeAuthorizationFixture(), pair = pairFor(fixture), scope = new ProofConsumerScope('paired-' + fault);
    const held = holdRead(fixture.client, request => request.index === fixture.nativeStore.index);
    const opening = scope.run(() => open(pair, fixture)); const rejected = assert.rejects(opening, error => error.statusCode === 503);
    await held.entered;
    if (fault === 'owner') await fixture.replaceOwner();
    else if (fault === 'fork') await fixture.append(2, 20, 1);
    else await fixture.revoke();
    held.release(); await rejected; held.restore(); await scope.closeAndDrain();
});

test('new pair accepts distance256 and rejects monotone advance to257 during native verification', async () => {
    const fixture = await nativeAuthorizationFixture(), pair = pairFor(fixture);
    for (let height = 3; height <= 258; height++) await fixture.append(height);
    const first = new ProofConsumerScope('pair-window-256');
    await first.run(async () => {
        const result = await open(pair, fixture);
        assert.equal((await pair.native.authorize(result.nativeView, fixture.selected.inputs[0])).kind, 'native');
    });
    await first.closeAndDrain();
    const scope = new ProofConsumerScope('pair-window-crossed'), held = holdRead(fixture.client, request => request.index === fixture.nativeStore.index);
    const opening = scope.run(() => open(pair, fixture)), rejected = assert.rejects(opening, {code: 'ancestry_unavailable'});
    await held.entered; await fixture.append(259); held.release(); await rejected; held.restore(); await scope.closeAndDrain();
});

test('the existing eight-opening budget includes the paired final authority handoff and releases after cancel', {timeout: 10000}, async () => {
    const fixture = await nativeAuthorizationFixture(), pair = pairFor(fixture), sibling = pairFor(fixture);
    const scope = new ProofConsumerScope('pair-eight-opening-budget'), controller = new AbortController(), reason = Symbol('budget canceled');
    await scope.run(async () => {
        const pending = [], held = [];
        try {
            for (let index = 0; index < 8; index++) {
                let controls = 0;
                const read = holdRead(fixture.client, request => request.index === fixture.frontier.controlIndex && ++controls === 5);
                held.push(read);
                pending.push(open(pair, fixture, {signal: controller.signal}).catch(error => error));
                await read.entered; read.restore();
            }
            await assert.rejects(open(pair, fixture), {code: 'native_busy'});
            assert(Object.isFrozen(await open(sibling, fixture)));
        } finally {
            controller.abort(reason); held.forEach(read => {read.release(); read.restore();});
            for (const error of await Promise.all(pending)) assert.equal(error, reason);
        }
        assert(Object.isFrozen(await open(pair, fixture)));
    });
    await scope.closeAndDrain();
});

const invalidSources = [
    ['whole inventory incomplete', {mutateRecord(record) {record.inventory = null; record.observation = {status: 'incomplete', error: {code: 'missing', message: 'missing'}};}}],
    ['inventory digest', {mutateRecord(record) {record.inventory.sha256 = 'e'.repeat(64);}}],
    ['omitted decision', {mutateRecord(record) {record.observation.facts.decisions.pop(); record.inventory.firstReceiverCount--;}}],
    ['different decision', {mutateRecord(record) {record.observation.facts.decisions[0].nativeKind = 'other';}}],
    ['missing occurrence', {mutateInputs(inputs) {inputs.pop();}}],
    ['receipt mismatch', {mutateInputs(inputs) {inputs[0].receiptAbiSequence = '0';}}],
    ['changed original raw', {mutateTraces(traces) {traces[0][1].action_traces[0][1].act.data = 'ff';}}],
];
for (const [label, options] of invalidSources) test(`pair refuses ${label} before handoff`, async () => {
    const fixture = await nativeAuthorizationFixture(options), pair = pairFor(fixture), scope = new ProofConsumerScope('pair-invalid-' + label);
    await assert.rejects(scope.run(() => open(pair, fixture)), error => error.statusCode === 503); await scope.closeAndDrain();
});
for (const fault of ['observeMutates', 'traceMutates', 'observeThrows', 'traceDecodeThrows']) test(`pair retains original-byte check ${fault}`, async () => {
    const fixture = await nativeAuthorizationFixture(), pair = pairFor(fixture), scope = new ProofConsumerScope('pair-byte-' + fault);
    fixture.faults[fault] = true;
    await assert.rejects(scope.run(() => open(pair, fixture)), {code: 'native_verification_unavailable'}); await scope.closeAndDrain();
});

// Enumerate the actual I/O boundary sequence, then hold each real callback independently. No proof,
// native-reader or store method is replaced; this is the controlled external client transport seam.
const sample = await nativeAuthorizationFixture(), samplePair = pairFor(sample), sampleScope = new ProofConsumerScope('pair-io-sequence');
const sequence = [];
for (const [owner, method] of readOwners(sample)) {
    const original = owner[method]; owner[method] = (request, options) => {
        sequence.push(readLabel(method, request)); return original(request, options);
    };
}
await sampleScope.run(() => open(samplePair, sample)); await sampleScope.closeAndDrain();
assert(sequence.length > 20);
for (const mode of ['caller-abort', 'fenced-success', 'fenced-rejection']) for (let target = 0; target < sequence.length; target++)
    test(`paired opening ${mode} across actual I/O callback ${target + 1}/${sequence.length}`, {timeout: 10000}, async () => {
        const fixture = await nativeAuthorizationFixture(), pair = pairFor(fixture), scope = new ProofConsumerScope(`pair-io-${mode}-${target}`);
        const entered = gate(), release = gate(), controller = new AbortController(), reason = Symbol('exact caller abort');
        let ordinal = 0, settled = false, physicallySettled = false;
        const restores = [];
        for (const [owner, method] of readOwners(fixture)) {
            const original = owner[method]; restores.push(() => {owner[method] = original;});
            owner[method] = async (request, options) => {
                const index = ordinal++, result = await original(request, options);
                if (index === target) {
                    assert.deepEqual(readLabel(method, request), sequence[target]); entered.release(); await release.promise;
                    physicallySettled = true;
                    if (mode === 'fenced-rejection') throw new Error('late external callback failure');
                }
                return result;
            };
        }
        const pending = scope.run(() => open(pair, fixture, {signal: controller.signal}));
        const outcome = pending.then(value => ({value}), error => ({error}));
        await entered.promise;
        if (mode === 'caller-abort') controller.abort(reason); else scope.fence();
        const ending = mode === 'caller-abort' ? undefined : scope.closeAndDrain().then(end => {settled = true; return end;});
        await turn(); assert.equal(physicallySettled, false); assert.equal(settled, false);
        release.release(); const result = await outcome;
        assert(Object.hasOwn(result, 'error'), 'A canceled/fenced operation cannot hand off authority');
        if (mode === 'caller-abort') assert.equal(result.error, reason);
        else assert.equal(result.error.code, 'worker_attempt_fenced');
        const end = await (ending ?? scope.closeAndDrain()); assert.equal(physicallySettled, true); assertProofConsumerEnd(scope, end);
        restores.forEach(restore => restore());
    });
