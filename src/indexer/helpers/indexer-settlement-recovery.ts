import type {Channel} from 'amqplib';

/** Request a supervised worker replacement after a delivery channel cannot settle work. */
export function createIndexerSettlementRecovery(
    currentChannel: () => Channel | undefined,
    terminate: (exitCode: number) => void = exitCode => { process.exit(exitCode); }
): (failedChannel: Channel) => void {
    return failedChannel => {
        // Channel closure already cleared readiness. Its identity still tells us
        // whether the failed consumer needs replacement or reconnection won the race.
        if (currentChannel() === failedChannel) terminate(1);
    };
}
