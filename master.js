const cluster = require('cluster');
const fs = require('fs');
const path = require('path');
const pm2io = require('@pm2/io');
const {promisify} = require('util');
const doctor = require('./modules/doctor');
const moment = require('moment');

const {ConnectionManager} = require('./connections/manager');
const manager = new ConnectionManager();

const config = require(`./${process.env.CONFIG_JSON}`);
const scaling = config['scaling'];
const settings = config['settings'];
const features = config['features'];

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

// Master proc globals
let client, rClient, rpc;
let cachedInitABI = null;
const missingRanges = [];
let currentSchedule;
let lastProducer = null;
const producedBlocks = {};
let handoffCounter = 0;
let lastProducedBlockNum = 0;
const missedRounds = {};
let dsErrorStream;
let abiCacheMap;

async function getCurrentSchedule() {
    currentSchedule = await rpc.get_producer_schedule();
}

async function reportMissedBlocks(producer, last_block, size) {
    console.log(`${producer} missed ${size} ${size === 1 ? "block" : "blocks"} after ${last_block}`);
    await client.index({
        index: settings.chain + '-logs',
        body: {
            type: 'missed_blocks',
            '@timestamp': new Date().toISOString(),
            'missed_blocks': {
                'producer': producer,
                'last_block': last_block,
                'size': size,
                'schedule_version': currentSchedule.schedule_version
            }
        }
    });
}

let blockMsgQueue = [];

function onLiveBlock(msg) {
    if (msg.block_num === lastProducedBlockNum + 1 || lastProducedBlockNum === 0) {
        const prod = msg.producer;

        if (settings['bp_logs']) {
            console.log(`Received block ${msg.block_num} from ${prod}`);
        }
        if (producedBlocks[prod]) {
            producedBlocks[prod]++;
        } else {
            producedBlocks[prod] = 1;
        }
        if (lastProducer !== prod) {
            handoffCounter++;
            if (lastProducer && handoffCounter > 2) {
                const activeProds = currentSchedule.active.producers;
                const newIdx = activeProds.findIndex(p => p['producer_name'] === prod) + 1;
                const oldIdx = activeProds.findIndex(p => p['producer_name'] === lastProducer) + 1;
                if ((newIdx === oldIdx + 1) || (newIdx === 1 && oldIdx === activeProds.length)) {
                    // Normal operation
                    if (settings['bp_logs']) {
                        console.log(`[${msg.block_num}] producer handoff: ${lastProducer} [${oldIdx}] -> ${prod} [${newIdx}]`);
                    }
                } else {
                    let cIdx = oldIdx + 1;
                    while (cIdx !== newIdx) {
                        try {
                            if (activeProds[cIdx - 1]) {
                                const missingProd = activeProds[cIdx - 1]['producer_name'];
                                // report
                                reportMissedBlocks(missingProd, lastProducedBlockNum, 12)
                                    .catch(console.log);
                                // count missed
                                if (missedRounds[missingProd]) {
                                    missedRounds[missingProd]++;
                                } else {
                                    missedRounds[missingProd] = 1;
                                }
                                console.log(`${missingProd} missed a round [${missedRounds[missingProd]}]`);
                            }
                        } catch (e) {
                            console.log(activeProds);
                            console.log(e);
                        }
                        cIdx++;
                        if (cIdx === activeProds.length) {
                            cIdx = 0;
                        }
                    }
                }
                if (producedBlocks[lastProducer]) {
                    if (producedBlocks[lastProducer] < 12) {
                        const _size = 12 - producedBlocks[lastProducer];
                        reportMissedBlocks(lastProducer, lastProducedBlockNum, _size)
                            .catch(console.log)
                    }
                }
                producedBlocks[lastProducer] = 0;
            }
            lastProducer = prod;
        }
        lastProducedBlockNum = msg.block_num;
    } else {
        blockMsgQueue.push(msg);
        blockMsgQueue.sort((a, b) => a.block_num - b.block_num);
        while (blockMsgQueue.length > 0) {
            if (blockMsgQueue[0].block_num === lastProducedBlockNum + 1) {
                onLiveBlock(blockMsgQueue.shift());
            } else {
                break;
            }
        }
    }
}

function setupDSElogs(starting_block, head) {
    const logPath = './logs/' + settings.chain;
    if (!fs.existsSync(logPath)) fs.mkdirSync(logPath, {recursive: true});
    const dsLogFileName = (new Date().toISOString()) + "_ds_err_" + starting_block + "_" + head + ".log";
    const dsErrorsLog = logPath + '/' + dsLogFileName;
    if (fs.existsSync(dsErrorsLog)) fs.unlinkSync(dsErrorsLog);
    const symbolicLink = logPath + '/deserialization_errors.log';
    if (fs.existsSync(symbolicLink)) fs.unlinkSync(symbolicLink);
    fs.symlinkSync(dsLogFileName, symbolicLink);
    dsErrorStream = fs.createWriteStream(dsErrorsLog, {flags: 'a'});
    console.log(`📣️  Deserialization errors are being logged in: ${path.join(__dirname, symbolicLink)}`);
}

async function initAbiCacheMap(getAsync) {
    const cachedMap = await getAsync(settings.chain + ":" + 'abi_cache');
    if (cachedMap) {
        abiCacheMap = JSON.parse(cachedMap);
        console.log(`Found ${Object.keys(abiCacheMap).length} entries in the local ABI cache`)
    } else {
        abiCacheMap = {};
    }

    // Periodically save the current map
    setInterval(() => {
        rClient.set(settings.chain + ":" + 'abi_cache', JSON.stringify(abiCacheMap));
    }, 10000);
}

async function applyUpdateScript(esClient) {
    const script_status = await esClient.putScript({
        id: "updateByBlock",
        body: {
            script: {
                lang: "painless",
                source: `
                    boolean valid = false;
                    if(ctx._source.block_num != null) {
                      if(params.block_num < ctx._source.block_num) {
                        ctx['op'] = 'none';
                        valid = false;
                      } else {
                        valid = true;
                      } 
                    } else {
                      valid = true;
                    }
                    if(valid == true) {
                      for (entry in params.entrySet()) {
                        if(entry.getValue() != null) {
                          ctx._source[entry.getKey()] = entry.getValue();
                        } else {
                          ctx._source.remove(entry.getKey());
                        }
                      }
                    }
                `
            }
        }
    });
    if (!script_status['body']['acknowledged']) {
        console.log('Failed to load script updateByBlock. Aborting!');
        process.exit(1);
    } else {
        console.log('Painless Update Script loaded!');
    }
}

function addStateTables(indicesList, index_queues) {
    const queue_prefix = settings.chain;
    const index_queue_prefix = queue_prefix + ':index';
    // Optional state tables
    const table_feats = features.tables;
    if (table_feats.proposals) {
        indicesList.push("table-proposals");
        index_queues.push({type: 'table-proposals', name: index_queue_prefix + "_table_proposals"});
    }

    if (table_feats.accounts) {
        indicesList.push("table-accounts");
        index_queues.push({type: 'table-accounts', name: index_queue_prefix + "_table_accounts"});
    }

    if (table_feats.voters) {
        indicesList.push("table-voters");
        index_queues.push({type: 'table-voters', name: index_queue_prefix + "_table_voters"});
    }

    if (table_feats['delband']) {
        indicesList.push("table-delband");
        index_queues.push({type: 'table-delband', name: index_queue_prefix + "_table_delband"});
    }

    if (table_feats['userres']) {
        indicesList.push("table-userres");
        index_queues.push({type: 'table-userres', name: index_queue_prefix + "_table_userres"});
    }
}

async function waitForLaunch() {
    return new Promise(resolve => {
        console.log(`Use "pm2 trigger ${pm2io.getConfig()['module_name']} start" to start the indexer now or restart without preview mode.`);
        const idleTimeout = setTimeout(() => {
            console.log('No command received after 10 minutes.');
            console.log('Exiting now! Disable the PREVIEW mode to continue.');
            process.exit(1);
        }, 60000 * 10);
        pm2io.action('start', (reply) => {
            resolve();
            reply({ack: true});
            clearTimeout(idleTimeout);
        });
    });
}

function onScheduleUpdate(msg) {
    if (msg.live === 'true') {
        console.log(`Producer schedule updated at block ${msg.block_num}`);
        currentSchedule.active.producers = msg.new_producers.producers
    }
}

async function main() {
    console.log(`--------- Hyperion Indexer ${require('./package').version} ---------`);

    console.log(`Using parser version ${config.settings.parser}`);
    console.log(`Chain: ${config.settings.chain}`);

    if (config.indexer['abi_scan_mode']) {
        if (config.indexer['fetch_block'] || config.indexer['fetch_traces']) {
            console.log('Invalid configuration! indexer.fetch_block and indexer.fetch_traces must' +
                ' be both set to [false] while indexer.abi_scan_mode is [true]');
            process.exit(1);
        }
        console.log('-------------------\n ABI SCAN MODE \n-------------------');
    } else {
        console.log('---------------\n INDEXING MODE \n---------------');
    }

    // Preview mode - prints only the proposed worker map
    let preview = config.settings.preview;
    const queue_prefix = config.settings.chain;

    // Purge queues
    if (config.indexer['purge_queues']) {
        if (config.indexer['disable_reading']) {
            console.log('Cannot purge queue with disabled reading! Exiting now!');
            process.exit(1);
        } else {
            await manager.purgeQueues(queue_prefix);
        }
    }

    // Chain API
    rpc = manager.nodeosJsonRPC;
    await getCurrentSchedule();
    console.log(`${currentSchedule.active.producers.length} active producers`);

    // Redis
    rClient = manager.redisClient;
    const getAsync = promisify(rClient.get).bind(rClient);

    // ELasticsearch
    client = manager.elasticsearchClient;
    let ingestClients = manager.ingestClients;

    // Check for ingestion nodes
    for (const ingestClient of ingestClients) {
        try {
            const ping_response = await ingestClient.ping();
            if (ping_response.body) {
                console.log(`Ingest client ready at ${ping_response.meta.connection.id}`);
            }
        } catch (e) {
            console.log(e);
            console.log('Failed to connect to one of the ingestion nodes. Please verify the connections.json file');
            process.exit(1);
        }
    }
    ingestClients = null;

    const n_deserializers = scaling['ds_queues'];
    const n_ingestors_per_queue = scaling['indexing_queues'];
    const action_indexing_ratio = scaling['ad_idx_queues'];

    let max_readers = scaling['readers'];
    if (config.indexer['disable_reading']) {
        // Create a single reader to read the abi struct and quit.
        max_readers = 1;
    }

    const {index_queues} = require('./definitions/index-queues');

    const indicesList = ["action", "block", "abi", "delta", "logs"];

    addStateTables(indicesList, index_queues);

    await applyUpdateScript(client);

    const indexConfig = require('./definitions/mappings');

    // Add lifecycle policy
    if (indexConfig.ILPs) {
        // check for existing policy
        for (const ILP of indexConfig.ILPs) {
            try {
                await client.ilm.getLifecycle({
                    policy: ILP.policy
                });
            } catch (e) {
                console.log(e);
                try {
                    const ilm_status = await client.ilm.putLifecycle(ILP);
                    if (!ilm_status['body']['acknowledged']) {
                        console.log(`Failed to create ILM Policy`);
                    }
                } catch (e) {
                    console.log(`[FATAL] :: Failed to create ILM Policy`);
                    console.log(e);
                    process.exit(1);
                }
            }
        }
    }

    // Check for extra mappings
    // Load Modules
    const HyperionModuleLoader = require('./modules/index').HyperionModuleLoader;
    const mLoader = new HyperionModuleLoader(config.indexer['parser']);

    // Modify mappings
    for (const exM of mLoader.extraMappings) {
        if (exM['action']) {
            for (const key in exM['action']) {
                if (exM['action'].hasOwnProperty(key)) {
                    indexConfig['action']['mappings']['properties'][key] = exM['action'][key];
                    console.log(`Mapping added for ${key}`);
                }
            }
        }
    }


    // Update index templates
    for (const index of indicesList) {
        try {
            const creation_status = await client['indices'].putTemplate({
                name: `${queue_prefix}-${index}`,
                body: indexConfig[index]
            });
            if (!creation_status['body']['acknowledged']) {
                console.log(`Failed to create template: ${queue_prefix}-${index}`);
            }
        } catch (e) {
            console.log(e);
            process.exit(1);
        }
    }
    console.log('Index templates updated');

    // Create indices
    if (config.settings['index_version']) {
        // Create indices
        let version;
        if (config.settings['index_version'] === true) {
            version = 'v1';
        } else {
            version = config.settings['index_version'];
        }
        for (const index of indicesList) {
            const new_index = `${queue_prefix}-${index}-${version}-000001`;
            const exists = await client['indices'].exists({
                index: new_index
            });
            if (!exists.body) {
                console.log(`Creating index ${new_index}...`);
                await client['indices'].create({
                    index: new_index
                });
                console.log(`Creating alias ${queue_prefix}-${index} >> ${new_index}`);
                await client['indices'].putAlias({
                    index: new_index,
                    name: `${queue_prefix}-${index}`
                });
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
    let allowShutdown = false;
    let allowMoreReaders = true;
    let total_range = 0;
    let maxBatchSize = scaling['batch_size'];

    // Auto-stop
    let auto_stop = 0;
    let idle_count = 0;
    if (config.settings['auto_stop']) {
        auto_stop = config.settings['auto_stop'];
    }

    let lastIndexedBlock;
    if (config.features['index_deltas']) {
        lastIndexedBlock = await getLastIndexedBlockByDelta(client);
        console.log('Last indexed block (deltas):', lastIndexedBlock);
    } else {
        lastIndexedBlock = await getLastIndexedBlock(client);
        console.log('Last indexed block (blocks):', lastIndexedBlock);
    }

    // Start from the last indexed block
    let starting_block = 1;

    // Fecth chain lib
    const chain_data = await rpc.get_info();
    let head = chain_data['head_block_num'];

    if (lastIndexedBlock > 0) {
        starting_block = lastIndexedBlock;
    }

    if (config.indexer['stop_on'] !== 0) {
        head = config.indexer['stop_on'];
    }

    let lastIndexedABI = await getLastIndexedABI(client);
    console.log(`Last indexed ABI: ${lastIndexedABI}`);
    if (config.indexer['abi_scan_mode']) {
        starting_block = lastIndexedABI;
    }

    // Define block range
    if (config.indexer['start_on'] !== 0) {
        starting_block = config.indexer['start_on'];
        // Check last indexed block again
        if (!config.indexer['rewrite']) {

            let lastIndexedBlockOnRange;

            if (config.features['index_deltas']) {
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
        console.log(' |>> First Block: ' + starting_block);
        console.log(' >>| Last  Block: ' + head);
    }

    // Setup Readers
    total_range = head - starting_block;
    let lastAssignedBlock = starting_block;
    let activeReadersCount = 0;
    if (!config.indexer['repair_mode']) {
        if (!config.indexer['live_only_mode']) {
            while (activeReadersCount < max_readers && lastAssignedBlock < head) {
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
                // activeReaders.push(def);
                activeReadersCount++;
                workerMap.push(def);
                console.log(`Setting parallel reader [${worker_index}] from block ${start} to ${end}`);
            }
        }

        // Setup Serial reader worker
        if (config.indexer['live_reader']) {
            const _head = chain_data['head_block_num'];
            console.log(`Setting live reader at head = ${_head}`);

            // live block reader
            worker_index++;
            workerMap.push({
                worker_id: worker_index,
                worker_role: 'continuous_reader',
                worker_last_processed_block: _head,
                ws_router: ''
            });

            // live deserializer
            worker_index++;
            workerMap.push({
                worker_id: worker_index,
                worker_role: 'deserializer',
                worker_queue: queue_prefix + ':live_blocks',
                live_mode: 'true'
            });
        }
    }

    // Setup Deserialization Workers
    for (let i = 0; i < n_deserializers; i++) {
        for (let j = 0; j < scaling['ds_threads']; j++) {
            worker_index++;
            workerMap.push({
                worker_id: worker_index,
                worker_role: 'deserializer',
                worker_queue: queue_prefix + ':blocks' + ":" + (i + 1),
                live_mode: 'false'
            });
        }
    }

    // Setup ES Ingestion Workers
    let qIdx = 0;
    index_queues.forEach((q) => {
        let n = n_ingestors_per_queue;
        if (q.type === 'abi') {
            n = 1;
        }
        qIdx = 0;
        for (let i = 0; i < n; i++) {
            let m = 1;
            if (q.type === 'action' || q.type === 'delta') {
                m = action_indexing_ratio;
            }
            for (let j = 0; j < m; j++) {
                worker_index++;
                workerMap.push({
                    worker_id: worker_index,
                    worker_role: 'ingestor',
                    queue: q.name + ":" + (qIdx + 1),
                    type: q.type
                });
                qIdx++;
            }
        }
    });

    const _streaming = config.features['streaming'];

    // Setup ws router
    if (_streaming.enable) {
        worker_index++;
        workerMap.push({
            worker_id: worker_index,
            worker_role: 'router'
        });
        if (_streaming.deltas) console.log('Delta streaming enabled!');
        if (_streaming.traces) console.log('Action trace streaming enabled!');
        if (!_streaming.deltas && !_streaming.traces) {
            console.log('WARNING! Streaming is enabled without any datatype,' +
                'please enable STREAM_TRACES and/or STREAM_DELTAS');
        }
    }

    // Quit App if on preview mode
    if (preview) {
        printWorkerMap(workerMap);
        await waitForLaunch();
    }

    // Setup Error Logging
    setupDSElogs(starting_block, head);
    await initAbiCacheMap(getAsync);

    // Start Monitoring
    let log_interval = 5000;
    let shutdownTimer;
    const consume_rates = [];
    let pushedBlocks = 0;
    let livePushedBlocks = 0;
    let consumedBlocks = 0;
    let liveConsumedBlocks = 0;
    let indexedObjects = 0;
    let deserializedActions = 0;
    let lastProcessedBlockNum = 0;
    let total_read = 0;
    let total_blocks = 0;
    let total_indexed_blocks = 0;
    let total_actions = 0;
    setInterval(() => {
        const _workers = Object.keys(cluster.workers).length;
        const tScale = (log_interval / 1000);
        total_read += pushedBlocks;
        total_blocks += consumedBlocks;
        total_actions += deserializedActions;
        total_indexed_blocks += indexedObjects;
        const consume_rate = consumedBlocks / tScale;
        consume_rates.push(consume_rate);
        if (consume_rates.length > 20) {
            consume_rates.splice(0, 1);
        }
        let avg_consume_rate = 0;
        if (consume_rates.length > 0) {
            for (const r of consume_rates) {
                avg_consume_rate += r;
            }
            avg_consume_rate = avg_consume_rate / consume_rates.length;
        } else {
            avg_consume_rate = consume_rate;
        }
        const log_msg = [];

        log_msg.push(`W:${_workers}`);
        log_msg.push(`R:${(pushedBlocks + livePushedBlocks) / tScale} b/s`);
        log_msg.push(`C:${(liveConsumedBlocks + consumedBlocks) / tScale} b/s`);
        log_msg.push(`D:${deserializedActions / tScale} a/s`);
        log_msg.push(`I:${indexedObjects / tScale} d/s`);

        if (total_blocks < total_range && !config.indexer['live_only_mode']) {
            const remaining = total_range - total_blocks;
            const estimated_time = Math.round(remaining / avg_consume_rate);
            const time_string = moment()
                .add(estimated_time, 'seconds')
                .fromNow(false);
            const pct_parsed = ((total_blocks / total_range) * 100).toFixed(1);
            const pct_read = ((total_read / total_range) * 100).toFixed(1);
            log_msg.push(`${total_blocks}/${total_read}/${total_range}`);
            log_msg.push(`syncs ${time_string} (${pct_parsed}% ${pct_read}%)`);
        }

        // print monitoring log
        if (config.settings['rate_monitoring']) {
            console.log(log_msg.join(', '));
        }

        if (indexedObjects === 0 && deserializedActions === 0 && consumedBlocks === 0) {

            // Allow 10s threshold before shutting down the process
            shutdownTimer = setTimeout(() => {
                allowShutdown = true;
            }, 10000);

            // Auto-Stop
            if (pushedBlocks === 0) {
                idle_count++;
                if (auto_stop > 0 && (tScale * idle_count) >= auto_stop) {
                    console.log("Reached limit for no blocks processed, stopping now...");
                    rClient.set('abi_cache', JSON.stringify(abiCacheMap));
                    process.exit(1);
                } else {
                    console.log(`No blocks processed! Indexer will stop in ${auto_stop - (tScale * idle_count)} seconds!`);
                }
            }
        } else {
            if (idle_count > 1) {
                console.log('Processing resumed!');
            }
            idle_count = 0;
            if (shutdownTimer) {
                clearTimeout(shutdownTimer);
                shutdownTimer = null;
            }
        }

        // reset counters
        pushedBlocks = 0;
        livePushedBlocks = 0;
        consumedBlocks = 0;
        liveConsumedBlocks = 0;
        deserializedActions = 0;
        indexedObjects = 0;

        if (_workers === 0) {
            console.log('FATAL ERROR - All Workers have stopped!');
            process.exit(1);
        }

    }, log_interval);

    // Launch all workers
    workerMap.forEach((conf) => {
        cluster.fork(conf);
    });

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
                if (msg.id === doctorId.toString()) {
                    console.log('repair worker completed', msg);
                    console.log('queue size [before]:', missingRanges.length);
                    if (missingRanges.length > 0) {
                        const range_data = missingRanges.shift();
                        console.log('New repair range', range_data);
                        console.log('queue size [after]:', missingRanges.length);
                        doctorIdle = false;
                        messageAllWorkers(cluster, {
                            event: 'new_range',
                            target: msg.id,
                            data: {
                                first_block: range_data.start,
                                last_block: range_data.end
                            }
                        });
                    } else {
                        doctorIdle = true;
                    }
                } else {
                    activeReadersCount--;
                    if (activeReadersCount < max_readers && lastAssignedBlock < head && allowMoreReaders) {
                        // Assign next range
                        const start = lastAssignedBlock;
                        let end = lastAssignedBlock + maxBatchSize;
                        if (end > head) {
                            end = head;
                        }
                        lastAssignedBlock += maxBatchSize;
                        const def = {
                            first_block: start,
                            last_block: end
                        };
                        activeReadersCount++;
                        messageAllWorkers(cluster, {
                            event: 'new_range',
                            target: msg.id,
                            data: def
                        });
                    }
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
                // console.log(msg.data);
                const str = JSON.stringify(msg.data);
                // console.log(str);
                dsErrorStream.write(str + '\n');
                break;
            }
            case 'read_block': {
                if (!msg.live) {
                    pushedBlocks++;
                } else {
                    livePushedBlocks++;
                }
                break;
            }
            case 'consumed_block': {
                if (msg.live === 'false') {
                    consumedBlocks++;
                    if (msg.block_num > lastProcessedBlockNum) {
                        lastProcessedBlockNum = msg.block_num;
                    }
                } else {
                    liveConsumedBlocks++;
                    onLiveBlock(msg);
                }
                break;
            }
            case 'new_schedule': {
                onScheduleUpdate(msg);
                break;
            }
            default: {
                // console.log(msg);
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

    let doctorStarted = false;
    let doctorIdle = true;
    let doctorId = 0;
    if (config.indexer['repair_mode']) {
        doctor.run(missingRanges).then(() => {
            console.log('repair completed!');
        });
        setInterval(() => {
            if (missingRanges.length > 0 && !doctorStarted) {
                doctorStarted = true;
                console.log('repair worker launched');
                const range_data = missingRanges.shift();
                worker_index++;
                const def = {
                    worker_id: worker_index,
                    worker_role: 'reader',
                    first_block: range_data.start,
                    last_block: range_data.end
                };
                const self = cluster.fork(def);
                doctorId = def.worker_id;
                console.log('repair id =', doctorId);
                self.on('message', (msg) => {
                    workerHandler(msg, self);
                });
            } else {
                if (missingRanges.length > 0 && doctorIdle) {
                    const range_data = missingRanges.shift();
                    messageAllWorkers(cluster, {
                        event: 'new_range',
                        target: doctorId.toString(),
                        data: {
                            first_block: range_data.start,
                            last_block: range_data.end
                        }
                    });
                }
            }
        }, 1000);
    }

    // Attach stop handler
    pm2io.action('stop', (reply) => {
        allowMoreReaders = false;
        console.info('Stop signal received. Shutting down readers immediately!');
        console.log('Waiting for queues...');
        messageAllWorkers(cluster, {
            event: 'stop'
        });
        reply({ack: true});
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
