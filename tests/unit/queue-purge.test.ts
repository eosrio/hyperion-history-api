import {describe, expect, it} from 'bun:test';
import {ChainQueue, planQueuePurge, purgeChainQueues, QueuePurgeIO} from '../../src/indexer/helpers/queue-purge.js';

function harness(sampled: ChainQueue[], ready: Record<string, number> = {}) {
    const deleted: string[] = [];
    const logs: string[] = [];
    const counted: string[] = [];
    const io: QueuePurgeIO = {
        listQueues: async () => sampled,
        countReadyMessages: async name => {
            counted.push(name);
            return ready[name] ?? 0;
        },
        deleteQueue: async name => {
            deleted.push(name);
        },
        log: message => {
            logs.push(message);
        }
    };
    return {io, deleted, logs, counted};
}

const pendingQueues: ChainQueue[] = [
    {name: 'wax:blocks:1', messages: 12},
    {name: 'wax:index_actions:1', messages: 0},
    {name: 'waxtest:blocks:1', messages: 99}
];

describe('startup queue purge', () => {
    it('does nothing when the setting is off', async () => {
        const h = harness(pendingQueues);
        expect((await purgeChainQueues('wax', false, false, h.io)).action).toBe('skip');
        expect(h.counted).toEqual([]);
        expect(h.deleted).toEqual([]);
    });

    it('keeps queues that hold messages when the start resumes', async () => {
        const h = harness(pendingQueues);
        const plan = await purgeChainQueues('wax', true, false, h.io);
        expect(plan).toMatchObject({action: 'keep', pending: 12});
        expect(h.deleted).toEqual([]);
        expect(h.logs.some(line => line.includes('wax:blocks:1: 12 messages kept'))).toBe(true);
        expect(h.logs.some(line => line.includes('"force"'))).toBe(true);
    });

    it('only looks at the queues of its own chain', async () => {
        const h = harness([{name: 'wax:blocks:1', messages: 0}, {name: 'waxtest:blocks:1', messages: 99}]);
        const plan = await purgeChainQueues('wax', true, false, h.io);
        expect(plan).toMatchObject({action: 'delete', reason: 'empty'});
        expect(h.counted).toEqual(['wax:blocks:1']);
        expect(h.deleted).toEqual(['wax:blocks:1']);
    });

    it('trusts the live count when the sampled total is behind', async () => {
        const h = harness([{name: 'wax:ds_pool:1', messages: 0}], {'wax:ds_pool:1': 7});
        expect(await purgeChainQueues('wax', true, false, h.io)).toMatchObject({action: 'keep', pending: 7});
        expect(h.deleted).toEqual([]);
    });

    it('trusts the sampled total when messages are unacknowledged', async () => {
        const h = harness([{name: 'wax:ds_pool:1', messages: 5}], {'wax:ds_pool:1': 0});
        expect(await purgeChainQueues('wax', true, false, h.io)).toMatchObject({action: 'keep', pending: 5});
    });

    it('deletes queued work when the range is rewritten', async () => {
        const h = harness(pendingQueues);
        const plan = await purgeChainQueues('wax', true, true, h.io);
        expect(plan).toMatchObject({action: 'delete', reason: 'rewrite', pending: 12});
        expect(h.deleted).toEqual(['wax:blocks:1', 'wax:index_actions:1']);
    });

    it('deletes queued work when forced', async () => {
        const h = harness(pendingQueues);
        const plan = await purgeChainQueues('wax', 'force', false, h.io);
        expect(plan).toMatchObject({action: 'delete', reason: 'forced', pending: 12});
        expect(h.deleted).toEqual(['wax:blocks:1', 'wax:index_actions:1']);
    });

    it('plans from the setting, the rewrite flag and the pending total', () => {
        const empty = [{name: 'wax:blocks:1', messages: 0}];
        expect(planQueuePurge(false, true, pendingQueues).action).toBe('skip');
        expect(planQueuePurge(true, false, []).action).toBe('delete');
        expect(planQueuePurge(true, false, empty).action).toBe('delete');
        expect(planQueuePurge(true, false, pendingQueues).action).toBe('keep');
    });
});
