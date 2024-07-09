import {Command} from 'commander';
import {readFileSync} from 'node:fs';
import {Client, estypes} from '@elastic/elasticsearch';
// @ts-ignore
import cliProgress from 'cli-progress';
import {JsonRpc} from 'eosjs';
import {existsSync, mkdirSync, writeFileSync} from 'fs';
import {HyperionBlock} from './repair-cli/interfaces.js';
import {
    getBlocks,
    getFirstIndexedBlock,
    getLastIndexedBlock,
    initESClient,
    readChainConfig,
    readConnectionConfig,
} from './repair-cli/functions.js';

import {WebSocket} from 'ws';
import {SearchResponse} from "@elastic/elasticsearch/lib/api/types";

const progressBar = new cliProgress.SingleBar(
    {},
    cliProgress.Presets.shades_classic
);
const program = new Command();
const errorRanges: any[] = [];
let pendingBlock: HyperionBlock | null = null;

const missingBlocks: {
    start: number;
    end: number;
}[] = [];

async function run(
    client: Client,
    rpc: JsonRpc,
    indexName: string,
    blockInit: number,
    firstBlock: number,
    qtdTotal: any,
    loop: any = 1
) {
    let blockInitial = blockInit;
    let blockFinal = blockInitial - qtdTotal;
    const tRef = process.hrtime.bigint();
    progressBar.start(loop, 0);
    for (let i: any = 1; i <= loop; i++) {
        if (blockFinal < firstBlock) {
            blockFinal = firstBlock;
        }
        try {
            let {body} = await getBlocks(
                client,
                indexName,
                blockInitial,
                blockFinal,
                qtdTotal
            );
            let {
                hits: {hits},
            } = body;
            const blocks = hits.map((obj: any) => obj._source);
            await findForksOnRange(blocks, rpc);
            blockInitial = blockFinal;
            blockFinal = blockInitial - qtdTotal;
            progressBar.update(i);
        } catch (e: any) {
            console.log('Error: ', e);
            process.exit(1);
        }
    }
    progressBar.stop();
    console.log('=========== Forked Ranges ===========');
    console.table(errorRanges);
    console.log('=========== Missing Ranges ==========');
    console.table(missingBlocks);
    const tDiff = Number(process.hrtime.bigint() - tRef) / 1000000;
    console.log(`Total time: ${Math.round(tDiff / 1000)}s`);
}

async function findForksOnRange(blocks: HyperionBlock[], rpc: JsonRpc) {
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
            console.log(
                `\nBlock number mismatch, expected: ${
                    currentBlockNumber - 1
                } got ${previousBlock.block_num}`
            );
            missingBlocks.push({
                start: previousBlock.block_num + 1,
                end: currentBlockNumber - 1,
            });
            continue;
        }

        if (previousBlock && previousBlock.block_id !== currentBlock.prev_id) {
            if (start === null) {
                start = currentBlockNumber - 1;
                const blockData = await rpc.get_block_info(start);
                if (blockData && blockData.id !== previousBlock.block_id) {
                    removals.add(previousBlock.block_id);
                }
            }
        } else {
            if (start) {
                const blockData = await rpc.get_block_info(currentBlockNumber);
                if (blockData) {
                    if (blockData.id !== currentBlock.block_id) {
                        removals.add(currentBlock.block_id);
                    } else {
                        end = currentBlockNumber + 1;
                        const range = {start, end, ids: [...removals]};
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

async function scanChain(chain: string, args: any) {
    const chainConfig = readChainConfig(chain);

    console.log(chainConfig.settings.index_version);

    const config = readConnectionConfig();

    const client = initESClient(config);

    const jsonRpc = new JsonRpc(config.chains[chain].http, {fetch});

    const ping = await client.ping();

    if (!ping) {
        console.log('Could not connect to ElasticSearch');
        process.exit();
    }

    const blockIndex = `${chain}-block-${chainConfig.settings.index_version}`;

    let firstBlock;
    let lastBlock;

    if (args.first) {
        // reduce by 2 to account for the fork end validation
        firstBlock = args.first - 2;
    } else {
        firstBlock = await getFirstIndexedBlock(client, blockIndex);
    }

    if (args.last) {
        lastBlock = args.last;
    } else {
        lastBlock = await getLastIndexedBlock(client, blockIndex);
    }

    const totalBlocks = lastBlock - firstBlock;

    let batchSize = 1000;
    if (args.batch) {
        batchSize = args.batch;
    }

    const numberOfBatches = Math.ceil(totalBlocks / batchSize);

    console.log('Range:', firstBlock, lastBlock);
    console.log('Total Blocks:', totalBlocks);
    console.log('Batch Size:', batchSize);
    console.log('Number of Batches:', numberOfBatches);

    await run(
        client,
        jsonRpc,
        blockIndex,
        lastBlock,
        firstBlock,
        batchSize,
        numberOfBatches
    );
    console.log(`Finished checking forked blocks!`);

    if (errorRanges.length > 0 || missingBlocks.length > 0) {
        if (!existsSync('.repair')) {
            mkdirSync('.repair');
        }
    }

    if (errorRanges.length > 0) {
        let path = `.repair/${chain}-${
            firstBlock + 2
        }-${lastBlock}-forked-blocks.json`;
        if (args.outFile) {
            path = args.outFile + '-forked-blocks.json';
        }
        writeFileSync(path, JSON.stringify(errorRanges));
    }

    if (missingBlocks.length > 0) {
        let path = `.repair/${chain}-${
            firstBlock + 2
        }-${lastBlock}-missing-blocks.json`;
        if (args.outFile) {
            path = args.outFile + '-missing-blocks.json';
        }
        writeFileSync(path, JSON.stringify(missingBlocks));
    }
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
    await fillMissingBlocksFromFile(args.host, chain, file, args.dry);
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
                                block: {lte: range.start, gte: range.end},
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
                console.log('ABIs', {lte: range.start, gte: range.end});
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


            const indexExists = await client.indices.exists({index: searchProposals.index});

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
            const indexExists = await client.indices.exists({index: searchLinks.index});

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
                console.log({lte: range.start, gte: range.end});
                deletePermissions += (
                    resultPermissions.hits.total as estypes.SearchTotalHits
                )?.value;
            }
        } else {

            const indexExists = await client.indices.exists({index: searchPermissions.index});
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
                console.log(`Index ${searchPermissions.index} doens't exist. Não foi possível realizar a exclusão.`);
            }
        }

        for (const id of range.ids) {
            const searchBlocks = {
                index: blockIndex,
                query: {
                    bool: {must: [{term: {block_id: {value: id}}}]},
                },
            };
            if (args.dry) {
                console.log(`Deleting block ${id}...`);
                const resultBlocks = await client.search<
                    SearchResponse<HyperionBlock>
                >(searchBlocks);
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

async function fillMissingBlocksFromFile(host, chain, file, dryRun) {
    const config = readConnectionConfig();
    const controlPort = config.chains[chain].control_port;
    let hyperionIndexer = `ws://localhost:${controlPort}`;
    if (host) {
        hyperionIndexer = `ws://${host}:${controlPort}`;
    }
    const controller = new WebSocket(hyperionIndexer + '/local');

    // Function to send Chunk
    async function sendChunk(chunk): Promise<void> {
        return new Promise((resolve, reject) => {
            const payload = {
                event: 'fill_missing_blocks',
                data: chunk,
            };
            controller.send(JSON.stringify(payload));

            // Wait repair_completed confirmation
            controller.once('message', (data) => {
                const parsed = JSON.parse(data.toString());
                if (parsed.event === 'repair_completed') {
                    // console.log(`Hyperion repair completed for chunk!`);
                    resolve();
                }
            });
        });
    }

    controller.on('open', async () => {
        console.log('Connected to Hyperion Controller');
        const parsedFile = JSON.parse(readFileSync(file).toString());
        const chunkSize = 20; // Chunk size
        const totalLines = parsedFile.length;

        if (!dryRun) {
            let completedLines = 0;

            for (let i = 0; i < parsedFile.length; i += chunkSize) {
                const chunk = parsedFile.slice(i, i + chunkSize);
                await sendChunk(chunk);

                // Atualizar o progresso com base no número total de linhas
                completedLines += chunk.length;
                const progress = (completedLines / totalLines) * 100;
                const progressBar = Array(Math.round(progress / 2))
                    .fill('#')
                    .join('');
                process.stdout.clearLine(0); // Limpar a linha anterior
                process.stdout.cursorTo(0); // Mover o cursor para o início da linha
                process.stdout.write(
                    `Progress: [${progressBar}] ${progress.toFixed(2)}%`
                );
            }
            console.log(); // Pule para a próxima linha após a conclusão
            controller.close();
        } else {
            console.log('Dry run, skipping repair');
            controller.close();
        }
    });

    controller.on('close', () => {
        console.log('Disconnected from Hyperion Controller');
    });

    controller.on('error', (err) => {
        console.log(err);
    });
}

function viewFile(file: string) {
    const data = readFileSync(file, 'utf8');
    const parsed = JSON.parse(data);
    console.table(parsed);
}

// Commander Logic

program
    .name('Hyperion Repair CLI')
    .description('CLI to find and repair forked and missing blocks on Hyperion')
    .version('0.2.2');

program
    .command('scan <chain>')
    .description('scan for forked blocks')
    .option('-d, --dry', 'dry-run, do not delete or repair blocks')
    .option('-o, --out-file <file>', 'forked-blocks.json output file')
    .option('-f, --first <number>', 'initial block to start validation')
    .option('-l, --last <number>', 'last block to validate')
    .option('-b, --batch <number>', 'batch size to process')
    .action(scanChain);

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
