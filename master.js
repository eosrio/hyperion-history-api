const elasticsearch = require('elasticsearch');
const {JsonRpc} = require('eosjs');
const fetch = require('node-fetch');
const prettyjson = require('prettyjson');
const cluster = require('cluster');
const fs = require('fs');
const redis = require('redis');
const {promisify} = require('util');
let client;
let cachedInitABI = null;

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

async function elasticsearchConnect() {
    client = new elasticsearch.Client({
        host: process.env.ES_HOST
    });
}

function onSaveAbi(data, abiCacheMap, rClient) {
    const key = data['block'] + ":" + data['account'];
    // console.log(key);
    rClient.set(key, data['abi']);
    let versionMap;
    if (!abiCacheMap[data['account']]) {
        versionMap = [];
        versionMap.push(parseInt(data['block']));
    } else {
        versionMap = abiCacheMap[data['account']];
        versionMap.push(parseInt(data['block']));
        versionMap.sort(function (a, b) {
            return a - b;
        });
        versionMap = Array.from(new Set(versionMap));
    }
    abiCacheMap[data['account']] = versionMap;
}

async function main() {
    // Preview mode - prints only the proposed worker map
    const preview = process.env.PREVIEW === 'true';

    const rClient = redis.createClient();
    const getAsync = promisify(rClient.get).bind(rClient);
    await elasticsearchConnect();

    const n_consumers = process.env.READERS;
    const n_deserializers = process.env.DESERIALIZERS;
    const n_ingestors_per_queue = process.env.ES_INDEXERS_PER_QUEUE;
    const action_indexing_ratio = process.env.ES_ACT_QUEUES;

    const max_readers = process.env.READERS;
    const activeReaders = [];

    const eos_endpoint = process.env.NODEOS_HTTP;
    const rpc = new JsonRpc(eos_endpoint, {fetch});

    const queue_prefix = process.env.CHAIN;
    const queue = queue_prefix + ':blocks';
    const index_queues = require('./definitions/index-queues').index_queues;

    const indicesList = ["action", "block", "transaction", "account", "abi"];
    const indexConfig = require('./definitions/mappings');

    // if (process.env.FLUSH_INDICES === 'true') {
    //     console.log('Deleting all indices!');
    //     await client['indices'].delete({
    //         index: indicesList.map(i => `${queue_prefix}-${i}`)
    //     });
    // }

    // Check for indexes
    for (const index of indicesList) {
        const status = await client['indices'].existsAlias({
            name: `${queue_prefix}-${index}`
        });
        console.log(`${queue_prefix}-${index}: ${status}`);
        if (!status) {
            const template_status = await client['indices'].existsTemplate({
                name: `${queue_prefix}-${index}`
            });
            if (!template_status) {
                const creation_status = await client['indices'].putTemplate({
                    name: `${queue_prefix}-${index}`,
                    body: indexConfig[index]
                });
                if (!creation_status['acknowledged']) {
                    console.log('Failed to create template', `${queue_prefix}-${index}`);
                    console.log(creation_status);
                    process.exit(1);
                }
            } else {
                console.log(`${queue_prefix}-${index} template: ${template_status}`);
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
    let log_interval = 2000;
    let total_range = 0;
    let allowShutdown = false;
    let allowMoreReaders = true;
    let maxBatchSize = parseInt(process.env.BATCH_SIZE, 10);

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
            `${total_blocks}/${total_read}/${total_range}`,
            // `Actions: ${total_actions}`
        ];
        console.log(log_msg.join(' | '));

        allowShutdown = (indexedObjects === 0 && deserializedActions === 0 && consumedBlocks === 0);
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
    let lib = chain_data['last_irreversible_block_num'];

    if (lastIndexedBlock > 0) {
        starting_block = lastIndexedBlock;
    }

    if (process.env.START_ON !== "0") {
        starting_block = parseInt(process.env.START_ON, 10);
        console.log('START ON:' + starting_block);
    }
    if (process.env.STOP_ON !== "0") {
        lib = parseInt(process.env.STOP_ON, 10);
        console.log('STOP ON:' + lib);
    }

    total_range = lib - starting_block;

    // Create first batch of parallel readers
    let lastAssignedBlock = starting_block;

    if (process.env.LIVE_ONLY === 'false') {
        while (activeReaders.length < max_readers && lastAssignedBlock < lib) {
            worker_index++;
            const start = lastAssignedBlock;
            let end = lastAssignedBlock + maxBatchSize;
            if (end > lib) {
                end = lib;
            }
            lastAssignedBlock += maxBatchSize;
            const def = {
                worker_id: worker_index,
                worker_role: 'reader',
                first_block: start,
                last_block: end
            };
            activeReaders.push(def);
            workerMap.push(def);
            // console.log(`Launching new worker from ${start} to ${end}`);
        }
    }

    // Setup Serial reader worker
    if (process.env.LIVE_READER === 'true') {
        const _lib = chain_data['last_irreversible_block_num'];
        console.log(`Starting live reader at lib = ${_lib}`);
        worker_index++;
        workerMap.push({
            worker_id: worker_index,
            worker_role: 'continuous_reader',
            worker_last_processed_block: _lib,
            ws_router: ''
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
        if (q.type === 'abi') {
            n = 1;
        }
        for (let i = 0; i < n; i++) {
            let m = 1;
            if (q.type === 'action') {
                m = n_ingestors_per_queue * action_indexing_ratio;
            }
            for (let j = 0; j < m; j++) {
                worker_index++;
                workerMap.push({
                    worker_id: worker_index,
                    worker_role: 'ingestor',
                    type: q.type,
                    queue: q.name + ":" + (i + 1)
                });
            }
        }
    });

    // Setup ws router
    worker_index++;
    workerMap.push({
        worker_id: worker_index,
        worker_role: 'router'
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

    const dsErrorsLog = "deserialization_errors_" + starting_block + "_" + lib + ".txt";
    if (fs.existsSync(dsErrorsLog)) {
        fs.unlinkSync(dsErrorsLog);
    }
    const ds_errors = fs.createWriteStream(dsErrorsLog, {flags: 'a'});

    const cachedMap = await getAsync('abi_cache');
    let abiCacheMap;
    if (cachedMap) {
        abiCacheMap = JSON.parse(cachedMap);
        console.log(`Found ${Object.keys(abiCacheMap).length} entries in the local ABI cache`)
    } else {
        abiCacheMap = {};
    }

    setInterval(() => {
        rClient.set('abi_cache', JSON.stringify(abiCacheMap));
    }, 10000);

    // Worker event listener
    const workerHandler = (msg) => {
        switch (msg.event) {
            case 'init_abi': {
                if (!cachedInitABI) {
                    cachedInitABI = msg.data;
                    messageAllWorkers(cluster, {
                        event: 'initialize_abi',
                        data: msg.data
                    });
                }
                break;
            }
            case 'router_ready': {
                messageAllWorkers(cluster, {
                    event: 'connect_ws'
                });
                break;
            }
            case 'save_abi': {
                onSaveAbi(msg.data, abiCacheMap, rClient);
                break;
            }
            case 'completed': {
                const idx = activeReaders.findIndex(w => w.worker_id.toString() === msg.id);
                activeReaders.splice(idx, 1);
                if (activeReaders.length < max_readers && lastAssignedBlock < lib && allowMoreReaders) {
                    // Deploy next worker
                    worker_index++;
                    const start = lastAssignedBlock;
                    let end = lastAssignedBlock + maxBatchSize;
                    if (end > lib) {
                        end = lib;
                    }
                    lastAssignedBlock += maxBatchSize;
                    const def = {
                        worker_id: worker_index,
                        worker_role: 'reader',
                        first_block: start,
                        last_block: end,
                        init_abi: cachedInitABI
                    };
                    activeReaders.push(def);
                    workerMap.push(def);
                    setTimeout(() => {
                        // console.log(`Launching new worker from ${start} to ${end}`);
                        cluster.fork(def).on('message', workerHandler);
                    }, 100);
                }
                break;
            }
            case 'add_index': {
                indexedObjects += msg.size;
                break;
            }
            case 'ds_action': {
                deserializedActions++;
                break;
            }
            case 'ds_error': {
                ds_errors.write(msg.gs + '\n');
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
            const self = cluster.workers[c];
            self.on('message', (msg) => {
                workerHandler(msg, self);
            });
        }
    }

    // Catch dead workers
    cluster.on('exit', (worker, code) => {
        // console.log(`Worker ${worker.id}, pid: ${worker.process.pid} finished with code ${code}`);
    });

    process.on('SIGINT', () => {
        allowMoreReaders = false;
        console.info('SIGINT signal received. Shutting down readers immediately!');
        console.log('Waiting for queues...');
        setInterval(() => {
            if (allowShutdown) {
                console.log('Shutting down master...');
                process.exit(1);
            }
        }, 500);
    });
}

function messageAllWorkers(cl, payload) {
    for (const c in cl.workers) {
        if (cl.workers.hasOwnProperty(c)) {
            const _w = cl.workers[c];
            _w.send(payload);
        }
    }
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
