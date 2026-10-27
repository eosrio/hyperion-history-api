import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PortableProjectionSource, PortableProjectionFrameError} from '../../build/indexer/projection/source.js';
import {nativeApiWireSource} from './protocol-native-api-source.mjs';
import {ContextualProjectionRuntime} from '../../build/indexer/projection/contextual-runtime.js';
import {originalProjectionTimeMs} from '../../build/indexer/projection/contextual-contract.js';
import {createMongoDbContextualRecoveryAdapter} from '../../packages/backend-mongodb/dist/index.js';
import {databaseFixture, genesis, errorCode} from '../../packages/backend-mongodb/tests/fixture.mjs';
import {ProtocolAbiProofReader} from '../../build/indexer/protocol/abi-proof.js';
import {protocolDeployment} from '../../build/indexer/protocol/deployments.js';

const definition = {schemaVersion: 2, id: 'contextual-original-source', mappingRevision: 'a'.repeat(64),
    source: {contract: 'futureitems', table: 'items', abiDeployment: 'not-yet-deployed', abiSha256: 'b'.repeat(64)},
    fields: [{name: 'time', type: 'string', source: {kind: 'context', field: 'blockTimeMs', format: 'decimal'}}],
    initialization: {kind: 'genesis'}, preserveOnReplace: ['time'], onAbsent: 'incomplete'};

test('contextual source retains original Wire block/time with the pinned independent clio oracle', async () => {
    const original = readFileSync(new URL('./fixtures/wire-native-genesis/receipt-forward-2-4-20261020.json', import.meta.url));
    assert.equal(createHash('sha256').update(original).digest('hex'), '38d75b7a1ba28e3abd77512854f963e7723631d6837df73bd7aeff656cc8a450');
    const receipt = JSON.parse(original), oracle = [
        [2, 4, '2026-10-19T18:50:11.500', 1792435811500],
        [3, 7, '2026-10-19T18:50:12.000', 1792435812000],
        [4, 10, '2026-10-19T18:50:12.500', 1792435812500],
    ];
    for (const [, index, timestamp] of oracle) {
        const result = receipt.conversions[index]; assert.equal(result.complete, true); assert.equal(result.exitCode, 0);
        assert.match(result.arguments[0], /wire-sysio-1\.0\.0-6508c9e8\/bin\/clio$/);
        const bytes = Buffer.from(result.stdout.base64, 'base64');
        assert.equal(createHash('sha256').update(bytes).digest('hex'), result.stdout.sha256);
        assert.equal(JSON.parse(bytes).timestamp, timestamp);
    }
    const fixture = await nativeApiWireSource({nativeMarker: false});
    try {
        await fixture.appendUntil(4);
        const source = new PortableProjectionSource({client: fixture.client, chain: fixture.chain,
            chainId: fixture.chainId, profile: fixture.profile, provider: fixture.provider});
        assert.equal(typeof source.contextualFrame, 'function');
        const genesisFrame = await source.contextualFrame(1, definition);
        assert.equal(genesisFrame.frame.block.blockNum, 1); assert.equal(genesisFrame.frame.changes.length, 0);
        assert.equal(Number.isSafeInteger(genesisFrame.frame.context.blockTimeMs), true);
        for (const [number, , , milliseconds] of oracle) {
            const result = await source.contextualFrame(number, definition);
            assert.deepEqual(result.frame.context, {contract: 'futureitems', table: 'items', blockTimeMs: milliseconds});
            assert.equal(result.frame.block.blockId, fixture.retained.get(number).source.blockId);
            assert.equal(result.frame.changes.length, 0, 'A not-yet-deployed table is empty under complete original source coverage');
            await source.revalidateContextualFrame(result.proof, definition);
        }
        const v1 = await source.frame(2, {...definition, schemaVersion: 1,
            fields: [{name: 'time', type: 'string', path: ['time']}]});
        assert.equal(Object.hasOwn(v1.frame, 'context'), false, 'Closed legacy frame shape is unchanged');
        const missingTimeProvider = {...fixture.provider, createShipSession(schema) {
            const session = fixture.provider.createShipSession(schema);
            return {...session, decodeBlock(bytes) {return {...session.decodeBlock(bytes), timestamp: undefined};}};
        }};
        const invalidSource = new PortableProjectionSource({client: fixture.client, chain: fixture.chain,
            chainId: fixture.chainId, profile: fixture.profile, provider: missingTimeProvider});
        await assert.rejects(invalidSource.contextualFrame(2, definition), error => error instanceof PortableProjectionFrameError
            && error.block.blockNum === 2 && error.cause?.code === 'projection.invalid-contract');
        const database = databaseFixture(), binding = {chainId: fixture.chainId, backendId: 'original-context-source',
            projectionId: definition.id, mappingRevision: definition.mappingRevision, abiDeployment: definition.source.abiDeployment,
            abiSha256: definition.source.abiSha256, generation: 'original-source-instance'};
        const adapter = createMongoDbContextualRecoveryAdapter({client: database.client,
            databaseName: 'original_context_source_fixture', backendId: binding.backendId});
        const runtime = await ContextualProjectionRuntime.create({adapter, definition, binding, genesis});
        await runtime.processSource(source, 1);
        await assert.rejects(runtime.processSource(invalidSource, 2), error => error instanceof PortableProjectionFrameError && error.block.blockNum === 2);
        assert.equal((await runtime.recovery()).checkpoint.blockNum, 1);
        await assert.rejects(runtime.open(), errorCode('projection.incomplete'));
        for (const number of [2, 3, 4]) assert.equal((await runtime.processSource(source, number)).view.checkpoint.blockNum, number);
        await assert.rejects(runtime.query({filter: [], limit: 1}), errorCode('projection.incomplete'),
            'Source coverage before deployment is not a serving grant for an unavailable mapping ABI');
        const foreignBinding = {...binding, chainId: 'd'.repeat(64), projectionId: 'foreign-chain'};
        const foreignDefinition = {...definition, id: foreignBinding.projectionId};
        const foreign = await ContextualProjectionRuntime.create({adapter, definition: foreignDefinition, binding: foreignBinding, genesis});
        await assert.rejects(foreign.processSource(source, 1), errorCode('projection.invalid-contract'));
        const unchanged = await foreign.recovery(); assert.equal(unchanged.checkpoint.blockNum, 0); assert.equal(unchanged.pending, null);
        const reader = new ProtocolAbiProofReader({chainId: fixture.chainId, profile: fixture.profile, store: fixture.frontier});
        const originalProof = await reader.open({chainId: fixture.chainId, ...fixture.retained.get(4).source});
        const nativeState = await reader.finalState(originalProof, 'sysio');
        const nativeDeployment = protocolDeployment(fixture.provider, {account: nativeState.account, block: nativeState.source.blockNum,
            block_id: nativeState.source.blockId, abi_hex: nativeState.abiHex, protocol_profile: fixture.profile.profileId},
        nativeState.account, 4, fixture.retained.get(4).source.blockId);
        const deployed = {...definition, id: 'deployed-original-context', source: {contract: 'sysio', table: 'neverpresent',
            abiDeployment: nativeDeployment.id, abiSha256: createHash('sha256').update(Buffer.from(nativeState.abiHex, 'hex')).digest('hex')}};
        const deployedBinding = {...binding, projectionId: deployed.id, abiDeployment: deployed.source.abiDeployment, abiSha256: deployed.source.abiSha256};
        const serving = await ContextualProjectionRuntime.create({adapter, definition: deployed, binding: deployedBinding, genesis});
        for (const number of [1, 2, 3, 4]) await serving.processSource(source, number);
        assert.deepEqual((await serving.query({filter: [], limit: 1})).rows, []);
        assert.equal(await fixture.coordinator.revokeSource('native-api-original-reader'), true);
        await assert.rejects(serving.query({filter: [], limit: 1}), /Source lacks current complete coverage/);
    } finally {await fixture.dispose();}
});

test('original timestamp normalization accepts only the qualified exact UTC representation', () => {
    assert.equal(originalProjectionTimeMs('2026-10-19T18:50:11.500'), 1792435811500);
    assert.equal(originalProjectionTimeMs('1970-01-01T00:00:00.000'), 0);
    for (const value of [undefined, null, 1792435811500, '2026-10-19T18:50:11.500Z',
        '2026-10-19T18:50:11.500+00:00', '2026-10-19T18:50:11', '2026-02-30T00:00:00.000',
        '1969-12-31T23:59:59.500', '2026-10-19T18:50:11.5000', '2026-10-19 18:50:11.500']) {
        assert.throws(() => originalProjectionTimeMs(value), errorCode('projection.invalid-contract'));
    }
});
