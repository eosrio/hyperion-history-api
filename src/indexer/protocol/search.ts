/** A partial ABI search cannot establish which deployment applies to a record. */
export function assertCompleteProtocolSearch(response: any): void {
    const shards = response?._shards;
    if (response?.timed_out !== false || response?.terminated_early === true || !shards
        || !Number.isInteger(shards.total) || shards.total < 1 || shards.failed !== 0
        || shards.successful !== shards.total || !Array.isArray(response?.hits?.hits)
        || response.hits.hits.some(hit => !hit?._source || typeof hit._source !== 'object')) {
        throw new Error('Protocol ABI search is incomplete');
    }
}
