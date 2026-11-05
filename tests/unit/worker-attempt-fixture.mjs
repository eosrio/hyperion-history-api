import {EventEmitter} from 'node:events';

/** Legacy domain fixtures have controlled queue sinks; direct dispatch also needs an explicit confirm transport.
 * This is not broker durability or resource qualification. Dedicated handoff tests hold real callbacks instead. */
export function controlledDurableOutputTransport(worker, role) {
    if (worker.cch) return;
    const publisher = new EventEmitter();
    publisher.sendToQueue = (queue, content, options, confirm) => {
        try {
            worker.ch.sendToQueue(queue, content, options);
            queueMicrotask(() => confirm(null));
        } catch (error) {queueMicrotask(() => confirm(error));}
        return true;
    };
    worker.cch = publisher; worker.cch_ready = true;
    if (role === 'ds_pool_worker') worker.preIndexingQueue = worker.createDurableWorkerOutputQueue();
}

/** Explicit component-only transport: no parent-accepted lifecycle end or broker-resource qualification. */
export function controlledAttemptLifecycle(worker, role) {
    worker.installControlledAttemptLifecycle(role);
    // Earlier fixtures expose immediate controlled send functions. Preserve the exact channel object,
    // adding real event registration so scoped resource listeners can observe explicitly emitted close/drain.
    for (const channel of [worker.ch, worker.cch]) if (channel
        && ['on', 'once', 'off', 'removeListener', 'emit'].some(name => typeof channel[name] !== 'function')) {
        const events = new EventEmitter();
        for (const name of ['on', 'once', 'off', 'removeListener', 'emit']) channel[name] = events[name].bind(events);
    }
}
