import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ProtocolAbiProofReader} from '../../build/indexer/protocol/abi-proof.js';
import {ProofConsumerFencedError, ProofConsumerScope, assertProofConsumerEnd} from '../../build/indexer/protocol/proof-consumer-scope.js';

const profile = {id: '@eosrio/hyperion-wire-plugin', profileId: 'proof-engineering-v1', components: [
    {id: 'wire-node', runtime: 'node' as const, version: '0.0.0-dev.1', sourceRevision: 'b'.repeat(40), sha256: 'c'.repeat(64)}]};
const source = {chainId: '1'.repeat(64), blockNum: 2, blockId: '2'.repeat(64)};

for (const completion of ['fulfilled', 'ordinary', 'foreign'] as const) {
    test(`pending proof read preserves ${completion === 'fulfilled' ? 'owned cancellation' : completion + ' failure'} after its source is fenced`, async () => {
        let enter!: () => void, release!: () => void, fail!: (error: Error) => void;
        const entered = new Promise<void>(resolve => {enter = resolve;});
        const held = new Promise<void>((resolve, reject) => {release = resolve; fail = reject;});
        const primary = completion === 'foreign' ? new ProofConsumerFencedError() : new Error('Original retained read failure');
        const reader = new ProtocolAbiProofReader({chainId: source.chainId, profile,
            store: {async readControl() {enter(); await held; return null;}} as any, requireAttemptScope: true});
        const scope = new ProofConsumerScope('proof-read-' + completion);
        const result = scope.run(() => reader.open(source)).then(() => null, error => error);
        await entered;
        scope.fence();
        let drained = false;
        const closing = scope.closeAndDrain().then(end => {drained = true; return end;});
        await Promise.resolve();
        assert.equal(drained, false);
        if (completion === 'fulfilled') release(); else fail(primary);
        const error = await result;
        if (completion === 'fulfilled') assert.equal(scope.ownsFenceError(error), true);
        else {assert.equal(error, primary); assert.equal(scope.ownsFenceError(error), false);}
        const end = await closing;
        assertProofConsumerEnd(scope, end);
        assert.equal(scope.snapshot().pendingOperations, 0);
    });
}

for (const kind of ['ordinary', 'foreign'] as const) {
    test(`a caller abort carrying a ${kind} error cannot acquire the later source fence`, async () => {
        let enter!: () => void, fail!: (error: Error) => void;
        const entered = new Promise<void>(resolve => {enter = resolve;});
        const held = new Promise<void>((_resolve, reject) => {fail = reject;});
        const primary = kind === 'foreign' ? new ProofConsumerFencedError() : new Error('Original caller failure');
        const caller = new AbortController(), scope = new ProofConsumerScope('proof-caller-' + kind);
        const reader = new ProtocolAbiProofReader({chainId: source.chainId, profile,
            store: {async readControl() {enter(); await held; return null;}} as any, requireAttemptScope: true});
        const result = scope.run(() => reader.open(source, undefined, {signal: caller.signal})).then(() => null, error => error);
        await entered;
        caller.abort(primary);
        scope.fence();
        fail(primary);
        const error = await result;
        assert.equal(error, primary);
        assert.equal(scope.ownsFenceError(error), false);
        assertProofConsumerEnd(scope, await scope.closeAndDrain());
    });
}

for (const kind of ['ordinary', 'foreign'] as const) {
    test(`a fulfilled read retains caller cancellation before a later source fence (${kind})`, async () => {
        let enter!: () => void, release!: () => void;
        const entered = new Promise<void>(resolve => {enter = resolve;});
        const held = new Promise<void>(resolve => {release = resolve;});
        const primary = kind === 'foreign' ? new ProofConsumerFencedError() : new Error('Original caller cancellation');
        const caller = new AbortController(), scope = new ProofConsumerScope('proof-fulfilled-caller-' + kind);
        const reader = new ProtocolAbiProofReader({chainId: source.chainId, profile,
            store: {async readControl() {enter(); await held; return null;}} as any, requireAttemptScope: true});
        const result = scope.run(() => reader.open(source, undefined, {signal: caller.signal})).then(() => null, error => error);
        await entered;
        caller.abort(primary);
        scope.fence();
        release();
        const error = await result;
        assert.equal(error?.code, 'proof_cancelled');
        assert.equal(scope.ownsFenceError(error), false);
        assertProofConsumerEnd(scope, await scope.closeAndDrain());
    });
}
