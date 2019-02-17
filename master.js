const elasticsearch = require('elasticsearch');
const {JsonRpc} = require('eosjs');
const fetch = require('node-fetch');
const prettyjson = require('prettyjson');
const cluster = require('cluster');

async function getLastIndexedBlock(es_client) {
    const results = await es_client.search({
        index: process.env.CHAIN + '-block',
        size: 1,
        body: {
            query: {bool: {filter: {match_all: {}}}},
            sort: [{block_num: {order: "desc"}}],
            size: 1
        }
    });
    if (results['hits']['hits'].length > 0) {
        return parseInt(results['hits']['hits'][0]['sort'][0], 10);
    } else {
        return 0;
    }
}

async function getFirstIndexedBlockFromRange(es_client, first, last) {
    const results = await es_client.search({
        index: process.env.CHAIN + '-block',
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
            sort: [{block_num: {order: "asc"}}],
            size: 1
        }
    });
    if (results['hits']['hits'].length > 0) {
        return parseInt(results['hits']['hits'][0]['sort'][0], 10);
    } else {
        return 0;
    }
}

async function getLastIndexedBlockFromRange(es_client, first, last) {
    const results = await es_client.search({
        index: process.env.CHAIN + '-block',
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
    if (results['hits']['hits'].length > 0) {
        return parseInt(results['hits']['hits'][0]['sort'][0], 10);
    } else {
        return 0;
    }
}

async function main() {
    // Preview mode - prints only the proposed worker map
    const preview = process.env.PREVIEW === 'true';

    const client = new elasticsearch.Client({
        host: process.env.ES_HOST
    });

    const n_consumers = process.env.READERS;
    const n_deserializers = process.env.DESERIALIZERS;
    const n_ingestors_per_queue = process.env.ES_INDEXERS_PER_QUEUE;
    const action_indexing_ratio = process.env.ES_ACT_QUEUES;

    const eos_endpoint = process.env.NODEOS_HTTP;
    const rpc = new JsonRpc(eos_endpoint, {fetch});

    const queue_prefix = process.env.CHAIN;
    const queue = queue_prefix + ':blocks';
    const index_queue_prefix = queue_prefix + ':index';
    const index_queues = [
        {type: 'action', name: index_queue_prefix + "_actions"},
        {type: 'transaction', name: index_queue_prefix + "_transactions"},
        {type: 'block', name: index_queue_prefix + "_blocks"}
    ];

    const indicesList = ["action", "block", "transaction", "account"];
    const indexConfig = require('./mappings');

    if (process.env.FLUSH_INDICES === 'true') {
        console.log('Deleting all indices!');
        await client['indices'].delete({
            index: indicesList.map(i => `${queue_prefix}-${i}`)
        });
    }

    // Check for indexes
    for (const index of indicesList) {
        const status = await client['indices'].exists({
            index: `${queue_prefix}-${index}`
        });
        if (!status) {
            const creation_status = await client['indices'].create({
                index: `${queue_prefix}-${index}`,
                body: indexConfig[index]
            });
            if (!creation_status['acknowledged'] || !creation_status['shards_acknowledged']) {
                console.log('Failed to create index', `${queue_prefix}-${index}`);
                console.log(creation_status);
                process.exit(1);
            }
        }
    }

    const workerMap = [];
    let worker_index = 0;
    let pushedBlocks = 0;
    let consumedBlocks = 0;
    let indexedObjects = 0;
    let deserializedActions = 0;
    let lastProcessedBlockNum = 0;
    let total_read = 0;
    let total_blocks = 0;
    let total_indexed_blocks = 0;
    let total_actions = 0;
    let log_interval = 5000;

    // Monitoring
    setInterval(() => {
        const _workers = Object.keys(cluster.workers).length;
        const tScale = (log_interval / 1000);
        total_read += pushedBlocks;
        total_blocks += consumedBlocks;
        total_actions += deserializedActions;
        total_indexed_blocks += indexedObjects;
        const log_msg = [
            `Workers: ${_workers}`,
            `Read: ${pushedBlocks / tScale} blocks/s`,
            `Consume: ${consumedBlocks / tScale} blocks/s`,
            `Deserialize: ${deserializedActions / tScale} actions/s`,
            `Index: ${indexedObjects / tScale} docs/s`,
            `Blocks: ${((total_blocks / total_read) * 100).toFixed(3)}%`,
            // `Actions: ${total_actions}`
        ];
        console.log(log_msg.join(' | '));
        // reset counters
        pushedBlocks = 0;
        consumedBlocks = 0;
        deserializedActions = 0;
        indexedObjects = 0;

        if (_workers === 0) {
            console.log('FATAL ERROR - All Workers have stopped!');
            process.exit(1);
        }

    }, log_interval);

    const lastIndexedBlock = await getLastIndexedBlock(client);
    // Start from the last indexed block
    let starting_block = 1;
    console.log('Last indexed block:', lastIndexedBlock);

    // Fecth chain lib
    const chain_data = await rpc.get_info();
    let lib;
    let search = false;
    if (lastIndexedBlock > 0) {
        lib = lastIndexedBlock;
        search = true;
    } else {
        lib = chain_data['last_irreversible_block_num'];
    }

    if (process.env.START_ON) {
        starting_block = parseInt(process.env.START_ON, 10);
    }
    if (process.env.STOP_ON) {
        lib = parseInt(process.env.STOP_ON, 10);
    }
    const batchSize = Math.ceil((lib - starting_block) / n_consumers);
    console.log('Reader batch size:', batchSize, 'blocks');

    // starting_block = 950;
    // const batchSize = 2000;
    const missingRanges = [];
    if (search) {
        let searchPoint = 0;
        let window_size = 20000;
        let newRangeStart = 0;
        while (searchPoint < lib) {
            if (newRangeStart !== 0) {
                // Search for new ending point
                // Move one window ahead
                searchPoint += window_size;
                const candidate = await getFirstIndexedBlockFromRange(client, searchPoint, searchPoint + window_size);
                if (candidate > newRangeStart) {
                    missingRanges.push({
                        start: newRangeStart,
                        end: candidate
                    });
                    newRangeStart = 0;
                    searchPoint = candidate;
                }
            } else {
                // Normal search mode
                const partialLastBlock = await getLastIndexedBlockFromRange(client, searchPoint, searchPoint + window_size);
                if (partialLastBlock < searchPoint + window_size - 1) {
                    newRangeStart = partialLastBlock + 1;
                } else {
                    // Move search window
                    searchPoint += window_size;
                }
            }
        }
    }

    console.log(missingRanges);

    if (missingRanges.length > 0) {
        // Test missing ranges candidates
        for (const r of missingRanges) {
            const test = await getLastIndexedBlockFromRange(r.start, r.end);
            if (test === 0) {
                worker_index++;
                workerMap.push({
                    worker_id: worker_index,
                    worker_role: 'reader',
                    first_block: r.start,
                    last_block: r.end
                });
            } else {
                console.log('range', r, 'search failed', test);
            }
        }
    } else {
        // Setup Parallel reader workers
        if (lastIndexedBlock > starting_block) {
            starting_block = lastIndexedBlock;
        }
        if (lastIndexedBlock === 0 || starting_block >= lastIndexedBlock) {
            for (let i = 0; i < n_consumers; i++) {
                worker_index++;
                workerMap.push({
                    worker_id: worker_index,
                    worker_role: 'reader',
                    first_block: starting_block + (i * batchSize),
                    last_block: starting_block + (i * batchSize) + batchSize
                });
            }
        }
    }

    // Setup Serial reader worker
    if (process.env.LIVE_READER === 'true') {
        worker_index++;
        workerMap.push({
            worker_id: worker_index,
            worker_role: 'continuous_reader',
            worker_last_processed_block: lib
        });
    }

    // Setup Deserialization Workers
    for (let i = 0; i < n_deserializers; i++) {
        for (let j = 0; j < process.env.DS_MULT; j++) {
            worker_index++;
            workerMap.push({
                worker_queue: queue + ":" + (i + 1),
                worker_id: worker_index,
                worker_role: 'deserializer'
            });
        }
    }

    // Setup ES Ingestion Workers
    index_queues.forEach((q) => {
        let n = n_ingestors_per_queue;
        if (q.type === 'action') {
            n = n_ingestors_per_queue * action_indexing_ratio;
        }
        for (let i = 0; i < n; i++) {
            worker_index++;
            workerMap.push({
                worker_id: worker_index,
                worker_role: 'ingestor',
                type: q.type,
                queue: q.name + ":" + (i + 1)
            });
        }
    });

    // Quit App if on preview mode
    if (preview) {
        printWorkerMap(workerMap);
        process.exit(1);
    }

    // Launch all workers
    workerMap.forEach((conf) => {
        cluster.fork(conf);
    });

    // Worker event listener
    const workerHandler = (msg) => {
        switch (msg.event) {
            case 'add_index': {
                indexedObjects += msg.size;
                break;
            }
            case 'ds_action': {
                deserializedActions++;
                break;
            }
            case 'read_block': {
                pushedBlocks++;
                break;
            }
            case 'consumed_block': {
                consumedBlocks++;
                if (msg.block_num > lastProcessedBlockNum) {
                    lastProcessedBlockNum = msg.block_num;
                }
                break;
            }
        }
    };

    // Attach handlers
    for (const c in cluster.workers) {
        if (cluster.workers.hasOwnProperty(c)) {
            cluster.workers[c].on('message', workerHandler);
        }
    }

    // Catch dead workers
    cluster.on('exit', (worker, code) => {
        console.log(`Worker ${worker.id}, pid: ${worker.process.pid} finished with code ${code}`);
    });
}

function printWorkerMap(wmp) {
    console.log('--------------------------------------------------');
    console.log(prettyjson.render({
        'workers': wmp
    }, {
        numberColor: 'grey'
    }));
    console.log('--------------------------------------------------');
}

module.exports = {main};
