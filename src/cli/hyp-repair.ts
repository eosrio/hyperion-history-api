import { Command } from 'commander';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Client, estypes } from '@elastic/elasticsearch';
// @ts-ignore
import cliProgress from 'cli-progress';
import { HyperionBlock } from './repair-cli/interfaces.js';
import {
    getBlocks,
    getLastIndexedBlock,
    initESClient,
    readChainConfig,
    readConnectionConfig,
} from './repair-cli/functions.js';

import { getFirstIndexedBlock } from "../indexer/helpers/common_functions.js";


import { WebSocket } from 'ws';
import { APIClient } from "@wharfkit/antelope";

const REPAIR_STATE_FILE = '.repair/fill-state.json';

const progressBar = new cliProgress.SingleBar(
    {},
    cliProgress.Presets.shades_classic
);
const program = new Command();
const errorRanges: any[] = [];
let pendingBlock: HyperionBlock | null = null;

let missingBlocks: {
    start: number;
    end: number;
    count: number;
}[] = [];

function askQuestion(query: string): Promise<string> {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}

async function run(
    client: Client,
    apiClient: APIClient,
    indexName: string,
    lastRequestedBlock: number,
    firstBlock: number,
    qtdTotal: any,
    loop: any = 1
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
            await findForksOnRange(blocks, apiClient);
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

async function findForksOnRange(blocks: HyperionBlock[], rpc: APIClient) {
    const removals: Set<string> = new Set();
    let start: number | null = null;
    let end: number | null = null;
    if (
        blocks.length > 0 &&
        pendingBlock &&
        blocks[0].block_num !== pendingBlock.block_num
    ) {
        blocks.unshift(pendingBlock);
    }

    let i = 0;
    for (const currentBlock of blocks) {
        const currentBlockNumber = currentBlock.block_num;
        // console.log('current -> ', currentBlockNumber);
        const previousBlock = blocks[i + 1];
        if (!previousBlock) {
            pendingBlock = currentBlock;
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

function processResults(chain, firstBlock, lastBlock, args) {
    if (errorRanges.length > 0 || missingBlocks.length > 0) {
        if (!existsSync('.repair')) {
            mkdirSync('.repair');
        }
    }

    if (errorRanges.length > 0) {
        let path = `.repair/${chain}-${firstBlock + 2}-${lastBlock}-forked-blocks.json`;
        if (args.outFile) {
            path = args.outFile + '-forked-blocks.json';
        }
        console.log(`Run the following command to repair forked blocks: \n\nhyp-repair repair ${chain} ${path}`);
        writeFileSync(path, JSON.stringify(errorRanges));
    }

    if (missingBlocks.length > 0) {
        let path = `.repair/${chain}-${firstBlock + 2
            }-${lastBlock}-missing-blocks.json`;
        if (args.outFile) {
            path = args.outFile + '-missing-blocks.json';
        }
        console.log(`Run the following command to repair missing blocks: \n\nhyp-repair fill-missing ${chain} ${path}`);
        writeFileSync(path, JSON.stringify(missingBlocks));
    }
}

async function scanChain(chain: string, args: any) {
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
    await run(client, apiClient, blockIndex, lastBlock, firstBlock, batchSize, numberOfBatches);
    console.log(`Finished checking forked blocks!`);

    processResults(chain, firstBlock, lastBlock, args);
}

async function repairMissing(chain: string, file: string, args: any) {
    const chainConfig = readChainConfig(chain);
    const config = readConnectionConfig();
    const client = initESClient(config);
    const ping = await client.ping();
    if (!ping) {
        console.log('Could not connect to ElasticSearch');
        process.exit();
    }

    let startFrom = 0;
    let targetFile = file;

    if (existsSync(REPAIR_STATE_FILE)) {
        try {
            const state = JSON.parse(readFileSync(REPAIR_STATE_FILE).toString());
            if (state.file) {
                console.log(`
Found a previous repair session for file ${state.file}.`);
                const answer = await askQuestion(`Do you want to resume from where you left off? (y/n) `);
                if (answer.toLowerCase() === 'y') {
                    console.log(`Resuming from line ${state.lastProcessedLine}.`);
                    targetFile = state.file;
                    startFrom = state.lastProcessedLine || 0;
                } else {
                    console.log('Starting a new repair session.');
                    unlinkSync(REPAIR_STATE_FILE);
                }
            }
        } catch (e) {
            console.log('Could not read state file, starting new session.');
            if (existsSync(REPAIR_STATE_FILE)) {
                unlinkSync(REPAIR_STATE_FILE);
            }
        }
    }
    await fillMissingBlocksFromFile(args.host, chain, targetFile, args.dry, startFrom);
}

async function repairChain(chain: string, file: string, args: any) {
    const chainConfig = readChainConfig(chain);
    const config = readConnectionConfig();
    const client = initESClient(config);
    const ping = await client.ping();
    if (!ping) {
        console.log('Could not connect to ElasticSearch');
        process.exit();
    }

    if (args.checkTasks) {
        const tasks = await client.tasks.list();
        if (tasks && tasks.nodes) {
            for (let node in tasks.nodes) {
                const nodeTasks = tasks.nodes[node].tasks;
                console.log(nodeTasks);
            }
        }
        process.exit(0);
    }

    const forkedBlocks = JSON.parse(readFileSync(file).toString());
    const blockIndex = `${chain}-block-${chainConfig.settings.index_version}`;
    let deleteBlocks = 0;
    let deleteActions = 0;
    let deleteDeltas = 0;
    let deleteAbis = 0;
    let deleteAccounts = 0;
    let deleteVoters = 0;
    let deleteProposals = 0;
    let deleteLinks = 0;
    let deletePermissions = 0;

    for (const range of forkedBlocks) {
        // ACTIONS
        const searchActions: any = {
            index: `${chain}-action-${chainConfig.settings.index_version}-*`,
            size: 0,
            track_total_hits: true,
            query: {
                bool: {
                    must: [
                        {
                            range: {
                                block_num: {
                                    lte: range.start,
                                    gte: range.end,
                                },
                            },
                        },
                    ],
                },
            },
        };

        if (args.dry) {
            const resultActions = await client.search<any>(searchActions);
            if (
                (resultActions.hits.total as estypes.SearchTotalHits)
                    ?.value > 0
            ) {
                deleteActions += (
                    resultActions.hits.total as estypes.SearchTotalHits
                )?.value;
            }
        } else {
            const indexExists = await client.indices.exists({
                index: searchActions.index,
            });

            if (indexExists) {
                delete searchActions.size;
                const deletedActionsResult = await client.deleteByQuery(
                    searchActions
                );
                if (
                    deletedActionsResult &&
                    deletedActionsResult.deleted &&
                    deletedActionsResult.deleted > 0
                ) {
                    deleteActions += deletedActionsResult.deleted;
                }
            } else {
                console.log(
                    `Index ${searchActions.index} doesn't exist. Unable to delete.`
                );
            }
        }

        // DELTAS
        const searchDeltas: any = {
            index: `${chain}-delta-${chainConfig.settings.index_version}-*`,
            size: 0,
            track_total_hits: true,
            query: {
                bool: {
                    must: [
                        {
                            range: {
                                block_num: {
                                    lte: range.start,
                                    gte: range.end,
                                },
                            },
                        },
                    ],
                },
            },
        };

        if (args.dry) {
            const resultDeltas = await client.search<any>(searchDeltas);
            if (
                (resultDeltas.hits.total as estypes.SearchTotalHits)
                    ?.value > 0
            ) {
                deleteDeltas += (
                    resultDeltas.hits.total as estypes.SearchTotalHits
                )?.value;
            }
        } else {
            const indexExists = await client.indices.exists({
                index: searchDeltas.index,
            });
            if (indexExists) {
                delete searchDeltas.size;
                const deletedDeltasResult = await client.deleteByQuery(
                    searchDeltas
                );
                if (
                    deletedDeltasResult &&
                    deletedDeltasResult.deleted &&
                    deletedDeltasResult.deleted > 0
                ) {
                    deleteDeltas += deletedDeltasResult.deleted;
                }
            } else {
                console.log(
                    `Index ${searchDeltas.index} doesn't exist. Unable to delete.`
                );
            }
        }

        // ABIS
        const searchAbis: any = {
            index: `${chain}-abi-${chainConfig.settings.index_version}`,
            size: 0,
            track_total_hits: true,
            query: {
                bool: {
                    must: [
                        {
                            range: {
                                block: { lte: range.start, gte: range.end },
                            },
                        },
                    ],
                },
            },
        };

        if (args.dry) {
            const resultAbis = await client.search<any>(searchAbis);
            if (
                (resultAbis.hits.total as estypes.SearchTotalHits)?.value >
                0
            ) {
                deleteAbis += (
                    resultAbis.hits.total as estypes.SearchTotalHits
                )?.value;
                console.log('ABIs', { lte: range.start, gte: range.end });
            }
        } else {
            const indexExists = await client.indices.exists({
                index: searchAbis.index,
            });
            if (indexExists) {
                delete searchAbis.size;
                const deletedAbisResult = await client.deleteByQuery(
                    searchAbis
                );
                if (
                    deletedAbisResult &&
                    deletedAbisResult.deleted &&
                    deletedAbisResult.deleted > 0
                ) {
                    deleteAbis += deletedAbisResult.deleted;
                }
            } else {
                console.log(
                    `Index ${searchAbis.index} doesn't exist. Unable to delete.`
                );
            }
        }

        // ACCOUNTS
        const searchAccounts: any = {
            index: `${chain}-table-accounts-${chainConfig.settings.index_version}`,
            size: 0,
            track_total_hits: true,
            query: {
                bool: {
                    must: [
                        {
                            range: {
                                block_num: {
                                    lte: range.start,
                                    gte: range.end,
                                },
                            },
                        },
                    ],
                },
            },
        };

        if (args.dry) {
            const resultAccounts = await client.search<any>(searchAccounts);
            if (
                (resultAccounts.hits.total as estypes.SearchTotalHits)
                    ?.value > 0
            ) {
                console.log(
                    '[WARNING]',
                    (resultAccounts.hits.total as estypes.SearchTotalHits)
                        ?.value,
                    'accounts needs to be updated'
                );
                deleteAccounts += (
                    resultAccounts.hits.total as estypes.SearchTotalHits
                )?.value;
            }
        } else {

            const indexExists = await client.indices.exists({
                index: searchAccounts.index,
            });

            if (indexExists) {
                delete searchAccounts.size;
                const deletedAccountsResult = await client.deleteByQuery(
                    searchAccounts
                );
                if (
                    deletedAccountsResult &&
                    deletedAccountsResult.deleted &&
                    deletedAccountsResult.deleted > 0
                ) {
                    deleteAccounts += deletedAccountsResult.deleted;
                }
            } else {
                console.log(
                    `Index ${searchAccounts.index} doesn't exist. Unable to delete.`
                );
            }
        }

        // VOTERS
        const searchVoters: any = {
            index: `${chain}-table-voters-${chainConfig.settings.index_version}`,
            size: 0,
            track_total_hits: true,
            query: {
                bool: {
                    must: [
                        {
                            range: {
                                block_num: {
                                    lte: range.start,
                                    gte: range.end,
                                },
                            },
                        },
                    ],
                },
            },
        };

        if (args.dry) {
            const resultVoters = await client.search<any>(searchVoters);
            if (
                (resultVoters.hits.total as estypes.SearchTotalHits)
                    ?.value > 0
            ) {
                console.log(
                    '[WARNING]',
                    (resultVoters.hits.total as estypes.SearchTotalHits)
                        ?.value,
                    'voters needs to be updated'
                );
                deleteVoters += (
                    resultVoters.hits.total as estypes.SearchTotalHits
                )?.value;
            }
        } else {
            const indexExists = await client.indices.exists({
                index: searchVoters.index,
            });

            if (indexExists) {

                delete searchVoters.size;
                const deletedVotersResult = await client.deleteByQuery(
                    searchVoters
                );
                if (
                    deletedVotersResult &&
                    deletedVotersResult.deleted &&
                    deletedVotersResult.deleted > 0
                ) {
                    deleteVoters += deletedVotersResult.deleted;
                }
            } else {
                console.log(
                    `Index ${searchVoters.index} doesn't exist. Unable to delete.`
                );
            }
        }

        // PROPOSALS
        const searchProposals: any = {
            index: `${chain}-table-proposals-${chainConfig.settings.index_version}`,
            size: 0,
            track_total_hits: true,
            query: {
                bool: {
                    must: [
                        {
                            range: {
                                block_num: {
                                    lte: range.start,
                                    gte: range.end,
                                },
                            },
                        },
                    ],
                },
            },
        };

        if (args.dry) {
            const resultProposals = await client.search<any>(searchProposals);
            if (
                (resultProposals.hits.total as estypes.SearchTotalHits)
                    ?.value > 0
            ) {
                console.log(
                    '[WARNING]',
                    (resultProposals.hits.total as estypes.SearchTotalHits)
                        ?.value,
                    'proposals needs to be updated'
                );
                deleteProposals += (
                    resultProposals.hits.total as estypes.SearchTotalHits
                )?.value;
            }
        } else {


            const indexExists = await client.indices.exists({ index: searchProposals.index });

            if (indexExists) {
                delete searchProposals.size;
                const deletedProposalsResult = await client.deleteByQuery(
                    searchProposals
                );
                if (
                    deletedProposalsResult &&
                    deletedProposalsResult.deleted &&
                    deletedProposalsResult.deleted > 0
                ) {
                    deleteProposals += deletedProposalsResult.deleted;
                }
            } else {
                console.log(`Index ${searchProposals.index} doesn't exist. Unable to delete.`);
            }
        }

        // LINKS
        const searchLinks: any = {
            index: `${chain}-link-${chainConfig.settings.index_version}`,
            size: 0,
            track_total_hits: true,
            query: {
                bool: {
                    must: [
                        {
                            range: {
                                block_num: {
                                    lte: range.start,
                                    gte: range.end,
                                },
                            },
                        },
                    ],
                },
            },
        };

        if (args.dry) {
            const resultLinks = await client.search<any>(searchLinks);
            if (
                (resultLinks.hits.total as estypes.SearchTotalHits)
                    ?.value > 0
            ) {
                console.log(
                    '[WARNING]',
                    (resultLinks.hits.total as estypes.SearchTotalHits)
                        ?.value,
                    'links needs to be updated'
                );
                deleteLinks += (
                    resultLinks.hits.total as estypes.SearchTotalHits
                )?.value;
            }
        } else {
            const indexExists = await client.indices.exists({ index: searchLinks.index });

            if (indexExists) {
                delete searchLinks.size;
                const deletedLinksResult = await client.deleteByQuery(searchLinks);
                if (
                    deletedLinksResult &&
                    deletedLinksResult.deleted &&
                    deletedLinksResult.deleted > 0
                ) {
                    deleteLinks += deletedLinksResult.deleted;
                }
            } else {
                console.log(`Index ${searchLinks.index} doesn't exist. Unable to delete.`);
            }
        }

        // PERMISSIONS
        const searchPermissions: any = {
            index: `${chain}-perm-${chainConfig.settings.index_version}`,
            size: 0,
            track_total_hits: true,
            query: {
                bool: {
                    must: [
                        {
                            range: {
                                block_num: {
                                    lte: range.start,
                                    gte: range.end,
                                },
                            },
                        },
                    ],
                },
            },
        };

        if (args.dry) {
            const resultPermissions = await client.search<any>(
                searchPermissions
            );
            if (
                (resultPermissions.hits.total as estypes.SearchTotalHits)
                    ?.value > 0
            ) {
                console.log(
                    '[WARNING]',
                    (
                        resultPermissions.hits
                            .total as estypes.SearchTotalHits
                    )?.value,
                    'permissions needs to be updated'
                );
                console.log({ lte: range.start, gte: range.end });
                deletePermissions += (
                    resultPermissions.hits.total as estypes.SearchTotalHits
                )?.value;
            }
        } else {

            const indexExists = await client.indices.exists({ index: searchPermissions.index });
            if (indexExists) {
                delete searchPermissions.size;
                const deletedPermissionsResult = await client.deleteByQuery(
                    searchPermissions
                );
                if (
                    deletedPermissionsResult &&
                    deletedPermissionsResult.deleted &&
                    deletedPermissionsResult.deleted > 0
                ) {
                    deletePermissions += deletedPermissionsResult.deleted;
                }
            } else {
                console.log(`Index ${searchPermissions.index} not present!`);
            }
        }

        if (!range.ids) {
            console.log("Invalid file format! Please check that you are calling the repair tool with the right file.");
            process.exit(1);
        }

        for (const id of range.ids) {
            const searchBlocks = {
                index: blockIndex,
                query: {
                    bool: { must: [{ term: { block_id: { value: id } } }] },
                },
            };
            if (args.dry) {
                console.log(`Deleting block ${id}...`);
                const resultBlocks = await client.search<HyperionBlock>(searchBlocks);
                if (
                    resultBlocks.hits.hits.length > 0 &&
                    resultBlocks.hits.hits[0]._source
                ) {
                    deleteBlocks++;
                }
            } else {
                const result = await client.deleteByQuery(searchBlocks);
                if (result && result.deleted && result.deleted > 0) {
                    deleteBlocks += result.deleted;
                }
            }
        }
    }

    if (args.dry) {
        console.log(
            `DRY-RUN: Would have deleted ${deleteBlocks} blocks, ${deleteActions} actions, ${deleteDeltas} deltas and ${deleteAbis} ABIs`
        );
        console.dir({
            blocks: deleteBlocks,
            actions: deleteActions,
            deltas: deleteDeltas,
            abis: deleteAbis,
            accounts: deleteAccounts,
            voters: deleteVoters,
            proposals: deleteProposals,
            links: deleteLinks,
            permissions: deletePermissions,
        });
    } else {
        console.log(
            `Deleted ${deleteBlocks} blocks, ${deleteActions} actions, ${deleteDeltas} deltas and ${deleteAbis} ABIs`
        );
    }
    await fillMissingBlocksFromFile(args.host, chain, file, args.dry);
}

async function fillMissingBlocksFromFile(host, chain, file, dryRun, startFrom = 0) {
    const config = readConnectionConfig();
    const controlPort = config.chains[chain].control_port;
    let hyperionIndexer = `ws://localhost:${controlPort}`;
    if (host) {
        hyperionIndexer = `ws://${host}:${controlPort}`;
    }
    const controller = new WebSocket(hyperionIndexer + '/local');

    let lastProcessedLine = startFrom;

    const saveState = () => {
        if (!existsSync('.repair')) {
            mkdirSync('.repair');
        }
        writeFileSync(REPAIR_STATE_FILE, JSON.stringify({
            file,
            lastProcessedLine
        }, null, 2));
        console.log(`\nProgress saved. Last processed line: ${lastProcessedLine}`);
        process.exit(0);
    };

    process.on('SIGINT', saveState);

    async function sendChunk(chunk): Promise<void> {
        return new Promise((resolve, reject) => {
            const payload = {
                event: 'fill_missing_blocks',
                data: chunk,
            };
            controller.send(JSON.stringify(payload));
            controller.once('message', (data) => {
                const parsed = JSON.parse(data.toString());
                if (parsed.event === 'repair_completed') {
                    resolve();
                } else if (parsed.event === 'error') {
                    reject(new Error(parsed.message));
                }
            });
        });
    }

    controller.on('open', async () => {
        console.log('Connected to Hyperion Controller');
        const parsedFile = JSON.parse(readFileSync(file).toString());
        // Chunk size
        const chunkSize = 5;
        const totalLines = parsedFile.length;

        if (startFrom >= totalLines && totalLines > 0) {
            console.log('File already processed.');
            if (existsSync(REPAIR_STATE_FILE)) {
                unlinkSync(REPAIR_STATE_FILE);
            }
            controller.close();
            return;
        }

        if (!dryRun) {
            let completedLines = startFrom;
            for (let i = startFrom; i < parsedFile.length; i += chunkSize) {
                const chunk = parsedFile.slice(i, i + chunkSize);
                // Send the chunk to the controller and wait for completion (repair_completed event)
                await sendChunk(chunk);

                lastProcessedLine = i + chunkSize;

                completedLines += chunk.length;
                const progress = (completedLines / totalLines) * 100;
                const progressBar = Array(Math.round(progress / 2))
                    .fill('#')
                    .join('');
                process.stdout.clearLine(0);
                process.stdout.cursorTo(0);
                process.stdout.write(
                    `Progress: [${progressBar}] ${progress.toFixed(2)}%`
                );
            }
            if (existsSync(REPAIR_STATE_FILE)) {
                unlinkSync(REPAIR_STATE_FILE);
            }
            console.log();
            controller.close();
        } else {
            console.log('Dry run, skipping repair');
            controller.close();
        }
    });

    const cleanup = () => {
        process.removeListener('SIGINT', saveState);
    };

    controller.on('close', () => {
        console.log('Disconnected from Hyperion Controller');
        cleanup();
    });

    controller.on('error', (err) => {
        console.log(err);
        cleanup();
    });
}

function viewFile(file: string) {
    const data = readFileSync(file, 'utf8');
    const parsed = JSON.parse(data);
    console.table(parsed);
}

function printHeader() {
    console.log(`
   __                             _                                            _              __              __
  / /   __ __   ___  ___   ____  (_) ___   ___        ____ ___    ___  ___ _  (_)  ____      / /_ ___  ___   / /
 / _ \\ / // /  / _ \\/ -_) / __/ / / / _ \\ / _ \\      / __// -_)  / _ \\/ _ \`/ / /  / __/     / __// _ \\/ _ \\ / / 
/_//_/ \\_, /  / .__/\\__/ /_/   /_/  \\___//_//_/     /_/   \\__/  / .__/\\_,_/ /_/  /_/        \\__/ \\___/\\___//_/  
      /___/  /_/                                               /_/                                              
`);
}

async function quickScanChain(chain: string, args: any) {
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

    await searchMissingBlocks(client, blockIndex, firstBlock, lastBlock, totalBlocks);

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
        missingBlocks = mergedRanges;
        const totalMissingBlocks = missingBlocks.reduce((acc, range) => acc + range.count, 0);
        console.log(`\n ⚠️  ⚠️  Found ${totalMissingBlocks} missing blocks between the range ${firstBlock} and ${lastBlock}`);
    } else {
        console.log(`\n 🎉 🎉 No missing blocks found between the range ${firstBlock} and ${lastBlock}`);
    }
    console.log(`\nTotal time: ${Number(process.hrtime.bigint() - tRef) / 1000000}ms`);

    processResults(chain, firstBlock, lastBlock, args);
}

async function searchMissingBlocks(client: Client,
    blockIndex: string,
    firstBlock: number,
    lastBlock: number,
    totalBlocks: number) {

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
        await searchMissingBlocks(client, blockIndex, leftRange.first, leftRange.last, middleBlock - firstBlock + 1);
        await searchMissingBlocks(client, blockIndex, rightRange.first, rightRange.last, lastBlock - middleBlock);
    }
}

// Commander Logic

program
    .name('Hyperion Repair CLI')
    .description('CLI to find and repair forked and missing blocks on Hyperion')
    .version('0.2.2');

program
    .command('scan <chain>')
    .description('scan for missing and forked blocks')
    .option('-o, --out-file <file>', 'forked-blocks.json output file')
    .option('-f, --first <number>', 'initial block to start validation')
    .option('-l, --last <number>', 'last block to validate')
    .option('-b, --batch <number>', 'batch size to process')
    .action(scanChain);

program
    .command('quick-scan <chain>')
    .description('scan for missing blocks using binary tree search')
    .action(quickScanChain);

program
    .command('repair <chain> <file>')
    .description('repair forked blocks')
    .option('-h, --host <host>', 'Hyperion local control api')
    .option('-d, --dry', 'dry-run, do not delete or repair blocks')
    .option('-t, --check-tasks', 'check for running tasks')
    .action(repairChain);

program
    .command('fill-missing <chain> <file>')
    .description('write missing blocks')
    .option('-h, --host <host>', 'Hyperion local control api')
    .option('-d, --dry', 'dry-run, do not delete or repair blocks')
    .action(repairMissing);

program
    .command('view <file>')
    .description('view forked blocks')
    .action(viewFile);

program
    .command('connect')
    .option('-h, --host <host>', 'Hyperion local control api')
    .action(async (args) => {
        let hyperionIndexer = 'ws://localhost:4321';
        let valid = false;
        if (args.host) {
            hyperionIndexer = args.host;
        }
        try {
            const controller = new WebSocket(hyperionIndexer + '/local');
            controller.on('open', () => {
                valid = true;
                controller.close();
            });
            controller.on('close', () => {
                if (valid) {
                    console.log(
                        `✅  Hyperion Indexer Online - ${hyperionIndexer}`
                    );
                }
            });
            controller.on('error', (err) => {
                console.log('Error:', err.message);
                console.log(
                    `Failed to connect on Hyperion Indexer at ${hyperionIndexer}, please use "--host ws://ADDRESS:PORT" to specify a remote indexer connection`
                );
            });
        } catch (e) {
            console.log(e);
        }
    });

program.parse();
