import {expect, it} from 'bun:test';
import {setImmediate as turn} from 'node:timers/promises';
import {ProtocolAbiProofReader} from '../../src/indexer/protocol/abi-proof.js';
import {ProofConsumerScope, assertProofConsumerEnd} from '../../src/indexer/protocol/proof-consumer-scope.js';

const gate = () => {let release!: () => void; const promise = new Promise<void>(resolve => {release = resolve;}); return {promise, release};};
const profile = {id: '@eosrio/hyperion-wire-plugin', profileId: 'proof-engineering-v1', components: [
    {id: 'wire-node', runtime: 'node' as const, version: '0.0.0-dev.1', sourceRevision: 'b'.repeat(40), sha256: 'c'.repeat(64)}]};

it('does not end the real retained read when its proof wait loses the abort race', async () => {
    const entered = gate(), held = gate(); let physicalPending = 0;
    const store: any = {async readControl() {physicalPending++; entered.release(); try {await held.promise; return null;} finally {physicalPending--;}}};
    const reader = new ProtocolAbiProofReader({chainId: '1'.repeat(64), profile, store});
    const scope = new ProofConsumerScope('original-delivery'), cancellation = new AbortController();
    const root = scope.run(() => reader.waitForOpen({chainId: '1'.repeat(64), blockNum: 33, blockId: '2'.repeat(64)},
        undefined, {signal: cancellation.signal}));
    await entered.promise; cancellation.abort(); await expect(root).rejects.toMatchObject({code: 'proof_cancelled'});
    expect(physicalPending).toBe(1);
    let ended = false; const ending = scope.closeAndDrain().then(end => {ended = true; return end;});
    await turn(); expect(ended).toBe(false);
    held.release(); const end = await ending;
    expect(physicalPending).toBe(0); expect(scope.snapshot().state).toBe('drained'); assertProofConsumerEnd(scope, end);
    expect(() => assertProofConsumerEnd(scope, {} as any)).toThrow('Unissued');
    expect(() => scope.run(() => reader.open({chainId: '1'.repeat(64), blockNum: 33, blockId: '2'.repeat(64)}))).toThrow();
});
