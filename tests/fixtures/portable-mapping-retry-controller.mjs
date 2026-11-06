/** Controlled source/adapter ports around the actual emitted portable controller/runtime. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PROJECTION_CAPABILITIES, ProjectionContractError, validateProjectionApply} from '@eosrio/hyperion-sdk/projection';
import {PortableStateController} from '../../build/indexer/projection/controller.js';
import {resolvePortableStateConfiguration, portableStateBinding} from '../../build/indexer/projection/config.js';
import {ProofConsumerScope, currentProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';
import {hash} from './portable-mapping-retry.mjs';

export const plan = JSON.parse(readFileSync(new URL('../fixtures/portable-state-worker/plan.template.json', import.meta.url)));
export const first = plan.definitions.find(definition => plan.barriers[0].rows[definition.id].length > 0);
assert(first);
export const invalid = {...structuredClone(first), id: 'qualification-invalid-' + hash(JSON.stringify(first)).slice(0, 16),
    fields: [{name: 'qualification_missing_required', path: ['__hyperion_qualification_missing_required_v1__'], type: 'string'}]};
invalid.mappingRevision = hash(JSON.stringify({...invalid, mappingRevision: 'qualification-invalid-required-v1'}));

export async function fixture(original, interval, options = {}) {
    const configuration = resolvePortableStateConfiguration({backend: {kind: 'mongodb', id: 'controlled', database: 'controlled'},
        projections: options.projections ?? [...plan.definitions, invalid]}, original.chainId);
    const previous = original.position(1243), metadata = new Map(), calls = [], progress = [], attempts = [], bindings = [];
    const failureMarkers = [], invalidSourceStarts = [];
    const selectedProofs = new WeakMap();
    const counts = {recovery: 0, source: 0, revalidate: 0, admission: 0, failure: 0, apply: 0};
    for (const definition of configuration.projections) {
        const binding = portableStateBinding(configuration, definition, original.chainId);
        metadata.set(definition.id, {binding, initialized: true, checkpoint: structuredClone(previous), pending: null, gap: null});
    }
    const adapter = {
        capabilities: {interfaceVersion: 1, supported: [...PROJECTION_CAPABILITIES]},
        async initialize(_definition, binding) {return this.open(binding);},
        async open(binding) {const value = metadata.get(binding.projectionId);
            if (value.pending || value.gap) throw new ProjectionContractError('projection.incomplete', 'controlled pending source');
            return structuredClone({binding: value.binding, checkpoint: value.checkpoint});},
        async recovery(binding) {counts.recovery++; currentProofConsumerScope(true).assertActive();
            return structuredClone(metadata.get(binding.projectionId));},
        async markIncomplete(binding, block, reason) {
            currentProofConsumerScope(true).assertActive();
            counts[reason === 'Canonical projection source admitted; durable application is pending' ? 'admission' : 'failure']++;
            metadata.get(binding.projectionId).pending = {block: structuredClone(block), reason, digest: null};
            if (reason !== 'Canonical projection source admitted; durable application is pending')
                failureMarkers.push({projectionId: binding.projectionId, blockNum: block.blockNum, at: performance.now()});
        },
        async apply(request) {
            currentProofConsumerScope(true).assertActive(); counts.apply++;
            const definition = configuration.projections.find(value => value.id === request.binding.projectionId);
            assert.equal(validateProjectionApply(definition, request).valid, true);
            const value = metadata.get(definition.id);
            assert.equal(request.previous.blockNum, value.checkpoint.blockNum, 'no input height may be skipped');
            assert.equal(request.previous.blockId, value.checkpoint.blockId, 'no input identity may be substituted');
            value.checkpoint = {blockNum: request.block.blockNum, blockId: request.block.blockId}; value.pending = null;
            return {status: 'applied', view: {binding: value.binding, checkpoint: structuredClone(value.checkpoint)}};
        },
        async query() {throw new Error('Controlled adapter grants no serving authority');},
    };
    const source = {
        async frame(height, definition, admit) {
            const scope = currentProofConsumerScope(true); scope.assertActive(); counts.source++;
            if (definition.id === invalid.id) invalidSourceStarts.push(performance.now());
            const bound = bindings.findLast(value => value.scope === scope.id)?.fields;
            assert.equal(bound.checkpointBlockNum + 1, height, 'each source selection follows a fresh accepted checkpoint binding');
            const selected = await original.frame(height, definition, admit);
            selectedProofs.set(selected.proof, {scope, block: selected.frame.block});
            calls.push({projectionId: definition.id, height, originalFrameSha256: selected.evidence.originalFrameSha256,
                originalAbiSha256: selected.evidence.originalAbiSha256});
            return selected;
        },
        async revalidate(proof) {
            const scope = currentProofConsumerScope(true); scope.assertActive();
            const selected = selectedProofs.get(proof), bound = bindings.findLast(value => value.scope === scope.id)?.fields;
            assert.equal(selected.scope, scope, 'every retry revalidates a newly selected proof in its actual attempt');
            assert.equal(bound.blockNum, selected.block.blockNum); assert.equal(bound.blockId, selected.block.blockId);
            counts.revalidate++; return original.revalidate(proof);
        },
    };
    await options.beforeCreate?.({adapter, source, metadata, counts, progress});
    const controllerOptions = {chainId: original.chainId, configuration, adapter, source,
        ...(interval === undefined ? {} : {mappingRetryEligibilityMs: interval}),
        ...(options.maximumFramesPerProjection ? {maximumFramesPerProjection: options.maximumFramesPerProjection} : {}),
        onProgress: value => progress.push(structuredClone(value)),
        attempts: {
            async run(metadata, operation) {
                const scope = new ProofConsumerScope('retry-control-' + attempts.length);
                attempts.push({scope: scope.id, projectionId: metadata.projectionId});
                try {return await scope.run(operation);} finally {await scope.closeAndDrain();}
            },
            async bind(fields) {const scope = currentProofConsumerScope(true); scope.assertActive(); bindings.push({scope: scope.id, fields: structuredClone(fields)});},
        }};
    const controller = await PortableStateController.create(controllerOptions);
    return {controller, metadata, calls, progress, counts, attempts, bindings, adapter, source, configuration, controllerOptions,
        failureMarkers, invalidSourceStarts};
}
