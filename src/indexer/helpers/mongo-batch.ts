import type { Channel, ConsumeMessage } from 'amqplib';
import type { MongoRouteFunction } from './mongo-routes.js';

/** Keep the serial cargo batch pending until its writes succeed or its channel is lost. */
export async function indexMongoBatch(
    payload: ConsumeMessage[],
    route: MongoRouteFunction,
    channel: Pick<Channel, 'ack' | 'close'>,
    isCurrentChannel: () => boolean,
    onError: (reason: unknown) => void,
    waitForRetry: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 1000))
): Promise<number> {
    while (isCurrentChannel()) {
        let indexed: number;
        try {
            indexed = await route(payload);
        } catch (reason) {
            if (!isCurrentChannel()) return 0;
            onError(reason);
            // Requeueing here can put an older, partially applied state batch behind
            // newer work. Retain the unacknowledged deliveries and retry in place.
            await waitForRetry();
            continue;
        }

        if (!isCurrentChannel()) return 0;
        try {
            // ackAll would also acknowledge prefetched work outside this batch.
            for (const message of payload) channel.ack(message);
            return indexed;
        } catch (reason) {
            onError(reason);
            // Some delivery tags might already be acknowledged. Closing returns the
            // remaining deliveries to the broker without retrying already-acked tags.
            try {
                await channel.close();
            } catch (closeReason) {
                onError(closeReason);
            }
            return 0;
        }
    }
    return 0;
}
