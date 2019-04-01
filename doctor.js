const {elasticsearchConnect} = require("./connections/elasticsearch");

let client;
let total_missing = 0;
let last_block = 0;
let activeScrollID;
const starting_block = 1;
const stop_on_block = 0;

async function countMissingBlocks() {
    const results = await client.search({
        index: process.env.CHAIN + "-block*",
        size: 1,
        track_total_hits: true,
        body: {
            query: {match_all: {}},
            sort: [{block_num: {order: "desc"}}]
        }
    });
    const block_count = results['hits'].total.value;
    const latest_block = results['hits']['hits'][0]['_source']['block_num'];
    console.log('Indexed block count = ' + block_count);
    console.log('Last Indexed block = ' + latest_block);
    console.log('Missing blocks = ' + (latest_block - block_count));
    return latest_block - block_count;
}

async function createScroller(missingArray) {
    const range_filter = {
        "block_num": {
            "gte": starting_block
        }
    };
    if (stop_on_block !== 0) {
        range_filter.block_num['lte'] = stop_on_block;
    }
    const response = await client.search({
        index: process.env.CHAIN + "-block*",
        scroll: '30s',
        _source: ['block_num'],
        size: 1000,
        body: {
            query: {bool: {must: [{range: range_filter}]}},
            sort: [{block_num: {order: "asc"}}]
        }
    });
    const scrollId = response['_scroll_id'];
    await checkBlocks(response, missingArray);
    return scrollId;
}

async function checkBlocks(response, missingArray) {
    for (const block of response.hits.hits) {
        if (block._source.block_num !== last_block + 1) {
            const range_start = last_block + 1;
            const range_end = block._source.block_num - 1;
            const range_count = range_end - range_start + 1;
            console.log(`Missing ${range_count} blocks on range [${last_block + 1},${block._source.block_num - 1}]`);
            missingArray.push({
                start: range_start,
                end: range_end + 1
            });
        }
        last_block = block._source.block_num;
    }
}

async function runScroller(scroll_id, missingArray) {
    const next_resp = await client.scroll({
        scrollId: scroll_id,
        scroll: '30s'
    });
    if (next_resp['hits']['hits'].length > 0) {
        await checkBlocks(next_resp, missingArray);
        await runScroller(scroll_id, missingArray);
    }
}

function startMonitoringLoop() {
    setInterval(() => {
        console.log('Scanner at block: ' + last_block);
    }, 5000);
}

const main = async (missingArray) => {
    const start_time = Date.now();
    last_block = starting_block - 1;
    client = elasticsearchConnect();
    console.log('Hyperion Doctor initialized.');
    total_missing = await countMissingBlocks();
    activeScrollID = await createScroller(missingArray);
    // startMonitoringLoop();
    await runScroller(activeScrollID, missingArray);
    console.log(`${stop_on_block - starting_block} blocks scanned in ${(Date.now() - start_time) / 1000} seconds!`);
    return true;
};

module.exports = {
    run: main
};
