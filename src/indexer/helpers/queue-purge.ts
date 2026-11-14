/**
 * Startup queue purge policy.
 *
 * A restart without `rewrite` resumes at the first block missing from the block index. Messages
 * still waiting in the chain's queues can carry the actions and deltas of blocks below that point,
 * whose block documents are already written, so deleting them loses those documents for good:
 * nothing reads those blocks again. The purge therefore only deletes queues
 * when that cannot lose work, or when the operator asked for it explicitly.
 */

export type PurgeQueuesSetting = boolean | 'force';

export interface ChainQueue {
    name: string;
    /** Messages held by the queue. */
    messages: number;
}

export type QueuePurgeReason = 'forced' | 'rewrite' | 'empty';

export type QueuePurgePlan =
    | { action: 'skip' }
    | { action: 'delete'; reason: QueuePurgeReason; queues: ChainQueue[]; pending: number }
    | { action: 'keep'; queues: ChainQueue[]; pending: number };

export function planQueuePurge(setting: PurgeQueuesSetting, rewrite: boolean, queues: ChainQueue[]): QueuePurgePlan {
    if (setting !== true && setting !== 'force') return {action: 'skip'};
    const pending = queues.reduce((sum, queue) => sum + queue.messages, 0);
    if (setting === 'force') return {action: 'delete', reason: 'forced', queues, pending};
    // A rewrite reads its whole range again, so the queued work is reproduced.
    if (rewrite) return {action: 'delete', reason: 'rewrite', queues, pending};
    if (pending === 0) return {action: 'delete', reason: 'empty', queues, pending};
    return {action: 'keep', queues, pending};
}

export interface QueuePurgeIO {
    /**
     * Every queue in the vhost, with the management API's message total. That total includes
     * unacknowledged messages but is a periodic sample, so it can lag behind the broker.
     */
    listQueues(): Promise<ChainQueue[]>;
    /** Messages ready in one queue right now, read from the broker itself. */
    countReadyMessages(name: string): Promise<number>;
    deleteQueue(name: string): Promise<void>;
    log(message: string): void;
}

export async function purgeChainQueues(
    chain: string,
    setting: PurgeQueuesSetting,
    rewrite: boolean,
    io: QueuePurgeIO
): Promise<QueuePurgePlan> {
    if (setting !== true && setting !== 'force') return {action: 'skip'};
    const prefix = chain + ':';
    const queues: ChainQueue[] = [];
    for (const {name, messages} of await io.listQueues()) {
        if (!name.startsWith(prefix)) continue;
        // Neither source alone is enough: the sample can miss the newest messages and the live
        // count leaves out unacknowledged ones. The larger value never under-reports queued work.
        queues.push({name, messages: Math.max(messages, await io.countReadyMessages(name))});
    }
    const plan = planQueuePurge(setting, rewrite, queues);
    if (plan.action === 'delete') {
        io.log(`Purging all ${chain} queues (${plan.reason}): ${plan.queues.length} queues, ${plan.pending} messages`);
        for (const queue of plan.queues) {
            await io.deleteQueue(queue.name);
            io.log(`${queue.messages} messages deleted on queue ${queue.name}`);
        }
    } else if (plan.action === 'keep') {
        io.log(`[WARNING] purge_queues is on, but ${plan.pending} messages are waiting in ${chain} queues and rewrite is off.`);
        io.log('[WARNING] The queues were kept: they hold work for blocks this start does not read again, so deleting them would lose it.');
        for (const queue of plan.queues) {
            if (queue.messages > 0) io.log(`[WARNING]   ${queue.name}: ${queue.messages} messages kept`);
        }
        io.log('[WARNING] To discard them on purpose, set indexer.purge_queues to "force", or rewrite the range with start_on and rewrite.');
    }
    return plan;
}
