import type {Channel, ConfirmChannel, Options} from 'amqplib';
import {randomUUID} from 'node:crypto';

export interface ActionPublicationOwner {consumer: Channel; publisher: ConfirmChannel; current: () => boolean}
/** One in-flight publication per caller. False is accepted buffering; wait for drain and confirm, never resend it. */
export async function publishAdmittedAction(owner: ActionPublicationOwner, queue: string, payload: Buffer,
                                            options: Options.Publish, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!owner.current()) throw new Error('Action publication lost its original channels');
    const publisher = owner.publisher, messageId = randomUUID();
    await new Promise<void>((resolve, reject) => {
        let confirmed = false, drained = false, sent = false, settled = false;
        const finish = (error?: unknown) => {
            if (settled) return;
            if (!error && (!sent || !confirmed || !drained)) return;
            settled = true; clearTimeout(timer);
            publisher.off('drain', onDrain); publisher.off('close', onClose); publisher.off('error', onError);
            publisher.off('return', onReturn); signal?.removeEventListener('abort', onAbort);
            if (error) reject(error); else if (!owner.current()) reject(new Error('Action publication channels changed before confirmation'));
            else resolve();
        };
        const onDrain = () => {drained = true; finish();};
        const onClose = () => finish(new Error('Action publisher closed before confirmation'));
        const onError = (error: unknown) => finish(error);
        const onReturn = (message: any) => {if (message.properties?.messageId === messageId) finish(new Error('Admitted action was unroutable'));};
        const onAbort = () => finish(signal?.reason ?? new Error('Action publication cancelled'));
        const timer = setTimeout(() => finish(new Error('Action publication confirmation/drain timed out')), 30_000);
        publisher.on('drain', onDrain); publisher.on('close', onClose); publisher.on('error', onError); publisher.on('return', onReturn);
        signal?.addEventListener('abort', onAbort, {once: true});
        try {
            // Register ownership before send: a controlled or failed channel can settle synchronously.
            const writable = publisher.sendToQueue(queue, payload, {...options, persistent: true, mandatory: true, messageId}, error => {
                if (error) finish(error); else {confirmed = true; finish();}
            });
            drained ||= writable; sent = true; finish();
        } catch (error) {finish(error);}
    });
    signal?.throwIfAborted();
    if (!owner.current()) throw new Error('Action publication lost its original channels after confirmation');
}
