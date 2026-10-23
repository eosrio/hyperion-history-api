import {EventEmitter} from 'node:events';

/** Explicit component-only transport: no parent-accepted lifecycle end or broker-resource qualification. */
export function controlledAttemptLifecycle(worker, role) {
    worker.installControlledAttemptLifecycle(role);
    // Earlier fixtures expose immediate controlled send functions. Preserve the exact channel object,
    // adding real event registration so scoped resource listeners can observe explicitly emitted close/drain.
    for (const channel of [worker.ch, worker.cch]) if (channel && typeof channel.on !== 'function') {
        const events = new EventEmitter();
        for (const name of ['on', 'once', 'off', 'removeListener', 'emit']) channel[name] = events[name].bind(events);
    }
}
