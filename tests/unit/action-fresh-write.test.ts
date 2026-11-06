import {expect, test} from 'bun:test';
import {ProofConsumerScope} from '../../src/indexer/protocol/proof-consumer-scope.js';
import {consumeFreshActionWrite, issueFreshActionWrite} from '../../src/indexer/history/action-fresh-write.js';
import {ImmutableProtocolBundleStore} from '../../src/indexer/protocol/immutable-bundle-store.js';
import {actionHistoryImmutableJson} from '../../src/indexer/history/action-history-manifest.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

test('a returned durable write cannot be joined to a different physical attempt or a record read', async () => {
    const original = new ProofConsumerScope('original'), redelivery = new ProofConsumerScope('redelivery');
    const bundles = new ImmutableProtocolBundleStore(frontierMemoryClient().client as any, 'fresh-fixture', 0,
        'action-source-admission', 'history-source-admission-v1');
    const id = 'h45actionattempt1:' + 'a'.repeat(64), record = {
        disposition: 'no-effects', work: {source: 'same-semantic-source'}};
    const result = await original.run(async () => {
        const proof = await bundles.prepare(id, {schemaVersion: 1, payloadJson: actionHistoryImmutableJson(record)});
        return issueFreshActionWrite({id}, 'attempt-disposition', id, record, proof, bundles);
    });
    await redelivery.run(() => {
        expect(() => consumeFreshActionWrite(result)).toThrow('this worker attempt');
        expect(() => consumeFreshActionWrite({...result})).toThrow('fresh result');
    });
    const consumed = await original.operation(() => consumeFreshActionWrite(result));
    expect(consumed).toMatchObject({kind: 'attempt-disposition', id});
    await expect(original.operation(() => consumeFreshActionWrite(result))).rejects.toThrow('fresh result');
    await Promise.all([original.closeAndDrain(), redelivery.closeAndDrain()]);
});
