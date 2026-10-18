import { describe, expect, it } from 'bun:test';
import { runPausedSync } from '../../src/cli/sync-modules/sync-with-pause.js';
import { cargo } from 'async';
import { pauseIndexerQueue } from '../../src/indexer/helpers/indexer-pause.js';
import { IndexerPauseCoordinator } from '../../src/indexer/helpers/indexer-pause-coordinator.js';
import { EventEmitter } from 'node:events';
import { IndexerController } from '../../src/cli/controller-client/controller.client.js';
import { indexMongoBatch } from '../../src/indexer/helpers/mongo-batch.js';

class ControllerSocket extends EventEmitter {
    readyState = 1;
    constructor(private receive: (request: any, socket: ControllerSocket) => void) { super(); }
    send(raw: string, callback: (error?: Error) => void) {
        callback();
        this.receive(JSON.parse(raw), this);
    }
    respond(message: object) { this.emit('message', Buffer.from(JSON.stringify(message))); }
    close() { this.readyState = 3; }
}

function controllerWithSocket(receive: (request: any, socket: ControllerSocket) => void) {
    const controller = new IndexerController('test');
    const socket = new ControllerSocket(receive);
    controller.ws = socket as any;
    return { controller, socket };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(res => { resolve = res; });
    return { promise, resolve };
}

describe('Indexer consumer pause barrier', () => {
    it('waits for running cargo work even when the pending queue is empty', async () => {
        const started = deferred();
        const released = deferred();
        const queue = cargo((_payload, done) => {
            started.resolve();
            void released.promise.then(() => done());
        }, 10);
        queue.push({});
        await started.promise;
        let cancelled = false;
        let paused = false;
        const pause = pauseIndexerQueue({ async cancel() { cancelled = true; } }, 'consumer', queue)
            .then(() => { paused = true; });
        await Promise.resolve();
        expect(cancelled).toBe(true);
        expect(queue.length()).toBe(0);
        expect(queue.running()).toBe(1);
        expect(paused).toBe(false);
        released.resolve();
        await pause;
        expect(paused).toBe(true);
        expect(queue.idle()).toBe(true);
    });

    it('propagates cancellation failure instead of reporting the consumer paused', async () => {
        await expect(pauseIndexerQueue({ async cancel() { throw new Error('Channel lost'); } }, 'consumer', {
            idle: () => true,
            drain: async () => {}
        })).rejects.toThrow('Channel lost');
    });
});

describe('Paused synchronization', () => {
    it('never starts synchronization when pausing fails', async () => {
        const failure = new Error('Pause timed out');
        let synchronized = false;
        let resumed = false;
        let closed = false;
        const controller = {
            async pause() { throw failure; },
            async resume() { resumed = true; },
            close() { closed = true; }
        };

        await expect(runPausedSync(controller, 'dynamic-table', {
            async run() { synchronized = true; }
        })).rejects.toThrow('Synchronization aborted');
        expect(synchronized).toBe(false);
        expect(resumed).toBe(false);
        expect(closed).toBe(true);
    });

    it('propagates synchronization failure, resumes the paused workers, and closes control', async () => {
        const events: string[] = [];
        const failure = new Error('Snapshot write failed');
        await expect(runPausedSync({
            async pause() { events.push('paused'); return 'pause-id'; },
            async resume() { events.push('resumed'); },
            close() { events.push('closed'); }
        }, 'dynamic-table', {
            async run() { events.push('sync'); throw failure; }
        })).rejects.toBe(failure);
        expect(events).toEqual(['paused', 'sync', 'resumed', 'closed']);
    });

    it('does not report completion when synchronization succeeded but workers could not resume', async () => {
        let closed = false;
        await expect(runPausedSync({
            async pause() { return 'pause-id'; },
            async resume() { throw new Error('Controller disconnected'); },
            close() { closed = true; }
        }, 'dynamic-table', { async run() {} })).rejects.toThrow('could not be resumed');
        expect(closed).toBe(true);
    });
});

describe('Indexer pause coordination', () => {
    it('reports pause completion only after every targeted worker has drained', () => {
        const coordinator = new IndexerPauseCoordinator();
        const responses: any[] = [];
        const targets = [1, 2].map(id => ({ id, send(_message: any, callback: any) { callback(); } }));
        coordinator.pause('pause-1', 'dynamic-table', targets, response => responses.push(response));
        coordinator.onWorkerResponse(1, { event: 'indexer_paused', mId: 'pause-1' });
        coordinator.onWorkerResponse(1, { event: 'indexer_paused', mId: 'pause-1' });
        coordinator.onWorkerResponse(99, { event: 'indexer_paused', mId: 'pause-1' });
        expect(responses).toEqual([]);
        coordinator.onWorkerResponse(2, { event: 'indexer_paused', mId: 'other-pause' });
        expect(responses).toEqual([]);
        coordinator.onWorkerResponse(2, { event: 'indexer_paused', mId: 'pause-1' });
        expect(responses).toEqual([{ event: 'indexer_paused', mId: 'pause-1', complete: true, workerIds: [1, 2] }]);
        coordinator.onWorkerResponse(2, { event: 'indexer_paused', mId: 'pause-1' });
        expect(responses).toHaveLength(1);
    });

    it('refuses a competing pause for the same worker type', () => {
        const coordinator = new IndexerPauseCoordinator();
        const responses: any[] = [];
        const worker = { id: 1, send() {} };
        coordinator.pause('first', 'dynamic-table', [worker], response => responses.push(response));
        coordinator.pause('second', 'dynamic-table', [worker], response => responses.push(response));
        expect(responses[0]).toMatchObject({ event: 'indexer_pause_failed', mId: 'second' });
        coordinator.onWorkerResponse(1, { event: 'indexer_paused', mId: 'first' });
        expect(responses[1]).toMatchObject({ event: 'indexer_paused', mId: 'first' });
    });
});

describe('Controller pause protocol', () => {
    it('rejects a legacy partial-worker response instead of treating it as a safe pause', async () => {
        const { controller } = controllerWithSocket((request, socket) => {
            socket.respond({ event: 'indexer_paused', mId: request.mId });
        });
        await expect(controller.pause('dynamic-table')).rejects.toThrow('all-worker');
        controller.close();
    });

    it('ignores responses belonging to a different pause request', async () => {
        const { controller, socket } = controllerWithSocket((request, transport) => {
            transport.respond({ event: 'indexer_paused', mId: 'old-request', complete: true, workerIds: [1] });
            transport.respond({ event: 'indexer_paused', mId: request.mId, complete: true, workerIds: [1, 2] });
        });
        expect(await controller.pause('dynamic-table')).not.toBe('old-request');
        expect(socket.listenerCount('message')).toBe(0);
        expect(socket.listenerCount('close')).toBe(0);
        expect(socket.listenerCount('error')).toBe(0);
        controller.close();
    });
});

describe('Online state sync control boundary', () => {
    it('waits for every worker, including a retained Mongo retry, before synchronizing', async () => {
        const coordinator = new IndexerPauseCoordinator();
        const retry = deferred();
        const failed = deferred();
        const workerWasAskedToPause = deferred();
        let attempts = 0;
        let block = 99;
        let synchronized = false;
        const queue = cargo((payload: any[], done) => {
            void indexMongoBatch(payload, async () => {
                if (++attempts === 1) throw new Error('MongoDB write rejected');
                block = 100;
                return 1;
            }, { ack() {}, async close() {} }, () => true, () => failed.resolve(), () => retry.promise)
                .then(() => done());
        }, 10);
        queue.push({ fields: { deliveryTag: 1 } });
        await failed.promise;

        const { controller } = controllerWithSocket((request, socket) => {
            if (request.event === 'resume_indexer') {
                socket.respond({ event: 'indexer_resumed' });
                return;
            }
            coordinator.pause(request.mId, request.type, [
                { id: 1, send(message, accepted) {
                    accepted();
                    coordinator.onWorkerResponse(1, { event: 'indexer_paused', mId: message.mId });
                } },
                { id: 2, send(message, accepted) {
                    accepted();
                    void pauseIndexerQueue({ async cancel() {} }, 'retry-worker', queue).then(() => {
                        coordinator.onWorkerResponse(2, { event: 'indexer_paused', mId: message.mId });
                    });
                    workerWasAskedToPause.resolve();
                } }
            ], response => socket.respond(response));
        });
        const operation = runPausedSync(controller, 'dynamic-table', { async run() {
            expect(block).toBe(100);
            expect(queue.idle()).toBe(true);
            block = 200;
            synchronized = true;
        } });

        await workerWasAskedToPause.promise;
        expect(queue.length()).toBe(0);
        expect(queue.running()).toBe(1);
        expect(synchronized).toBe(false);
        retry.resolve();
        await operation;
        expect(synchronized).toBe(true);
        expect(block).toBe(200);
        expect(attempts).toBe(2);
    });

    it.each(['no workers', 'send throws', 'send fails', 'worker exits', 'worker rejects'])('never synchronizes when %s', async mode => {
        const coordinator = new IndexerPauseCoordinator();
        const lifecycle = new EventEmitter();
        let synchronized = false;
        const { controller, socket } = controllerWithSocket((request, transport) => {
            const workers = mode === 'no workers' ? [] : [{
                id: 1,
                send(message: any, accepted: any) {
                    if (mode === 'send throws') throw new Error('Cannot send');
                    if (mode === 'send fails') { accepted(new Error('IPC closed')); return; }
                    accepted();
                    if (mode === 'worker exits') lifecycle.emit('exit');
                    if (mode === 'worker rejects') {
                        coordinator.onWorkerResponse(1, { event: 'indexer_pause_failed', mId: message.mId, error: 'Cancel failed' });
                    }
                },
                onFailure(listener: () => void) {
                    lifecycle.once('exit', listener);
                    return () => { lifecycle.off('exit', listener); };
                }
            }];
            coordinator.pause(request.mId, request.type, workers, response => transport.respond(response));
        });

        await expect(runPausedSync(controller, 'dynamic-table', { async run() { synchronized = true; } }))
            .rejects.toThrow('Synchronization aborted');
        expect(synchronized).toBe(false);
        expect(socket.readyState).toBe(3);
        expect(socket.listenerCount('message')).toBe(0);
        expect(lifecycle.listenerCount('exit')).toBe(0);
    });

    it('fails closed on a partial pause timeout and ignores late replies after cleaning up', async () => {
        const coordinator = new IndexerPauseCoordinator(5);
        const lifecycle = new EventEmitter();
        const responses: any[] = [];
        let requestId = '';
        let synchronized = false;
        let resumed = false;
        const { controller, socket } = controllerWithSocket((request, transport) => {
            if (request.event === 'resume_indexer') { resumed = true; return; }
            requestId = request.mId;
            const workers = [1, 2].map(id => ({
                id,
                send(message: any, accepted: any) {
                    accepted();
                    if (id === 1) coordinator.onWorkerResponse(id, { event: 'indexer_paused', mId: message.mId });
                },
                onFailure(listener: () => void) {
                    lifecycle.on('exit', listener);
                    return () => { lifecycle.off('exit', listener); };
                }
            }));
            coordinator.pause(request.mId, request.type, workers, response => {
                responses.push(response);
                transport.respond(response);
            });
        });

        await expect(runPausedSync(controller, 'dynamic-table', { async run() { synchronized = true; } }))
            .rejects.toThrow('Some workers may remain paused');
        coordinator.onWorkerResponse(2, { event: 'indexer_paused', mId: requestId });
        expect(responses).toHaveLength(1);
        expect(responses[0]).toMatchObject({ event: 'indexer_pause_failed', mId: requestId });
        expect(synchronized).toBe(false);
        expect(resumed).toBe(false);
        expect(socket.readyState).toBe(3);
        expect(socket.listenerCount('message')).toBe(0);
        expect(lifecycle.listenerCount('exit')).toBe(0);
    });

    it('does not infer offline safety when the controller never responds', async () => {
        let synchronized = false;
        const { controller, socket } = controllerWithSocket(() => {});
        await expect(runPausedSync(controller, 'dynamic-table', { async run() { synchronized = true; } }))
            .rejects.toThrow('Synchronization aborted');
        expect(synchronized).toBe(false);
        expect(socket.readyState).toBe(3);
        expect(socket.listenerCount('message')).toBe(0);
        expect(socket.listenerCount('close')).toBe(0);
        expect(socket.listenerCount('error')).toBe(0);
    }, 15000);
});
