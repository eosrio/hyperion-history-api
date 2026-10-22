import {afterEach, describe, expect, it} from 'bun:test';
import {EventEmitter} from 'node:events';
import {publishAdmittedAction, publishAdmittedActionWithEvidence, readConfirmedActionPublications,
    assertActionPublicationBatchBudget, actionPublicationEvidenceBounds, type ConfirmedActionPublication, type ActionPublicationOwner} from '../../src/indexer/history/action-confirmed-publication.js';

class Publisher extends EventEmitter {
    writable = true;
    calls: Array<{queue: string; payload: Buffer; options: any; confirm: (error?: Error | null) => void}> = [];
    duringSend?: (call: Publisher['calls'][number]) => void;
    sendToQueue(queue: string, payload: Buffer, options: any, confirm: (error?: Error | null) => void) {
        const call = {queue, payload, options, confirm}; this.calls.push(call); this.duringSend?.(call); return this.writable;
    }
}
const publishers = new Set<Publisher>();
afterEach(() => {
    // A failed assertion must not leave the helper's real 30-second timer running.
    for (const publisher of publishers) if (publisher.listenerCount('close')) publisher.emit('close');
    publishers.clear();
});
function fixture() {
    const consumer = new EventEmitter(), publisher = new Publisher();
    publishers.add(publisher);
    let activeConsumer = consumer, activePublisher = publisher;
    const owner = {consumer, publisher, current: () => activeConsumer === consumer && activePublisher === publisher} as unknown as ActionPublicationOwner;
    return {consumer, publisher, owner, replaceConsumer: () => {activeConsumer = new EventEmitter();},
        replacePublisher: () => {activePublisher = new Publisher(); return activePublisher;}};
}
function start(value: ReturnType<typeof fixture>, signal?: AbortSignal) {
    const pending = publishAdmittedAction(value.owner, 'owned:actions', Buffer.from('logical-action'),
        {persistent: false, mandatory: false, messageId: 'caller-id', headers: {block_num: 12}}, signal);
    pending.catch(() => {}); return pending;
}
async function observe(promise: Promise<unknown>) {
    let state: 'pending' | 'resolved' | 'rejected' = 'pending';
    promise.then(() => {state = 'resolved';}, () => {state = 'rejected';});
    for (let index = 0; index < 3; index++) await Promise.resolve();
    return () => state;
}
function clean(publisher: Publisher) {
    for (const event of ['drain', 'close', 'error', 'return']) expect(publisher.listenerCount(event)).toBe(0);
}

describe('confirmed admitted action publication', () => {
    it('forces persistent mandatory identity and waits for delayed confirmation', async () => {
        const value = fixture(), pending = start(value), state = await observe(pending);
        expect(state()).toBe('pending'); expect(value.publisher.calls).toHaveLength(1);
        const call = value.publisher.calls[0]; expect(call.queue).toBe('owned:actions');
        expect(call.options.persistent).toBe(true); expect(call.options.mandatory).toBe(true);
        expect(call.options.messageId).not.toBe('caller-id'); expect(call.options.messageId).toMatch(/^[0-9a-f-]{36}$/);
        expect(call.options.headers).toEqual({block_num: 12});
        call.confirm(null); await pending; clean(value.publisher); expect(value.publisher.calls).toHaveLength(1);
    });
    for (const order of ['confirm-first', 'drain-first'] as const) {
        it(`false buffering needs both drain and confirmation, without resend (${order})`, async () => {
            const value = fixture(); value.publisher.writable = false;
            const pending = start(value), state = await observe(pending), call = value.publisher.calls[0];
            if (order === 'confirm-first') call.confirm(null); else value.publisher.emit('drain');
            for (let index = 0; index < 3; index++) await Promise.resolve();
            expect(state()).toBe('pending'); expect(value.publisher.calls).toHaveLength(1);
            if (order === 'confirm-first') value.publisher.emit('drain'); else call.confirm(null);
            await pending; expect(value.publisher.calls).toHaveLength(1); clean(value.publisher);
        });
    }
    it('supports synchronous confirm/drain during send without losing ownership or resending', async () => {
        const value = fixture(); value.publisher.writable = false;
        value.publisher.duringSend = call => {call.confirm(null); value.publisher.emit('drain');};
        await start(value); expect(value.publisher.calls).toHaveLength(1); clean(value.publisher);
    });
    it('rejects failed confirmations and synchronous send failures, then removes listeners', async () => {
        for (const synchronous of [false, true]) {
            const value = fixture(), error = new Error(synchronous ? 'send threw' : 'broker NACK');
            if (synchronous) value.publisher.duringSend = () => {throw error;};
            const pending = start(value); if (!synchronous) value.publisher.calls[0].confirm(error);
            await expect(pending).rejects.toBe(error); expect(value.publisher.calls).toHaveLength(1); clean(value.publisher);
        }
    });
    it('handles a synchronous NACK even when send returns false', async () => {
        const value = fixture(), error = new Error('synchronous NACK'); value.publisher.writable = false;
        value.publisher.duringSend = call => call.confirm(error);
        await expect(start(value)).rejects.toBe(error); clean(value.publisher);
    });
    it('ignores unrelated mandatory returns but rejects the matching message before confirmation', async () => {
        const value = fixture(), pending = start(value), state = await observe(pending), call = value.publisher.calls[0];
        value.publisher.emit('return', {properties: {messageId: 'another-publication'}});
        expect(state()).toBe('pending');
        value.publisher.emit('return', {properties: {messageId: call.options.messageId}, fields: {replyCode: 312}});
        await expect(pending).rejects.toThrow('unroutable'); call.confirm(null);
        expect(value.publisher.calls).toHaveLength(1); clean(value.publisher);
    });
    it('handles a synchronous mandatory return before send returns', async () => {
        const value = fixture(); value.publisher.duringSend = call => value.publisher.emit('return', {properties: {messageId: call.options.messageId}});
        await expect(start(value)).rejects.toThrow('unroutable'); clean(value.publisher);
    });
    it('rejects publisher close/error while a confirmation is pending', async () => {
        for (const event of ['close', 'error']) {
            const value = fixture(), pending = start(value), error = new Error('channel error');
            value.publisher.emit(event, ...(event === 'error' ? [error] : []));
            if (event === 'error') await expect(pending).rejects.toBe(error);
            else await expect(pending).rejects.toThrow('closed');
            clean(value.publisher);
        }
    });
    for (const channel of ['consumer', 'publisher'] as const) {
        it(`refuses a replaced ${channel} before send or while awaiting confirmation`, async () => {
            const before = fixture(); if (channel === 'consumer') before.replaceConsumer(); else before.replacePublisher();
            await expect(start(before)).rejects.toThrow('original channels'); expect(before.publisher.calls).toHaveLength(0);
            clean(before.publisher);
            const during = fixture(), pending = start(during);
            if (channel === 'consumer') during.replaceConsumer(); else during.replacePublisher();
            during.publisher.calls[0].confirm(null);
            await expect(pending).rejects.toThrow('channels changed'); expect(during.publisher.calls).toHaveLength(1); clean(during.publisher);
        });
    }
    it('does not let a replacement drain complete a buffered old-channel publication', async () => {
        const value = fixture(); value.publisher.writable = false;
        const pending = start(value), state = await observe(pending); value.publisher.calls[0].confirm(null);
        const replacement = value.replacePublisher(); replacement.emit('drain');
        await Promise.resolve(); expect(state()).toBe('pending');
        value.publisher.emit('drain'); await expect(pending).rejects.toThrow('channels changed'); clean(value.publisher);
    });
    it('cancels before send, while pending and after confirmation before the continuation', async () => {
        for (const point of ['before', 'pending', 'confirmed']) {
            const value = fixture(), controller = new AbortController(), reason = new Error('cancel-' + point);
            if (point === 'before') controller.abort(reason);
            const pending = start(value, controller.signal);
            if (point === 'confirmed') value.publisher.calls[0].confirm(null);
            if (point !== 'before') controller.abort(reason);
            await expect(pending).rejects.toBe(reason); clean(value.publisher);
            expect(value.publisher.calls).toHaveLength(point === 'before' ? 0 : 1);
            value.publisher.calls[0]?.confirm(null);
        }
    });
    for (const missing of ['confirmation', 'drain'] as const) {
        it(`times out a lost ${missing} without a real thirty-second wait`, async () => {
            const value = fixture(); value.publisher.writable = missing !== 'drain';
            const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
            const timers: Array<{callback: () => void; delay: number}> = []; let cleared = 0;
            let pending: Promise<void>;
            try {
                globalThis.setTimeout = ((callback: () => void, delay: number) => {
                    timers.push({callback, delay}); return 123;
                }) as any;
                globalThis.clearTimeout = (() => {cleared++;}) as any;
                pending = start(value); pending.catch(() => {});
                expect(timers).toHaveLength(1); expect(timers[0].delay).toBe(30_000);
                if (missing === 'drain') value.publisher.calls[0].confirm(null);
                timers[0].callback();
            } finally {globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;}
            await expect(pending!).rejects.toThrow('timed out');
            expect(cleared).toBe(1); expect(value.publisher.calls).toHaveLength(1); clean(value.publisher);
            value.publisher.calls[0].confirm(null); value.publisher.emit('drain');
            expect(value.publisher.calls).toHaveLength(1);
        });
    }
});

describe('opaque action confirmation evidence', () => {
    it('retains the exact sent bytes and canonical headers when caller objects mutate during confirm', async () => {
        const value = fixture(), payload = Buffer.from('original-action'), headers = {block_num: 33, fragment: {id: 'original'}};
        const options = {headers, persistent: false, mandatory: false, messageId: 'caller-message'};
        const pending = publishAdmittedActionWithEvidence(value.owner, 'owned:index_actions:1', payload, options);
        const call = value.publisher.calls[0];
        payload.fill(0); headers.block_num = 99; headers.fragment.id = 'changed';
        options.headers = {block_num: 100, fragment: {id: 'replacement'}}; options.messageId = 'changed-message';
        expect(call.payload.toString()).toBe('original-action');
        expect(call.options.headers).toEqual({block_num: 33, fragment: {id: 'original'}});
        expect(call.options.persistent).toBe(true); expect(call.options.mandatory).toBe(true);
        call.confirm(null); const ticket = await pending;
        expect(Object.isFrozen(ticket)).toBe(true); expect(Object.keys(ticket)).toHaveLength(0);
        const [retained] = readConfirmedActionPublications(value.owner, [ticket]);
        expect(retained.payload.equals(call.payload)).toBe(true); expect(retained.headers).toEqual(call.options.headers);
        retained.payload.fill(0); retained.headers.fragment.id = 'detached-read';
        expect(readConfirmedActionPublications(value.owner, [ticket])[0].payload.toString()).toBe('original-action');
        expect(readConfirmedActionPublications(value.owner, [ticket])[0].headers.fragment.id).toBe('original'); clean(value.publisher);
    });
    it('refuses replacement owner predicates while confirm is held even if the replacement returns true', async () => {
        const value = fixture(), pending = publishAdmittedActionWithEvidence(value.owner, 'owned:index_actions:1', Buffer.from('action'), {headers: {block_num: 33}});
        value.owner.current = () => true; value.publisher.calls[0].confirm(null);
        await expect(pending).rejects.toThrow('owner changed'); clean(value.publisher);
    });
    it('refuses forged, serialized, wrong-owner, stale and sparse tickets before reading payload data', async () => {
        const value = fixture(), pending = publishAdmittedActionWithEvidence(value.owner, 'owned:index_actions:1', Buffer.from('action'), {headers: {block_num: 33}});
        value.publisher.calls[0].confirm(null); const ticket = await pending;
        for (const forged of [{}, structuredClone(ticket), JSON.parse(JSON.stringify(ticket))])
            expect(() => readConfirmedActionPublications(value.owner, [forged as ConfirmedActionPublication])).toThrow('Unissued');
        expect(() => readConfirmedActionPublications({...value.owner}, [ticket])).toThrow('wrong-owner');
        expect(() => readConfirmedActionPublications(value.owner, new Array(1))).toThrow('Unissued');
        let accessed = false; const accessor: ConfirmedActionPublication[] = [];
        Object.defineProperty(accessor, 0, {get() {accessed = true; return ticket;}});
        expect(() => readConfirmedActionPublications(value.owner, accessor)).toThrow('Unissued'); expect(accessed).toBe(false);
        value.replaceConsumer(); expect(() => readConfirmedActionPublications(value.owner, [ticket])).toThrow('stale'); clean(value.publisher);
    });
    it('bounds count, header bytes and SUM payload bytes before sending or retaining a vector', async () => {
        expect(() => assertActionPublicationBatchBudget(new Array(actionPublicationEvidenceBounds.maximumPublications + 1))).toThrow('vector');
        expect(() => assertActionPublicationBatchBudget([{payload: Buffer.from('x'), headers: {large: 'x'.repeat(65536)}}])).toThrow();
        const shared = Buffer.alloc(64 * 1024 * 1024);
        expect(() => assertActionPublicationBatchBudget([{payload: shared, headers: {}}, {payload: shared, headers: {}}])).toThrow('aggregate');
        const value = fixture();
        await expect(publishAdmittedActionWithEvidence(value.owner, 'owned:index_actions:1', Buffer.from('x'), {headers: {large: 'x'.repeat(65536)}})).rejects.toThrow();
        expect(value.publisher.calls).toHaveLength(0); clean(value.publisher);
    });
});
