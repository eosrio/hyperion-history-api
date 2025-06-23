import { Client } from '@elastic/elasticsearch';
import { APIClient } from "@wharfkit/antelope";
// @ts-ignore
import cliProgress from 'cli-progress';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { HyperionBlock } from './interfaces.js';
import { getBlocks, getLastIndexedBlock, initESClient, readChainConfig, readConnectionConfig } from './functions.js';
import { getFirstIndexedBlock } from "../../indexer/helpers/common_functions.js";
import { printHeader, processResults } from './utils.js';
import { log } from 'node:console';

const progressBar = new cliProgress.SingleBar(
    {},
    cliProgress.Presets.shades_classic
);

export async function run(
    client: Client,
    apiClient: APIClient,
    indexName: string,
    lastRequestedBlock: number,
    firstBlock: number,
    qtdTotal: any,
    loop: any = 1,
    errorRanges: any[],
    missingBlocks: any[],
    pendingBlock: { block: HyperionBlock | null }
) {
    // run in reverse order
    let blockInitial = lastRequestedBlock;
    let finalBlock = blockInitial - qtdTotal;
    const tRef = process.hrtime.bigint();
    progressBar.start(loop, 0);
    for (let i: any = 1; i <= loop; i++) {
        if (finalBlock < firstBlock) {
            finalBlock = firstBlock;
        }
        try {
            const result = await getBlocks(
                client,
                indexName,
                blockInitial,
                finalBlock,
                qtdTotal
            );
            let { hits: { hits } } = result;
            const blocks = hits.map((obj: any) => obj._source);
            await findForksOnRange(blocks, apiClient, errorRanges, missingBlocks, pendingBlock);
            blockInitial = finalBlock;
            finalBlock = blockInitial - qtdTotal;
            progressBar.update(i);
        } catch (e: any) {
            progressBar.stop();
            console.log('\nError getting blocks from ES: ', e.message);
            process.exit(1);
        }
    }
    progressBar.stop();

    if (errorRanges.length === 0 && missingBlocks.length === 0) {
        console.log(`\n 🎉 🎉 No forked or missing blocks found between the range ${blockInitial} and ${lastRequestedBlock}`);
    } else {
        if (errorRanges.length > 0) {
            console.log('\n=========== Forked Ranges ===========');
            console.table(errorRanges);
        }
        if (missingBlocks.length > 0) {
            console.log('\n=========== Missing Ranges ==========');
            console.table(missingBlocks);
        }
    }

    const tDiff = Number(process.hrtime.bigint() - tRef) / 1000000;
    console.log(`\nTotal time: ${Math.round(tDiff / 1000)}s`);
}

export async function findForksOnRange(
    blocks: HyperionBlock[],
    rpc: APIClient,
    errorRanges: any[],
    missingBlocks: any[],
    pendingBlock: { block: HyperionBlock | null }
) {
    const removals: Set<string> = new Set();
    let start: number | null = null;
    let end: number | null = null;
    if (
        blocks.length > 0 &&
        pendingBlock.block &&
        blocks[0].block_num !== pendingBlock.block.block_num
    ) {
        blocks.unshift(pendingBlock.block);
    }

    let i = 0;
    for (const currentBlock of blocks) {
        const currentBlockNumber = currentBlock.block_num;
        // console.log('current -> ', currentBlockNumber);
        const previousBlock = blocks[i + 1];
        if (!previousBlock) {
            pendingBlock.block = currentBlock;
            // console.log('pending -> ', pendingBlock.block_num);
            return;
        }
        i++;
        // console.log('previous -> ', previousBlock.block_num);
        if (previousBlock.block_num !== currentBlockNumber - 1) {
            // console.log(
            //     `\nBlock number mismatch, expected: ${currentBlockNumber - 1
            //     } got ${previousBlock.block_num}`
            // );
            missingBlocks.push({
                start: previousBlock.block_num + 1,
                end: currentBlockNumber - 1,
                count: currentBlockNumber - previousBlock.block_num - 1
            });
            continue;
        }

        if (previousBlock && previousBlock.block_id !== currentBlock.prev_id) {
            if (start === null) {
                start = currentBlockNumber - 1;
                const blockData = await rpc.v1.chain.get_block_info(start);
                if (blockData && blockData.id.toString() !== previousBlock.block_id) {
                    removals.add(previousBlock.block_id);
                }
            }
        } else {
            if (start) {
                const blockData = await rpc.v1.chain.get_block_info(currentBlockNumber);
                if (blockData) {
                    if (blockData.id.toString() !== currentBlock.block_id) {
                        removals.add(currentBlock.block_id);
                    } else {
                        end = currentBlockNumber + 1;
                        const range = { start, end, ids: [...removals] };
                        errorRanges.push(range);
                        removals.clear();
                        // console.log(`\n ⚠️⚠️ Forked at ${range.start} to ${range.end}`);
                        start = null;
                        end = null;
                    }
                }
            }
        }
    }
}

export async function scanChain(chain: string, args: any) {
    const chainConfig = readChainConfig(chain);
    const config = readConnectionConfig();
    const client = initESClient(config);
    const apiClient = new APIClient({ fetch, url: config.chains[chain].http });
    const ping = await client.ping();

    if (!ping) {
        console.log('Could not connect to ElasticSearch');
        process.exit();
    }

    printHeader();

    const blockIndex = `${chain}-block-${chainConfig.settings.index_version}`;

    console.log(`Using block index: ${blockIndex}`);

    let firstBlock;
    let lastBlock;

    if (args.first && args.last) {
        // first must be less than last
        if (args.first > args.last) {
            console.log('First block must be less than last block');
            process.exit();
        }
    }

    if (args.first) {
        // reduce by 2 to account for the fork end validation
        firstBlock = args.first - 2;
    } else {
        firstBlock = await getFirstIndexedBlock(client, chain, chainConfig.settings.index_partition_size);
    }

    if (args.last) {
        lastBlock = args.last;
    } else {
        lastBlock = await getLastIndexedBlock(client, blockIndex);
    }

    const totalBlocks = lastBlock - firstBlock;

    let batchSize = 2000;
    if (args.batch) {
        batchSize = args.batch;
    }

    const numberOfBatches = Math.ceil(totalBlocks / batchSize);

    console.log('Range:', firstBlock, lastBlock);
    console.log('Total Blocks:', totalBlocks);
    console.log('Batch Size:', batchSize);
    console.log('Number of Batches:', numberOfBatches);
    console.log();

    // Initialize shared state
    const errorRanges: any[] = [];
    const missingBlocks: any[] = [];
    const pendingBlock: { block: HyperionBlock | null } = { block: null };

    await run(client, apiClient, blockIndex, lastBlock, firstBlock, batchSize, numberOfBatches, errorRanges, missingBlocks, pendingBlock);
    console.log(`Finished checking forked blocks!`);

    processResults(chain, firstBlock, lastBlock, args, errorRanges, missingBlocks);
}

export async function quickScanChain(chain: string, args: any) {
    const tRef = process.hrtime.bigint();
    const chainConfig = readChainConfig(chain);
    const config = readConnectionConfig();
    const client = initESClient(config);
    const ping = await client.ping();

    if (!ping) {
        console.log('Could not connect to ElasticSearch');
        process.exit();
    }

    printHeader();

    const blockIndex = `${chain}-block-${chainConfig.settings.index_version}`;

    console.log(`Using block index: ${blockIndex}`);

    let firstBlock: number;
    let lastBlock: number;

    if (args.first && args.last) {
        // first must be less than last
        if (args.first > args.last) {
            console.log('First block must be less than last block');
            process.exit();
        }
    }

    if (args.first) {
        // reduce by 2 to account for the fork end validation
        firstBlock = args.first - 2;
    } else {
        const tRef = process.hrtime.bigint();
        firstBlock = await getFirstIndexedBlock(client, chain, chainConfig.settings.index_partition_size);
        console.log(`First block search time: ${Number(process.hrtime.bigint() - tRef) / 1000000}ms`);
    }

    if (args.last) {
        lastBlock = args.last;
    } else {
        const tRef = process.hrtime.bigint();
        lastBlock = await getLastIndexedBlock(client, blockIndex);
        console.log(`Last block search time: ${Number(process.hrtime.bigint() - tRef) / 1000000}ms`);
    }

    const totalBlocks = lastBlock - firstBlock + 1;

    console.log('Range:', firstBlock, lastBlock);
    console.log('Total Blocks:', totalBlocks);

    const missingBlocks: any[] = [];
    await searchMissingBlocks(client, blockIndex, firstBlock, lastBlock, totalBlocks, missingBlocks);

    if (missingBlocks.length > 0) {
        // merge missing ranges
        const mergedRanges: any[] = [];
        let start = missingBlocks[0].start;
        let end = missingBlocks[0].end;
        for (let i = 1; i < missingBlocks.length; i++) {
            if (missingBlocks[i].start === end + 1) {
                end = missingBlocks[i].end;
            } else {
                mergedRanges.push({ start, end, count: end - start + 1 });
                start = missingBlocks[i].start;
                end = missingBlocks[i].end;
            }
        }
        mergedRanges.push({ start, end, count: end - start + 1 });
        console.log(mergedRanges);
        const finalMissingBlocks = mergedRanges;
        const totalMissingBlocks = finalMissingBlocks.reduce((acc, range) => acc + range.count, 0);
        console.log(`\n ⚠️  ⚠️  Found ${totalMissingBlocks} missing blocks between the range ${firstBlock} and ${lastBlock}`);

        processResults(chain, firstBlock, lastBlock, args, [], finalMissingBlocks);
    } else {
        console.log(`\n 🎉 🎉 No missing blocks found between the range ${firstBlock} and ${lastBlock}`);
    }
    console.log(`\nTotal time: ${Number(process.hrtime.bigint() - tRef) / 1000000}ms`);
}

export async function searchMissingBlocks(
    client: Client,
    blockIndex: string,
    firstBlock: number,
    lastBlock: number,
    totalBlocks: number,
    missingBlocks: any[]
) {
    // console.log(`Search region size: ${totalBlocks}`);
    // count the total number of indexed blocks
    const totalIndexedBlocks = await client.count({
        index: blockIndex,
        query: {
            bool: {
                must: [{
                    range: { block_num: { gte: firstBlock, lte: lastBlock } }
                }]
            }
        }
    });

    if (totalIndexedBlocks.count === 0) {
        // console.log(`\n ❌ No indexed blocks found between the range ${firstBlock} and ${lastBlock}`);
        missingBlocks.push({ start: firstBlock, end: lastBlock, count: firstBlock - lastBlock + 1 });
        return;
    }

    const missedBlocks = totalBlocks - totalIndexedBlocks.count;
    if (missedBlocks > 0) {
        // console.log(`\n ⚠️  ⚠️  Found ${missedBlocks} missing blocks between the range ${firstBlock} and ${lastBlock}`);
        // split the range in half
        const middleBlock = Math.floor((lastBlock + firstBlock) / 2);
        const leftRange = { first: firstBlock, last: middleBlock };
        const rightRange = { first: middleBlock + 1, last: lastBlock };
        await searchMissingBlocks(client, blockIndex, leftRange.first, leftRange.last, middleBlock - firstBlock + 1, missingBlocks);
        await searchMissingBlocks(client, blockIndex, rightRange.first, rightRange.last, lastBlock - middleBlock, missingBlocks);
    }
}

export async function scanActions(chain: string, args: any) {
    const tRef = process.hrtime.bigint();
    const chainConfig = readChainConfig(chain);
    const config = readConnectionConfig();
    const client = initESClient(config);
    const ping = await client.ping();

    if (!ping) {
        console.log('Could not connect to ElasticSearch');
        process.exit();
    }

    printHeader();
    console.log('🔍 Scanning for missing actions using validation API...\n');

    const blockIndex = `${chain}-block-${chainConfig.settings.index_version}`;
    console.log(`Using block index: ${blockIndex}`);

    let firstBlock: number;
    let lastBlock: number;

    if (args.first && args.last) {
        // first must be less than last
        if (args.first > args.last) {
            console.log('First block must be less than last block');
            process.exit();
        }
    }

    if (args.first) {
        firstBlock = parseInt(args.first, 10);
    } else {
        const tRef = process.hrtime.bigint();
        firstBlock = await getFirstIndexedBlock(client, chain, chainConfig.settings.index_partition_size);
        console.log(`First block search time: ${Number(process.hrtime.bigint() - tRef) / 1000000}ms`);
    }

    if (args.last) {
        lastBlock = parseInt(args.last, 10);
    } else {
        const tRef = process.hrtime.bigint();
        lastBlock = await getLastIndexedBlock(client, blockIndex);
        console.log(`Last block search time: ${Number(process.hrtime.bigint() - tRef) / 1000000}ms`);
    }

    const totalBlocks = lastBlock - firstBlock + 1;

    console.log('Range:', firstBlock, lastBlock);
    console.log('Total Blocks:', totalBlocks);

    // Wait for Elasticsearch indices to catch up
    console.log('⏳ Waiting for 5 seconds to allow Elasticsearch indices to catch up...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Parse and validate min-range-size parameter
    let minRangeSize = 1;
    if (args.minRangeSize) {
        minRangeSize = parseInt(args.minRangeSize, 10);
        if (isNaN(minRangeSize) || minRangeSize < 1) {
            console.log('❌ Invalid min-range-size parameter: must be a positive integer');
            process.exit(1);
        }
    }
    console.log('Minimum Range Size:', minRangeSize);

    // Validate the range size
    if (totalBlocks <= 0) {
        console.log('❌ Invalid block range: total blocks must be greater than 0');
        process.exit(1);
    }

    if (totalBlocks > 10000000) {
        console.log(`⚠️  Large range detected (${totalBlocks} blocks). This might take a very long time.`);
        console.log('Consider using --first and --last parameters to scan smaller ranges.');
    }

    // Determine the API base URL
    const apiBaseUrl = 'http://127.0.0.1:' + chainConfig.api.server_port;
    console.log(`Using Hyperion API: ${apiBaseUrl}`);

    // Test API connectivity first
    console.log('🔗 Testing API connectivity...');
    try {
        const testUrl = `${apiBaseUrl}/v2/health`;
        const testResponse = await fetch(testUrl);
        if (!testResponse.ok) {
            console.log(`❌ API connectivity test failed: ${testResponse.status} ${testResponse.statusText}`);
            console.log('Make sure Hyperion API is running and accessible.');
            process.exit(1);
        }
        console.log('✅ API connectivity test passed');
    } catch (error: any) {
        console.log(`❌ API connectivity test failed: ${error.message}`);
        console.log('Make sure Hyperion API is running and accessible.');
        process.exit(1);
    }

    const missingActionRanges: any[] = [];
    console.log(`\n🚀 Starting binary search for missing actions...`);

    console.log(`📊 Expected maximum API calls: ~${Math.ceil(Math.log2(totalBlocks)) * 2}`);

    if (minRangeSize > 1) {
        console.log(`⚡ Early stop optimization enabled: ranges ≤ ${minRangeSize} blocks will not be subdivided further`);
    }

    if (args.verbose) {
        console.log(`🔊 Verbose mode enabled: detailed logs for all ranges will be shown`);
    } else {
        console.log(`🔇 Quiet mode: detailed logs only for top-level ranges (use --verbose for full details)`);
    }

    // Progress tracking state
    const progressState = {
        totalMissingActions: 0,
        foundRanges: 0,
        apiCalls: 0,
        lastUpdate: Date.now(),
        searchComplete: false,
        verbose: args.verbose || false
    };

    // Get initial missing actions count
    console.log('\n🔍 Getting initial missing actions count...');
    try {
        const initialUrl = `${apiBaseUrl}/v2/stats/get_trx_count?start_block=${firstBlock}&end_block=${lastBlock}&validate_actions=true`;
        const initialResponse = await fetch(initialUrl);
        if (initialResponse.ok) {
            const initialData = await initialResponse.json();
            if (initialData.validation) {
                progressState.totalMissingActions = initialData.validation.missing_actions;
                console.log(`📊 Total missing actions to find: ${progressState.totalMissingActions.toLocaleString()}`);
            }
        }
    } catch (error) {
        console.log('⚠️  Could not get initial count, proceeding with search...');
    }

    console.log(`\n🔍 Starting detailed search...`);

    console.log(`Type: ${typeof firstBlock}, Value: ${firstBlock}`);
    console.log(`Type: ${typeof lastBlock}, Value: ${lastBlock}`);


    await searchMissingActions(apiBaseUrl, chain, firstBlock, lastBlock, totalBlocks, missingActionRanges, 0, minRangeSize, progressState);

    // Final progress update
    if (progressState) {
        const foundActions = missingActionRanges.reduce((sum, range) => sum + (range.missing_actions || range.count), 0);
        console.log(`\n✅ Search completed: ${progressState.apiCalls} API calls made | ${progressState.foundRanges} ranges found | ${foundActions.toLocaleString()} missing actions found`);
    }

    // console.table(missingActionRanges);

    if (missingActionRanges.length > 0) {
        // merge missing ranges
        const mergedRanges: any[] = [];
        let start = missingActionRanges[0].start;
        let end = missingActionRanges[0].end;
        for (let i = 1; i < missingActionRanges.length; i++) {
            if (missingActionRanges[i].start === end + 1) {
                end = missingActionRanges[i].end;
            } else {
                mergedRanges.push({ start, end, count: end - start + 1 });
                start = missingActionRanges[i].start;
                end = missingActionRanges[i].end;
            }
        }
        mergedRanges.push({ start, end, count: end - start + 1 });

        console.log(`\n📊 Summary:`);
        console.log(`Found ${mergedRanges.length} ranges with missing actions:`);

        let totalMissingActions = 0;
        mergedRanges.forEach((range, index) => {
            console.log(`  ${index + 1}. Blocks ${range.start}-${range.end} (${range.count} blocks)`);
            totalMissingActions += range.count;
        });

        console.log(`\nTotal blocks with missing actions: ${totalMissingActions}`);

        // Save results
        let outputPath = `.repair/${chain}-${firstBlock}-${lastBlock}-missing-actions.json`;
        if (args.outFile) {
            outputPath = args.outFile + '-missing-actions.json';
        }

        if (!existsSync('.repair')) {
            mkdirSync('.repair');
        }

        writeFileSync(outputPath, JSON.stringify(mergedRanges, null, 2));
        console.log(`\n💾 Results saved to: ${outputPath}`);
        console.log(`\n🔧 Run the following command to repair missing actions:`);
        console.log(`hyp-repair fill-missing ${chain} ${outputPath}`);
    } else {
        console.log('\n✅ No missing actions found! All transactions have corresponding actions indexed.');
    }

    const execTime = Number(process.hrtime.bigint() - tRef) / 1000000000;
    console.log(`\n⏱️  Total execution time: ${execTime.toFixed(2)}s`);
}

export async function searchMissingActions(
    apiBaseUrl: string,
    chain: string,
    firstBlock: number,
    lastBlock: number,
    totalBlocks: number,
    missingActionRanges: any[],
    depth: number = 0,
    minRangeSize: number = 1,
    progressState?: any
) {
    // Update progress tracking
    if (progressState) {
        progressState.apiCalls++;
        const now = Date.now();

        // Show progress every 5 seconds or every 20 API calls
        if (now - progressState.lastUpdate > 5000 || progressState.apiCalls % 20 === 0) {
            const foundActions = missingActionRanges.reduce((sum, range) => sum + (range.missing_actions || range.count), 0);
            const progressPercent = progressState.totalMissingActions > 0
                ? Math.min(100, (foundActions / progressState.totalMissingActions * 100))
                : 0;

            console.log(`📊 Progress: ${progressState.apiCalls} API calls | ${progressState.foundRanges} ranges found | ${foundActions.toLocaleString()} missing actions found ${progressState.totalMissingActions > 0 ? `(${progressPercent.toFixed(1)}%)` : ''}`);
            progressState.lastUpdate = now;
        }
    }

    // Base case: invalid range
    if (firstBlock > lastBlock) {
        return;
    }

    // Base case: range is smaller than minimum size threshold
    if (totalBlocks <= minRangeSize && totalBlocks > 1) {
        try {
            const url = `${apiBaseUrl}/v2/stats/get_trx_count?start_block=${firstBlock}&end_block=${lastBlock}&validate_actions=true`;
            const response = await fetch(url);

            if (!response.ok) {
                if (progressState?.verbose || depth <= 2) {
                    console.error(`❌ API error for range ${firstBlock}-${lastBlock}: ${response.status} ${response.statusText}`);
                }
                return;
            }

            const data = await response.json();

            if (!data.validation) {
                if (progressState?.verbose || depth <= 2) {
                    console.error(`❌ No validation data returned for range ${firstBlock}-${lastBlock}`);
                }
                return;
            }

            const { validation } = data;
            const missingActions = validation.missing_actions;

            if (missingActions > 0) {
                if (progressState) {
                    progressState.foundRanges++;
                }
                missingActionRanges.push({ start: firstBlock, end: lastBlock, count: totalBlocks, missing_actions: missingActions });
            }

        } catch (error: any) {
            if (progressState?.verbose || depth <= 2) {
                console.error(`❌ Error checking range ${firstBlock}-${lastBlock}:`, error.message);
            }
        }
        return;
    }

    // Base case: single block
    if (firstBlock === lastBlock) {
        try {
            const url = `${apiBaseUrl}/v2/stats/get_trx_count?start_block=${firstBlock}&end_block=${lastBlock}&validate_actions=true`;
            const response = await fetch(url);

            if (!response.ok) {
                if (progressState?.verbose || depth <= 2) {
                    console.error(`❌ API error for block ${firstBlock}: ${response.status} ${response.statusText}`);
                }
                return;
            }

            const data = await response.json();

            if (!data.validation) {
                if (progressState?.verbose || depth <= 2) {
                    console.error(`❌ No validation data returned for block ${firstBlock}`);
                }
                return;
            }

            const { validation } = data;
            const missingActions = validation.missing_actions;

            if (missingActions > 0) {
                if (progressState) {
                    progressState.foundRanges++;
                }
                missingActionRanges.push({ start: firstBlock, end: lastBlock, count: 1, missing_actions: missingActions });
            }

        } catch (error: any) {
            if (progressState?.verbose || depth <= 2) {
                console.error(`❌ Error checking block ${firstBlock}:`, error.message);
            }
        }
        return;
    }

    // Only show detailed logs for shallow depths to reduce verbosity (unless verbose mode is enabled)
    if (progressState?.verbose || depth <= 2) {
        console.log(`🔍 Checking range ${firstBlock}-${lastBlock} (${totalBlocks.toLocaleString()} blocks) [depth: ${depth}]...`);
    }

    try {
        // Call the validate_actions API
        const url = `${apiBaseUrl}/v2/stats/get_trx_count?start_block=${firstBlock}&end_block=${lastBlock}&validate_actions=true`;
        const response = await fetch(url);

        if (!response.ok) {
            if (progressState?.verbose || depth <= 2) {
                console.error(`❌ API error for range ${firstBlock}-${lastBlock}: ${response.status} ${response.statusText}`);
            }
            return;
        }

        const data = await response.json();

        if (!data.validation) {
            if (progressState?.verbose || depth <= 2) {
                console.error(`❌ No validation data returned for range ${firstBlock}-${lastBlock}`);
            }
            return;
        }

        const { validation } = data;
        const missingActions = validation.missing_actions;

        if (missingActions > 0) {
            if (progressState?.verbose || depth <= 2) {
                console.log(`⚠️  Found ${missingActions.toLocaleString()} missing actions in range ${firstBlock}-${lastBlock}`);
            }

            // Split the range in half for binary search
            const middleBlock = Math.floor((lastBlock + firstBlock) / 2);

            // Ensure we don't create overlapping ranges
            if (middleBlock >= firstBlock) {
                const leftRangeSize = middleBlock - firstBlock + 1;
                await searchMissingActions(
                    apiBaseUrl,
                    chain,
                    firstBlock,
                    middleBlock,
                    leftRangeSize,
                    missingActionRanges,
                    depth + 1,
                    minRangeSize,
                    progressState
                );
            }

            if (middleBlock + 1 <= lastBlock) {
                const rightRangeSize = lastBlock - middleBlock;
                await searchMissingActions(
                    apiBaseUrl,
                    chain,
                    middleBlock + 1,
                    lastBlock,
                    rightRangeSize,
                    missingActionRanges,
                    depth + 1,
                    minRangeSize,
                    progressState
                );
            }
        } else {
            if (progressState?.verbose || depth <= 2) {
                console.log(`✅ Range ${firstBlock}-${lastBlock} is valid (${validation.total_action_count.toLocaleString()} actions)`);
            }
        }

    } catch (error: any) {
        if (progressState?.verbose || depth <= 2) {
            console.error(`❌ Error checking range ${firstBlock}-${lastBlock}:`, error.message);
        }
    }
}
