import { Client } from '@elastic/elasticsearch';
import { APIClient } from "@wharfkit/antelope";
// @ts-ignore
import cliProgress from 'cli-progress';
import { HyperionBlock } from './interfaces.js';
import { getBlocks, getLastIndexedBlock, initESClient, readChainConfig, readConnectionConfig } from './functions.js';
import { getFirstIndexedBlock } from "../../indexer/helpers/common_functions.js";
import { printHeader, processResults } from './utils.js';

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
