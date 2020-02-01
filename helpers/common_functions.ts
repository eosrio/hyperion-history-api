import {ApiResponse, Client} from "@elastic/elasticsearch";

function getLastResult(results: ApiResponse) {
    if (results.body.hits?.hits?.length > 0) {
        return parseInt(results.body.hits.hits[0].sort[0], 10);
    } else {
        return 1;
    }
}

export async function getLastIndexedBlockByDelta(es_client: Client, chain: string) {
    const results: ApiResponse = await es_client.search({
        index: chain + '-delta-*',
        size: 1,
        body: {
            query: {bool: {filter: {match_all: {}}}},
            sort: [{block_num: {order: "desc"}}],
            size: 1
        }
    });
    return getLastResult(results);
}

export async function getLastIndexedBlock(es_client: Client, chain: string) {
    const results: ApiResponse = await es_client.search({
        index: chain + '-block-*',
        size: 1,
        body: {
            query: {bool: {filter: {match_all: {}}}},
            sort: [{block_num: {order: "desc"}}],
            size: 1
        }
    });
    return getLastResult(results);
}

export async function getLastIndexedABI(es_client: Client, chain: string) {
    const results: ApiResponse = await es_client.search({
        index: chain + '-abi-*',
        size: 1,
        body: {
            query: {
                match_all: {}
            },
            sort: [{block: {order: "desc"}}],
            size: 1
        }
    });
    return getLastResult(results);
}

export async function getLastIndexedBlockByDeltaFromRange(es_client: Client, chain: string, first: number, last: number) {
    const results: ApiResponse = await es_client.search({
        index: chain + '-delta-*',
        size: 1,
        body: {
            query: {
                range: {
                    block_num: {
                        "gte": first,
                        "lt": last,
                        "boost": 2
                    }
                }
            },
            sort: [{block_num: {order: "desc"}}],
            size: 1
        }
    });
    return getLastResult(results);
}

export async function getLastIndexedBlockFromRange(es_client: Client, chain: string, first: number, last: number) {
    const results = await es_client.search({
        index: chain + '-block-*',
        size: 1,
        body: {
            query: {
                range: {
                    block_num: {
                        "gte": first,
                        "lt": last,
                        "boost": 2
                    }
                }
            },
            sort: [{block_num: {order: "desc"}}],
            size: 1
        }
    });
    return getLastResult(results);
}

export function messageAllWorkers(cl, payload) {
    for (const c in cl.workers) {
        if (cl.workers.hasOwnProperty(c)) {
            const _w = cl.workers[c];
            _w.send(payload);
        }
    }
}
