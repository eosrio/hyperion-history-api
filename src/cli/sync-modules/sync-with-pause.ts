interface SyncController {
    pause(type: string): Promise<string>;
    resume(type: string, mId: string): Promise<void>;
    close(): void;
}

/** The same pause/run/resume boundary is used by every online state synchronizer. */
export async function runPausedSync(
    controller: SyncController,
    type: string,
    synchronizer: { run(contract?: string, table?: string): Promise<void> },
    contract?: string,
    table?: string
): Promise<void> {
    let pauseId: string | undefined;
    let synchronized = false;
    try {
        try {
            pauseId = await controller.pause(type);
        } catch (reason) {
            throw new Error(`Synchronization aborted: unable to pause every ${type} worker. ` +
                'Some workers may remain paused; check the controller and resume or restart them before retrying.',
                { cause: reason });
        }
        await synchronizer.run(contract, table);
        synchronized = true;
    } finally {
        try {
            if (pauseId) {
                try {
                    await controller.resume(type, pauseId);
                } catch (reason) {
                    if (synchronized) {
                        throw new Error(`Synchronization finished, but ${type} workers could not be resumed; ` +
                            'resume or restart them manually.', { cause: reason });
                    }
                    console.warn(`Failed to resume ${type} workers after synchronization failed; resume or restart them manually.`, reason);
                }
            }
        } finally {
            controller.close();
        }
    }
}
