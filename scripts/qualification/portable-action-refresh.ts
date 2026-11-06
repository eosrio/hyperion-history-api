/** Qualification readiness only; a green observation is never a refresh or durable-write receipt. */
import assert from 'node:assert/strict';
import type {Client} from '@elastic/elasticsearch';

export async function refreshPortableActionCopies(options: {
    client: Pick<Client, 'cluster' | 'indices'>;
    index: string;
    timeout: (maximum: number) => number;
    wait: (work: () => Promise<void>) => Promise<unknown>;
    observe: <T>(kind: 'action-replica-health' | 'action-refresh', request: unknown, work: () => Promise<T>) => Promise<T>;
}) {
    await options.wait(async () => {
        const milliseconds = options.timeout(5000);
        const request = {index: options.index, wait_for_status: 'green' as const, timeout: `${milliseconds}ms`};
        const health = await options.observe('action-replica-health', request,
            () => options.client.cluster.health(request, {requestTimeout: options.timeout(5000)}));
        options.timeout(5000);
        assert.equal(health.timed_out, false); assert.equal(health.status, 'green');
        assert.equal(health.number_of_data_nodes, 2);
    });
    const request = {index: options.index};
    const refresh = await options.observe('action-refresh', request,
        () => options.client.indices.refresh(request, {requestTimeout: options.timeout(10000)}));
    options.timeout(10000);
    // The caller must still require every copy in this actual response to succeed. New indices
    // or unavailable copies between health and refresh must fail that assertion, without retry.
    return refresh;
}
