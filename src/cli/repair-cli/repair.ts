import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { Client, estypes } from '@elastic/elasticsearch';
import { WebSocket } from 'ws';
import { HyperionBlock } from './interfaces.js';
import { initESClient, readChainConfig, readConnectionConfig } from './functions.js';
import { askQuestion, preprocessRanges } from './utils.js';
import { monitorBlockQueues } from './monitor.js';

const REPAIR_STATE_FILE = '.repair/fill-state.json';

export async function repairMissing(chain: string, file: string, args: any) {
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
            const sessions = JSON.parse(readFileSync(REPAIR_STATE_FILE).toString());
            const state = sessions[chain];
            if (state && state.file) {
                const resumeFile = state.file;
                const resumeLine = state.lastProcessedLine || 0;
                const parsedFile = JSON.parse(readFileSync(resumeFile).toString());

                const chainConfig = readChainConfig(chain);
                const batchSize = chainConfig.scaling?.batch_size || 200;
                const preprocessedFile = preprocessRanges(parsedFile, batchSize);

                const nextBlockRange = preprocessedFile[resumeLine];

                if (nextBlockRange) {
                    console.log(`
Found a previous repair session for file ${resumeFile}.`);
                    const answer = await askQuestion(
`Last session was stopped at line ${resumeLine}.
The next blocks to be processed are from ${nextBlockRange.start} to ${nextBlockRange.end}.
Do you want to resume from where you left off? (y/n) `
                    );
                    if (answer.toLowerCase() === 'y') {
                        console.log(`Resuming from line ${resumeLine}.`);
                        targetFile = resumeFile;
                        startFrom = resumeLine;
                    } else {
                        console.log('Starting a new repair session.');
                        delete sessions[chain];
                        if (Object.keys(sessions).length > 0) {
                            writeFileSync(REPAIR_STATE_FILE, JSON.stringify(sessions, null, 2));
                        } else {
                            unlinkSync(REPAIR_STATE_FILE);
                        }
                    }
                } else {
                    console.log('Previous repair session seems to be complete. Starting fresh.');
                    delete sessions[chain];
                    if (Object.keys(sessions).length > 0) {
                        writeFileSync(REPAIR_STATE_FILE, JSON.stringify(sessions, null, 2));
                    } else {
                        unlinkSync(REPAIR_STATE_FILE);
                    }
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

export async function repairChain(chain: string, file: string, args: any) {
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

export async function fillMissingBlocksFromFile(host: any, chain: string, file: string, dryRun: boolean, startFrom = 0) {
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
        let sessions = {};
        if (existsSync(REPAIR_STATE_FILE)) {
            try {
                sessions = JSON.parse(readFileSync(REPAIR_STATE_FILE).toString());
            } catch (e) {
                // ignore if file is malformed, it will be overwritten
            }
        }
        sessions[chain] = {
            file,
            lastProcessedLine
        };
        writeFileSync(REPAIR_STATE_FILE, JSON.stringify(sessions, null, 2));
        console.log(`
Progress saved. Last processed line: ${lastProcessedLine}`);
        process.exit(0);
    };

    process.on('SIGINT', saveState);

    async function sendChunk(chunk: any): Promise<void> {
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

        const chainConfig = readChainConfig(chain);
        const batchSize = chainConfig.scaling?.batch_size || 200;
        const preprocessedFile = preprocessRanges(parsedFile, batchSize);

        // Chunk size
        const chunkSize = 5;
        const totalLines = preprocessedFile.length;
        const sessionStartTime = Date.now();

        const totalBlocks = preprocessedFile.reduce((acc, range) => acc + range.count, 0);
        let processedBlocks = 0;
        if (startFrom > 0) {
            processedBlocks = preprocessedFile.slice(0, startFrom).reduce((acc, range) => acc + range.count, 0);
        }
        const initialProcessedBlocks = processedBlocks;

        if (startFrom >= totalLines && totalLines > 0) {
            console.log('File already processed.');
            if (existsSync(REPAIR_STATE_FILE)) {
                let sessions = {};
                try {
                    sessions = JSON.parse(readFileSync(REPAIR_STATE_FILE).toString());
                    delete sessions[chain];
                    if (Object.keys(sessions).length > 0) {
                        writeFileSync(REPAIR_STATE_FILE, JSON.stringify(sessions, null, 2));
                    } else {
                        unlinkSync(REPAIR_STATE_FILE);
                    }
                } catch (e) {
                    unlinkSync(REPAIR_STATE_FILE);
                }
            }
            controller.close();
            return;
        }

        if (!dryRun) {
            for (let i = startFrom; i < preprocessedFile.length; i += chunkSize) {
                const chunk = preprocessedFile.slice(i, i + chunkSize);
                // Send the chunk to the controller and wait for completion (repair_completed event)
                await sendChunk(chunk);

                lastProcessedLine = i + chunkSize;

                const blocksInChunk = chunk.reduce((acc, range) => acc + range.count, 0);
                processedBlocks += blocksInChunk;

                const elapsedMs = Date.now() - sessionStartTime;
                const blocksProcessedInSession = processedBlocks - initialProcessedBlocks;
                let etc = '...';

                if (blocksProcessedInSession > 0 && elapsedMs > 0) {
                    const msPerBlock = elapsedMs / blocksProcessedInSession;
                    const remainingBlocks = totalBlocks - processedBlocks;
                    const etcMs = remainingBlocks * msPerBlock;
                    etc = new Date(etcMs).toISOString().substr(11, 8);
                }

                const progress = (processedBlocks / totalBlocks) * 100;
                const progressBar = Array(Math.round(progress / 2))
                    .fill('#')
                    .join('');
                process.stdout.clearLine(0);
                process.stdout.cursorTo(0);
                process.stdout.write(
                    `Progress: [${progressBar}] ${progress.toFixed(2)}% | ETC: ${etc}`
                );
            }
            if (existsSync(REPAIR_STATE_FILE)) {
                let sessions = {};
                try {
                    sessions = JSON.parse(readFileSync(REPAIR_STATE_FILE).toString());
                    delete sessions[chain];
                    if (Object.keys(sessions).length > 0) {
                        writeFileSync(REPAIR_STATE_FILE, JSON.stringify(sessions, null, 2));
                    } else {
                        unlinkSync(REPAIR_STATE_FILE);
                    }
                } catch (e) {
                    unlinkSync(REPAIR_STATE_FILE);
                }
            }
            console.log();
            controller.close();
            await monitorBlockQueues(chain);
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
