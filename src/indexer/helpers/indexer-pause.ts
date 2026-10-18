/** Cancel delivery first, then wait for pending and running cargo work to finish. */
export async function pauseIndexerQueue(
    channel: { cancel(consumerTag: string): Promise<unknown> },
    consumerTag: string,
    queue: { idle(): boolean; drain(): Promise<void> }
): Promise<void> {
    await channel.cancel(consumerTag);
    if (!queue.idle()) await queue.drain();
}
