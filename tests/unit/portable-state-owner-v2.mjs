/** Emitted source/owner/custody over retained inputs and native command fixtures; no services. */
import assert from 'node:assert/strict';
import {preparedStatefulInputs, capture} from './portable-state-source-fixture.mjs';
import {ProtocolAbiProofReader} from '../../build/indexer/protocol/abi-proof.js';
import {ProtocolAbiFrontierStore} from '../../build/indexer/protocol/abi-frontier-store.js';
import {statefulAbiEpoch} from '../../build/indexer/projection/stateful-abi-epoch.js';
import {StatefulProjectionControllerV2} from '../../build/indexer/projection/stateful-controller.js';
import {createStatefulCandidateCustodyV2} from '../../build/indexer/projection/stateful-custody.js';
import {captureStatefulDeclaration} from '@eosrio/hyperion-sdk/projection-stateful';
import {negotiateStatefulOwnerV2, STATEFUL_OWNER_FAMILY_V2, STATEFUL_OWNER_HOST_CAPABILITIES_V2,
    composeStatefulOwnerReadV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {definition, limits} from '../../packages/backend-mongodb/tests/stateful-fixture.mjs';
import {configured, v1 as backendStateful} from '../../packages/backend-mongodb/tests/stateful-owner-v2-fixture.mjs';

assert.equal(process.versions.bun, undefined); assert.match(process.version, /^v(?:24|26)\./);
const {p, value, rawValue} = await preparedStatefulInputs();
const reader = new ProtocolAbiProofReader({chainId: capture.chainId, profile: p.options.profile,
    store: new ProtocolAbiFrontierStore(p.options.client, p.options.chain, 0, {readOnly: true})});
const proof = await reader.open(p.positions[2]), epoch = statefulAbiEpoch(await reader.finalState(proof, 'target'));
const selected = definition(); selected.binding.chainId = capture.chainId;
selected.selectors = [{id: 'update', kind: 'action', contract: 'target', name: 'update', abiDeployment: epoch.id, abiSha256: epoch.abiSha256},
    {id: 'records', kind: 'table', contract: 'target', name: 'records', abiDeployment: epoch.id, abiSha256: epoch.abiSha256}];
const projection = await captureStatefulDeclaration(selected, limits());
const native = await configured(undefined, {projection: await backendStateful.captureStatefulDeclaration(selected, limits())});
const declaration = await negotiateStatefulOwnerV2(projection, {family: STATEFUL_OWNER_FAMILY_V2, interfaceVersion: 2,
    sourceInputVersions: [2], supported: STATEFUL_OWNER_HOST_CAPABILITIES_V2, limits: projection.limits}, native.adapter.capabilities);
const source = await p.source.statefulBlock(3, declaration, async () => {});
assert.deepEqual(source.source.source.inputs.map(value => value.kind), ['action', 'table', 'table', 'table']);
assert.equal(source.source.source.inputs[0].rawHex, rawValue);
assert.deepEqual({...source.source.source.inputs[0].data}, value);
assert.deepEqual({...source.source.source.inputs[1].identity}, {kind: 'kv-primary', tableId: 0, keyHex: '000001'});
assert.equal(source.source.source.inputs[2].present, false); assert.equal(source.source.source.inputs[2].data, null);
assert.deepEqual({...source.source.source.inputs[3].identity}, {kind: 'kv-secondary', tableId: 65535, secondaryKeyHex: '0000', primaryKeyHex: '000001'});
assert.equal(source.source.source.inputs[3].data, null);
for (const input of source.source.source.inputs.filter(value => value.kind === 'table')) assert.equal(Object.hasOwn(input.identity, 'scope'), false);
assert.equal((await p.source.statefulBlock(3, declaration, async () => {})).source.digest, source.source.digest);
const custody = createStatefulCandidateCustodyV2(p.options.client, p.options.chain, 0, declaration);
let reductions = 0, interrupt = false;
const adapter = new Proxy(native.adapter, {get(target, key) {
    if (key === 'retireRaw') return async (...args) => {
        if (interrupt) {interrupt = false; throw new Error('constructed apply-before-retire interruption');}
        return target.retireRaw(...args);
    };
    const member = Reflect.get(target, key); return typeof member === 'function' ? member.bind(target) : member;
}});
const options = {declaration, adapter, source: p.source, custody, assertActive() {}, requireAttemptScope: false,
    run: async (_metadata, operation) => operation(), maximumFramesPerDrain: 1,
    reduce: async port => {reductions++; port.put('collection', 'last', {height: port.source.block.blockNum, occurrences: port.source.inputs.length});}};
const first = new StatefulProjectionControllerV2({...options, identity: {id: 'native-component', generation: 'one'}});
await first.drain(); await first.drain(); interrupt = true; await first.drain();
const failed = await native.adapter.recovery(); assert.equal(failed.view.checkpoint.blockNum, 3); assert(failed.raw); assert(failed.gap);
assert.equal(reductions, 3);
await assert.rejects(first.attest({declarationDigest: declaration.digest, owner: failed.owner, view: failed.view}));
await first.stop();
const second = new StatefulProjectionControllerV2({...options, identity: {id: 'native-component', generation: 'two'}});
await assert.rejects(second.attest({declarationDigest: declaration.digest, owner: failed.owner, view: failed.view}));
await second.drain(); const recovered = await native.adapter.recovery();
assert.equal(recovered.view.checkpoint.blockNum, 3); assert.equal(recovered.raw, null); assert.equal(recovered.gap, null); assert.equal(reductions, 3);
const expected = {declarationDigest: declaration.digest, owner: recovered.owner, view: recovered.view};
await second.attest(expected);
const result = await composeStatefulOwnerReadV2(declaration, native.adapter, recovered.owner.identity, recovered.view,
    async port => ({row: await port.get('collection', 'last')}), () => {});
assert.equal(JSON.stringify(result.value.row), JSON.stringify({status: 'present', value: {height: 3, occurrences: 4}}));
await assert.rejects(second.attest({...expected, owner: failed.owner}));
await second.stop();
const gate = () => {let release; const promise = new Promise(resolve => {release = resolve;}); return {promise, release};};
const admissionEntered = gate(), admissionRelease = gate(), reductionEntered = gate(), reductionRelease = gate();
const heldAdapter = new Proxy(native.adapter, {get(target, key) {
    if (key === 'admitRaw') return async (...args) => {
        await target.admitRaw(...args); admissionEntered.release(); await admissionRelease.promise;
    };
    const member = Reflect.get(target, key); return typeof member === 'function' ? member.bind(target) : member;
}});
const third = new StatefulProjectionControllerV2({...options, adapter: heldAdapter,
    identity: {id: 'native-component', generation: 'three'}, reduce: async port => {
        reductionEntered.release(); await reductionRelease.promise; await options.reduce(port);
    }});
await third.drain(); const warm = await native.adapter.recovery();
const oldView = {declarationDigest: declaration.digest, owner: warm.owner, view: warm.view}; await third.attest(oldView);
await p.advance(4); const active = third.drain(); await admissionEntered.promise;
await assert.rejects(third.attest(oldView)); // Native persistence alone cannot settle an unknown admission ACK.
admissionRelease.release(); await reductionEntered.promise;
await third.attest(oldView); // Known normal in-flight work can use the unchanged coherent completed view.
reductionRelease.release(); await active; await assert.rejects(third.attest(oldView)); await third.stop();

const other = await preparedStatefulInputs();
const otherNative = await configured(undefined, {projection: await backendStateful.captureStatefulDeclaration(selected, limits())});
let unknownAdmission = false, otherReductions = 0;
const uncertainAdapter = new Proxy(otherNative.adapter, {get(target, key) {
    if (key === 'admitRaw') return async (...args) => {
        await target.admitRaw(...args);
        if (unknownAdmission) {unknownAdmission = false; throw new Error('constructed unknown durable admission acknowledgement');}
    };
    const member = Reflect.get(target, key); return typeof member === 'function' ? member.bind(target) : member;
}});
const otherOptions = {...options, adapter: uncertainAdapter, source: other.p.source,
    custody: createStatefulCandidateCustodyV2(other.p.options.client, other.p.options.chain, 0, declaration),
    reduce: async port => {otherReductions++; port.put('collection', 'last', {height: port.source.block.blockNum});}};
const uncertain = new StatefulProjectionControllerV2({...otherOptions, identity: {id: 'uncertain-component', generation: 'one'}});
await uncertain.drain(); await uncertain.drain(); unknownAdmission = true; await uncertain.drain();
const unknown = await otherNative.adapter.recovery(); assert.equal(unknown.view.checkpoint.blockNum, 2); assert(unknown.raw); assert.equal(otherReductions, 2);
await assert.rejects(uncertain.attest({declarationDigest: declaration.digest, owner: unknown.owner, view: unknown.view})); await uncertain.stop();
const repaired = new StatefulProjectionControllerV2({...otherOptions, identity: {id: 'uncertain-component', generation: 'two'}});
await assert.rejects(repaired.attest({declarationDigest: declaration.digest, owner: unknown.owner, view: unknown.view}));
await repaired.drain(); assert.equal((await otherNative.adapter.recovery()).view.checkpoint.blockNum, 3); assert.equal(otherReductions, 3); await repaired.stop();
console.log(JSON.stringify({cases: 6, actualEmittedSource: true, actualOwnerRuntime: true, immutableCandidateCustody: true,
    selectedActionsAndKv: true, scopeInvented: false, applyBeforeRetireRecovered: true, reducerRerun: false,
    unknownAdmissionFenced: true, unknownAdmissionColdRepaired: true, coherentNormalInflightEligible: true,
    services: false, productionWorkerControl: false, physicalDomainParity: false}));
