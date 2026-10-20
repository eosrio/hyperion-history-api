import assert from 'node:assert/strict';
import type {Client} from '@elastic/elasticsearch';
import {auditFixture, canonical, contractAccount, digest} from './contract-fixture.ts';

/** Independent native re-decode of audited bytes; source certificates are inspected, never repaired here. */
export async function inspectActionSourceAdmission(client: Client, chain: string, fixture: Awaited<ReturnType<typeof auditFixture>>) {
    const {ActionSourceAdmissionStore} = await import(new URL('../../build/indexer/history/action-source-admission.js', import.meta.url).href);
    const {createAntelopeProvider} = await import(new URL('../../build/indexer/protocol/antelope.js', import.meta.url).href);
    const {deriveActionSourceInventory} = await import(new URL('../../build/indexer/history/action-source-inventory.js', import.meta.url).href);
    const {protocolBytes} = await import(new URL('../../build/indexer/protocol/contract-cache.js', import.meta.url).href);
    const store = new ActionSourceAdmissionStore(client, chain, 1);
    const records = fixture.records.filter(record => record.blockNum >= fixture.replayStart);
    const {provider} = await createAntelopeProvider(), session = provider.createShipSession(fixture.abi.toJSON());
    const targetName = `${chain}-action-v1-000001`;
    const settings = await client.indices.getSettings({index: targetName, flat_settings: true});
    const uuid = settings[targetName]?.settings?.['index.uuid']; assert.equal(typeof uuid, 'string');
    const target = {name: targetName, uuid};
    const expected = new Map(records.map(record => [record.blockNum, record]));
    const plans: any[] = []; let after: string | undefined, transactions = 0, groups = 0;
    try {
        do {
            const page = await store.discoverSources(after); after = page.after;
            for (const id of page.ids) {
                assert.ok(plans.length < records.length, 'unexpected duplicate/extra retained source');
                const admission = await store.inspectSource(id, target);
                assert.equal(admission.incomplete, null); assert.ok(admission.inventory && admission.planId);
                const source = admission.source, blockNum = admission.inventory.source.blockNum;
                const record = expected.get(blockNum); assert.ok(record, 'retained source has an unexpected/repeated block'); expected.delete(blockNum);
                assert.equal(source.frameHex, record.frame.toString('hex'));
                const ingress = await store.resolveIngress(source.ingressId);
                assert.equal(ingress.frameHex, source.frameHex); assert.equal(ingress.schemaJson, source.schemaJson);
                assert.equal(ingress.captureSha256, source.captureSha256); assert.equal(ingress.chainId, fixture.manifest.chainId);
                const [, result] = session.decodeResult(record.frame), block = session.decodeBlock(protocolBytes(result.block));
                const traces = session.decodeTraces(protocolBytes(result.traces));
                assert.equal(canonical(source.inventoryInput.traces), canonical(traces), 'retained original traces differ from native capture');
                const inventory = deriveActionSourceInventory({profileId: 'antelope-default-v1', traces,
                    source: {chainId: fixture.manifest.chainId, blockNum, blockId: record.id, producer: block.producer, timestamp: block.timestamp},
                    policy: {schemaVersion: 1, parserVersion: '3.2', actionBlacklist: [], actionWhitelist: [contractAccount + '::*'],
                        rootOnly: false, maxDepth: 10, maxInline: 0, eosioAlias: 'eosio'}});
                assert.equal(canonical(admission.inventory), canonical(inventory), 'admitted membership differs from independent native derivation');
                const {manifest} = await store.journal.readManifest(admission.planId);
                assert.deepEqual(manifest.fragments.map((fragment: any) => fragment.transactionId), inventory.transactions.map((transaction: any) => transaction.transactionId));
                assert.deepEqual(manifest.fragments.map((fragment: any) => fragment.effects.length), inventory.transactions.map((transaction: any) => transaction.groups.length));
                const effects = inventory.transactions.reduce((sum: number, transaction: any) => sum + transaction.groups.length, 0);
                transactions += inventory.transactions.length; groups += effects;
                plans.push({admissionId: admission.id, sourceId: id, planId: admission.planId, blockNum, blockId: record.id,
                    captureSha256: source.captureSha256, originalFrameSha256: digest(record.frame), target,
                    producer: source.producer, executableSha256: source.executableSha256,
                    transactions: inventory.transactions.length, effects, manifestSha256: digest(Buffer.from(canonical(manifest)))});
            }
        } while (after);
        assert.equal(expected.size, 0, 'some native source blocks lack discoverable complete admission');
        assert.equal(groups, fixture.actions.length, 'native source-derived selected output count differs from audited contract oracle');
        return {schemaVersion: 1, runtime: process.version, protocolId: 'antelope', profileId: provider.profileId,
            source: 'audited-retained-native-capture', capturedBlocks: fixture.records.length, replayStart: fixture.replayStart,
            replayedBlocks: records.length, transactions, selectedGroups: groups, target, plans: plans.sort((a, b) => a.blockNum - b.blockNum),
            limits: ['Source membership and persisted fragment inspection only; no canonical/query-ready or sink reconciliation authority.',
                'Genesis before the trace-log start is audited and excluded from replay; no invented empty source certificate.',
                'This positive real-broker run does not establish process-crash/restart or selected Wire testnet qualification.']};
    } finally {session.close();}
}
