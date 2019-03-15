const {JsonRpc} = require('eosjs');
const fetch = require('node-fetch');
const cluster = require('cluster');
const fs = require('fs');
const redis = require('redis');
const pmx = require('pmx');

const {elasticsearchConnect} = require("./connections/elasticsearch");

const {
    getLastIndexedBlock,
    messageAllWorkers,
    printWorkerMap,
    getLastIndexedBlockFromRange,
    getLastIndexedBlockByDeltaFromRange,
    getLastIndexedBlockByDelta,
    getLastIndexedABI,
    onSaveAbi
} = require("./helpers/functions");

const {promisify} = require('util');
let client;
let cachedInitABI = null;

async function main() {
    // Preview mode - prints only the proposed worker map
    let preview = process.env.PREVIEW === 'true';

    const rClient = redis.createClient();
    const getAsync = promisify(rClient.get).bind(rClient);
    client = await elasticsearchConnect();

    const n_deserializers = parseInt(process.env.DESERIALIZERS, 10);
    const n_ingestors_per_queue = parseInt(process.env.ES_INDEXERS_PER_QUEUE, 10);
    const action_indexing_ratio = parseInt(process.env.ES_ACT_QUEUES, 10);

    let max_readers = parseInt(process.env.READERS, 10);
    if (process.env.DISABLE_READING === 'true') {
        // Create a single reader to read the abi struct and quit.
        max_readers = 1;
    }
    const activeReaders = [];

    const eos_endpoint = process.env.NODEOS_HTTP;
    const rpc = new JsonRpc(eos_endpoint, {fetch});

    const queue_prefix = process.env.CHAIN;
    const queue = queue_prefix + ':blocks';
    const {index_queues} = require('./definitions/index-queues');

    const indicesList = ["action", "block", "abi", "delta"];

    // Optional state tables
    if (process.env.ACCOUNT_STATE === 'true') {
        indicesList.push("table-accounts");
        const script_status = await client.putScript({
            id: "update_accounts",
            body: {
                script: {
                    lang: "painless",
                    source: `
                    if(params.block_num >= ctx._source.block_num) {
                        ctx._source.block_num = params.block_num;
                        ctx._source.amount = params.amount;
                    } else {
                        ctx.op = 'noop';
                    }`
                }
            }
        });
        if (!script_status['acknowledged']) {
            console.log('Failed to load script update_accounts');
            process.exit(1);
        }
    }
    if (process.env.VOTERS_STATE === 'true') {
        indicesList.push("table-voters");
        const script_status = await client.putScript({
            id: "update_voters",
            body: {
                script: {
                    lang: "painless",
                    source: `
                    if(params.block_num >= ctx._source.block_num) {
                        ctx._source.block_num = params.block_num;
                        ctx._source.producers = params.producers;
                        ctx._source.last_vote_weight = params.last_vote_weight;
                        ctx._source.is_proxy = params.is_proxy;
                        ctx._source.proxied_vote_weight = params.proxied_vote_weight;
                        ctx._source.staked = params.staked;
                        ctx._source.proxy = params.proxy;
                    } else {
                        ctx.op = 'noop';
                    }`
                }
            }
        });
        if (!script_status['acknowledged']) {
            console.log('Failed to load script update_voters');
            process.exit(1);
        }
    }
    if (process.env.DELBAND_STATE === 'true') indicesList.push("table-delband");
    if (process.env.USERRES_STATE === 'true') indicesList.push("table-userres");

    const indexConfig = require('./definitions/mappings');

    // Update index templates
    for (const index of indicesList) {
        const creation_status = await client['indices'].putTemplate({
            name: `${queue_prefix}-${index}`,
            body: indexConfig[index]
        });
        if (!creation_status['acknowledged']) {
            console.log('Failed to create template', `${queue_prefix}-${index}`);
            console.log(creation_status);
            process.exit(1);
        }
    }

    console.log('Index templates updated');

    if (process.env.CREATE_INDICES !== 'false' && process.env.CREATE_INDICES) {
        // Create indices
        let version = '';
        if (process.env.CREATE_INDICES === 'true') {
            version = 'v1';
        } else {
            version = process.env.CREATE_INDICES;
        }
        for (const index of indicesList) {
            const new_index = `${queue_prefix}-${index}-${version}-000001`;
            const exists = await client['indices'].exists({
                index: new_index
            });
            if (!exists) {
                console.log(`Creating index ${new_index}...`);
                await client['indices'].create({
                    index: new_index
                });
                console.log(`Creating alias ${queue_prefix}-${index} >> ${new_index}`);
                await client['indices'].putAlias({
                    index: new_index,
                    name: `${queue_prefix}-${index}`
                });
            } else {
                console.log(`WARNING! Index ${new_index} already created!`);
            }
        }
    }

    // Check for indexes
    for (const index of indicesList) {
        const status = await client['indices'].existsAlias({
            name: `${queue_prefix}-${index}`
        });
        if (!status) {
            console.log('Alias ' + `${queue_prefix}-${index}` + ' not found! Aborting!');
            process.exit(1);
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
            `${total_blocks}/${total_read}/${total_range}`
        ];

        console.log(log_msg.join(' | '));

        if (indexedObjects === 0 && deserializedActions === 0 && consumedBlocks === 0) {
            allowShutdown = true;
        }

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

    let lastIndexedBlock;
    if (process.env.INDEX_DELTAS === 'true') {
        lastIndexedBlock = await getLastIndexedBlockByDelta(client);
    } else {
        lastIndexedBlock = await getLastIndexedBlock(client);
    }

    // Start from the last indexed block
    let starting_block = 1;
    console.log('Last indexed block:', lastIndexedBlock);

    // Fecth chain lib
    const chain_data = await rpc.get_info();
    let head = chain_data['head_block_num'];

    if (lastIndexedBlock > 0) {
        starting_block = lastIndexedBlock;
    }

    if (process.env.STOP_ON !== "0") {
        head = parseInt(process.env.STOP_ON, 10);
    }

    let lastIndexedABI = await getLastIndexedABI(client);
    console.log(`Last indexed ABI: ${lastIndexedABI}`);

    if (process.env.START_ON !== "0") {
        starting_block = parseInt(process.env.START_ON, 10);
        // Check last indexed block again
        if (process.env.REWRITE !== 'true') {
            let lastIndexedBlockOnRange;
            if (process.env.INDEX_DELTAS === 'true') {
                lastIndexedBlockOnRange = await getLastIndexedBlockByDeltaFromRange(client, starting_block, head);
            } else {
                lastIndexedBlockOnRange = await getLastIndexedBlockFromRange(client, starting_block, head);
            }
            if (lastIndexedBlockOnRange > starting_block) {
                console.log('WARNING! Data present on target range!');
                console.log('Changing initial block num. Use REWRITE = true to bypass.');
                starting_block = lastIndexedBlockOnRange;
            }
        }
        console.log('FIRST BLOCK: ' + starting_block);
        console.log('LAST  BLOCK: ' + head);
    }


    total_range = head - starting_block;

    // Create first batch of parallel readers
    let lastAssignedBlock = starting_block;

    if (process.env.LIVE_ONLY === 'false') {
        while (activeReaders.length < max_readers && lastAssignedBlock < head) {
            worker_index++;
            const start = lastAssignedBlock;
            let end = lastAssignedBlock + maxBatchSize;
            if (end > head) {
                end = head;
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
        const _head = chain_data['head_block_num'];
        console.log(`Starting live reader at head = ${_head}`);
        worker_index++;
        workerMap.push({
            worker_id: worker_index,
            worker_role: 'continuous_reader',
            worker_last_processed_block: _head,
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
        if (q.type.startsWith("table-")) {
            worker_index++;
            workerMap.push({
                worker_id: worker_index,
                worker_role: 'ingestor',
                type: q.type,
                queue: q.name
            });
        } else {
            let n = n_ingestors_per_queue;
            if (q.type === 'abi') {
                n = 1;
            }
            let qIdx = 0;
            for (let i = 0; i < n; i++) {
                let m = 1;
                if (q.type === 'action') {
                    m = action_indexing_ratio;
                }
                for (let j = 0; j < m; j++) {
                    worker_index++;
                    workerMap.push({
                        worker_id: worker_index,
                        worker_role: 'ingestor',
                        type: q.type,
                        queue: q.name + ":" + (qIdx + 1)
                    });
                    qIdx++;
                }
            }
        }
    });

    // Setup ws router
    if (process.env.ENABLE_STREAMING) {
        worker_index++;
        workerMap.push({
            worker_id: worker_index,
            worker_role: 'router'
        });
    }

    // Quit App if on preview mode
    if (preview) {
        printWorkerMap(workerMap);
        process.exit(1);
    }

    // Launch all workers
    workerMap.forEach((conf) => {
        cluster.fork(conf);
    });

    if (!fs.existsSync('./logs')) {
        fs.mkdirSync('./logs');
    }

    const dsErrorsLog = './logs/' + process.env.CHAIN + "_ds_err_" + starting_block + "_" + head + ".txt";
    if (fs.existsSync(dsErrorsLog)) {
        fs.unlinkSync(dsErrorsLog);
    }
    const ds_errors = fs.createWriteStream(dsErrorsLog, {flags: 'a'});

    const cachedMap = await getAsync(process.env.CHAIN + ":" + 'abi_cache');
    let abiCacheMap;
    if (cachedMap) {
        abiCacheMap = JSON.parse(cachedMap);
        console.log(`Found ${Object.keys(abiCacheMap).length} entries in the local ABI cache`)
    } else {
        abiCacheMap = {};
    }

    setInterval(() => {
        rClient.set(process.env.CHAIN + ":" + 'abi_cache', JSON.stringify(abiCacheMap));
    }, 10000);

    // Worker event listener
    const workerHandler = (msg) => {
        switch (msg.event) {
            case 'init_abi': {
                if (!cachedInitABI) {
                    cachedInitABI = msg.data;
                    setTimeout(() => {
                        messageAllWorkers(cluster, {
                            event: 'initialize_abi',
                            data: msg.data
                        });
                    }, 1000);
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
                if (activeReaders.length < max_readers && lastAssignedBlock < head && allowMoreReaders) {
                    // Deploy next worker
                    worker_index++;
                    const start = lastAssignedBlock;
                    let end = lastAssignedBlock + maxBatchSize;
                    if (end > head) {
                        end = head;
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

    pmx.action('stop', (reply) => {
        allowMoreReaders = false;
        console.info('Stop signal received. Shutting down readers immediately!');
        console.log('Waiting for queues...');
        reply({
            ack: true
        });
        setInterval(() => {
            if (allowShutdown) {
                console.log('Shutting down master...');
                rClient.set('abi_cache', JSON.stringify(abiCacheMap));
                process.exit(1);
            }
        }, 500);
    });

}

module.exports = {main};
