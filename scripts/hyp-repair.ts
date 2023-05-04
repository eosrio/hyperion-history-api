import {Command} from 'commander';
import {readFileSync} from "node:fs";
import {Client, estypes} from "@elastic/elasticsearch";
// @ts-ignore
import cliProgress from "cli-progress";
import {JsonRpc} from 'eosjs';
import fetch from 'cross-fetch';
import {existsSync, mkdirSync, writeFileSync} from "fs";
import {HyperionBlock} from "./repair-cli/interfaces.js";
import {
    getBlocks,
    getFirstIndexedBlock,
    getLastIndexedBlock,
    initESClient,
    readChainConfig,
    readConnectionConfig
} from "./repair-cli/functions.js";
import {SearchResponse} from "@elastic/elasticsearch/api/types";

import {WebSocket} from 'ws';

const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
const program = new Command();
const errorRanges: any[] = [];
let pendingBlock: HyperionBlock | null = null;

const missingBlocks: {
    start: number,
    end: number
}[] = [];

async function run(client: Client, rpc: JsonRpc, indexName: string, blockInit: number, firstBlock: number, qtdTotal: any, loop: any = 1) {
    let blockInicial = blockInit;
    let blockFinal = blockInicial - qtdTotal;
    const tRef = process.hrtime.bigint();
    progressBar.start(loop, 0);
    for (let i: any = 1; i <= loop; i++) {
        if (blockFinal < firstBlock) {
            blockFinal = firstBlock;
        }
        try {
            let {body} = await getBlocks(client, indexName, blockInicial, blockFinal, qtdTotal);
            let {hits: {hits}} = body;
            const blocks = hits.map((obj: any) => obj._source);
            // Procurar Range
            await findForksOnRange(blocks, rpc);
            blockInicial = blockFinal;
            blockFinal = blockInicial - qtdTotal;
            progressBar.update(i);
        } catch (e: any) {
            console.log("Error: ", e.message);
            process.exit(1);
        }
    }

    progressBar.stop();

    console.log("=========== Forked Ranges ===========");
    console.table(errorRanges);
    console.log("======================");
    console.log("Missing Blocks: ", missingBlocks);

    // log total time in milliseconds
    const tDiff = Number(process.hrtime.bigint() - tRef) / 1000000;
    console.log(`Total time: ${tDiff}ms`);
}

async function findForksOnRange(blocks: HyperionBlock[], rpc: JsonRpc) {
    const removals: Set<string> = new Set();
    let start = null;
    let end = null;

    if (pendingBlock) {
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
            console.log(`Block number mismatch, expected: ${currentBlockNumber - 1} got ${previousBlock.block_num}`);
            missingBlocks.push({
                start: previousBlock.block_num + 1,
                end: currentBlockNumber - 1
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
                console.log(start, blockData.block_num);
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

    console.log("Range:", firstBlock, lastBlock);
    console.log("Total Blocks:", totalBlocks);
    console.log("Batch Size:", batchSize);
    console.log("Number of Batches:", numberOfBatches);

    await run(client, jsonRpc, blockIndex, lastBlock, firstBlock, batchSize, numberOfBatches);
    console.log(`Finished checking forked blocks!`);

    if (errorRanges.length > 0 || missingBlocks.length > 0) {
        if (!existsSync('.repair')) {
            mkdirSync('.repair');
        }
    }

    if (errorRanges.length > 0) {
        let path = `.repair/${chain}-${firstBlock}-${lastBlock}-forked-blocks.json`;
        if (args.path) {
            path = args.path + '-forked-blocks.json';
        }
        writeFileSync(path, JSON.stringify(errorRanges));
    }

    if (missingBlocks.length > 0) {
        let path = `.repair/${chain}-${firstBlock}-${lastBlock}-missing-blocks.json`;
        if (args.path) {
            path = args.path + '-missing-blocks.json';
        }
        writeFileSync(path, JSON.stringify(missingBlocks));
    }
}

async function repairMissing(chain: string, file: string, args: any) {
    console.log(chain, file, args);
    const chainConfig = readChainConfig(chain);
    console.log(chainConfig.settings.index_version);
    const config = readConnectionConfig();
    const client = initESClient(config);
    const ping = await client.ping();
    if (!ping) {
        console.log('Could not connect to ElasticSearch');
        process.exit();
    }

    let hyperionIndexer = 'ws://localhost:4321';
    if (args.host) {
        hyperionIndexer = args.host;
    }
    const controller = new WebSocket(hyperionIndexer + '/local');

    controller.on('open', async () => {
        console.log('Connected to Hyperion Controller');
        const missingBlocks = JSON.parse(readFileSync(file).toString());
        console.log(missingBlocks);
        const payload = {
            "event": "fill_missing_blocks",
            "data": missingBlocks
        };
        controller.send(JSON.stringify(payload));
    });
    controller.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        console.log(parsed);
    });
    controller.on('close', () => {
        console.log('Disconnected from Hyperion Controller');
    });
    controller.on('error', (err) => {
        console.log(err);
    });
}

async function repairChain(chain: string, file: string, args: any) {
    console.log(chain, file, args);
    const chainConfig = readChainConfig(chain);
    console.log(chainConfig.settings.index_version);
    const config = readConnectionConfig();
    const client = initESClient(config);
    const ping = await client.ping();
    if (!ping) {
        console.log('Could not connect to ElasticSearch');
        process.exit();
    }
    const forkedBlocks = JSON.parse(readFileSync(file).toString());
    const blockIndex = `${chain}-block-${chainConfig.settings.index_version}`;
    let deleteBlocks = 0;
    let deleteActions = 0;
    let deleteDeltas = 0;
    let deleteAbis = 0;

    for (const range of forkedBlocks) {

        // ACTIONS
        const searchActions = {
            index: `${chain}-action-${chainConfig.settings.index_version}-*`,
            size: 0,
            track_total_hits: true,
            body: {
                query: {
                    bool: {
                        must: [{range: {block_num: {lte: range.start, gte: range.end}}}]
                    }
                }
            }
        };

        if (args.dry) {
            const resultActions = await client.search<any>(searchActions);
            if ((resultActions.body.hits.total as estypes.SearchTotalHits)?.value > 0) {
                deleteActions += (resultActions.body.hits.total as estypes.SearchTotalHits)?.value;
            }
        } else {
            const deletedActionsResult = await client.deleteByQuery(searchActions);
            console.log(deletedActionsResult);
        }

        // DELTAS
        const searchDeltas = {
            index: `${chain}-delta-${chainConfig.settings.index_version}-*`,
            size: 0,
            track_total_hits: true,
            body: {
                query: {
                    bool: {
                        must: [{range: {block_num: {lte: range.start, gte: range.end}}}]
                    }
                }
            }
        }

        if (args.dry) {
            const resultDeltas = await client.search<any>(searchDeltas);
            if ((resultDeltas.body.hits.total as estypes.SearchTotalHits)?.value > 0) {
                deleteDeltas += (resultDeltas.body.hits.total as estypes.SearchTotalHits)?.value;
            }
        } else {
            const deletedDeltasResult = await client.deleteByQuery(searchDeltas);
            console.log(deletedDeltasResult);
        }

        // ABIS
        const searchAbis = {
            index: `${chain}-abi-${chainConfig.settings.index_version}`,
            size: 0,
            track_total_hits: true,
            body: {
                query: {
                    bool: {
                        must: [{range: {block: {lte: range.start, gte: range.end}}}]
                    }
                }
            }
        }

        if (args.dry) {
            const resultAbis = await client.search<any>(searchAbis);
            if ((resultAbis.body.hits.total as estypes.SearchTotalHits)?.value > 0) {
                deleteAbis += (resultAbis.body.hits.total as estypes.SearchTotalHits)?.value;
                console.log('ABIs', {lte: range.start, gte: range.end});
            }
        } else {
            const deletedAbisResult = await client.deleteByQuery(searchAbis);
            if (deletedAbisResult && deletedAbisResult.body.deleted && deletedAbisResult.body.deleted > 0) {
                deleteAbis += deletedAbisResult.body.deleted;
            }
        }

        // ACCOUNTS
        const searchAccounts = {
            index: `${chain}-table-accounts-${chainConfig.settings.index_version}`,
            size: 10000,
            track_total_hits: true,
            body: {
                query: {
                    bool: {
                        must: [{range: {block_num: {lte: range.start, gte: range.end}}}]
                    }
                }
            }
        }

        if (args.dry) {
            const resultAccounts = await client.search<any>(searchAccounts);
            if ((resultAccounts.body.hits.total as estypes.SearchTotalHits)?.value > 0) {
                console.log('[WARNING]', (resultAccounts.body.hits.total as estypes.SearchTotalHits)?.value, 'accounts needs to be updated');
                console.log({lte: range.start, gte: range.end});
            }
        }

        // VOTERS
        const searchVoters = {
            index: `${chain}-table-voters-${chainConfig.settings.index_version}`,
            size: 10000,
            track_total_hits: true,
            body: {
                query: {
                    bool: {
                        must: [{range: {block_num: {lte: range.start, gte: range.end}}}]
                    }
                }
            }
        }

        if (args.dry) {
            const resultVoters = await client.search<any>(searchVoters);
            if ((resultVoters.body.hits.total as estypes.SearchTotalHits)?.value > 0) {
                console.log('[WARNING]', (resultVoters.body.hits.total as estypes.SearchTotalHits)?.value, 'voters needs to be updated');
                console.log({lte: range.start, gte: range.end});
            }
        }

        // PROPOSALS
        const searchProposals = {
            index: `${chain}-table-proposals-${chainConfig.settings.index_version}`,
            size: 10000,
            track_total_hits: true,
            body: {
                query: {
                    bool: {
                        must: [{range: {block_num: {lte: range.start, gte: range.end}}}]
                    }
                }
            }
        }

        if (args.dry) {
            const resultProposals = await client.search<any>(searchProposals);
            if ((resultProposals.body.hits.total as estypes.SearchTotalHits)?.value > 0) {
                console.log('[WARNING]', (resultProposals.body.hits.total as estypes.SearchTotalHits)?.value, 'proposals needs to be updated');
                console.log({lte: range.start, gte: range.end});
            }
        }

        // LINKS
        const searchLinks = {
            index: `${chain}-link-${chainConfig.settings.index_version}`,
            size: 10000,
            track_total_hits: true,
            body: {
                query: {
                    bool: {
                        must: [{range: {block_num: {lte: range.start, gte: range.end}}}]
                    }
                }
            }
        }

        if (args.dry) {
            const resultLinks = await client.search<any>(searchLinks);
            if ((resultLinks.body.hits.total as estypes.SearchTotalHits)?.value > 0) {
                console.log('[WARNING]', (resultLinks.body.hits.total as estypes.SearchTotalHits)?.value, 'links needs to be updated');
                console.log({lte: range.start, gte: range.end});
            }
        }

        // PERMISSIONS
        const searchPermissions = {
            index: `${chain}-perm-${chainConfig.settings.index_version}`,
            size: 10000,
            track_total_hits: true,
            body: {
                query: {
                    bool: {
                        must: [{range: {block_num: {lte: range.start, gte: range.end}}}]
                    }
                }
            }
        }

        if (args.dry) {
            const resultPermissions = await client.search<any>(searchPermissions);
            if ((resultPermissions.body.hits.total as estypes.SearchTotalHits)?.value > 0) {
                console.log('[WARNING]', (resultPermissions.body.hits.total as estypes.SearchTotalHits)?.value, 'permissions needs to be updated');
                console.log({lte: range.start, gte: range.end});
            }
        }

        for (const id of range.ids) {
            const searchBlocks = {
                index: blockIndex,
                body: {
                    query: {bool: {must: [{term: {block_id: {value: id}}}]}}
                }
            };
            if (args.dry) {
                const resultBlocks = await client.search<SearchResponse<HyperionBlock>>(searchBlocks);
                if (resultBlocks.body.hits.hits[0]._source) {
                    deleteBlocks++;
                }
            } else {
                const result = await client.deleteByQuery(searchBlocks);
            }
        }
    }

    if (args.dry) {
        console.log(`DRY-RUN: Would have deleted ${deleteBlocks} blocks, ${deleteActions} actions, ${deleteDeltas} deltas and ${deleteAbis} ABIs`);
    } else {
        console.log(`Deleted ${deleteBlocks} blocks, ${deleteActions} actions, ${deleteDeltas} deltas and ${deleteAbis} ABIs`);
    }
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
    .version('0.2.1');


program.command('scan <chain>')
    .description('scan for forked blocks')
    .option('-d, --dry', 'dry-run, do not delete or repair blocks')
    .option('-o, --out-file <file>', 'forked-blocks.json output file')
    .option('-f, --first <number>', 'initial block to start validation')
    .option('-l, --last <number>', 'last block to validate')
    .option('-b, --batch <number>', 'batch size to process')
    .action(scanChain);

program.command('repair <chain> <file>')
    .description('repair forked blocks')
    .option('-d, --dry', 'dry-run, do not delete or repair blocks')
    .action(repairChain);

program.command('fill-missing <chain> <file>')
    .description('write missing blocks')
    .option('-d, --dry', 'dry-run, do not delete or repair blocks')
    .action(repairMissing);

program.command('view <file>')
    .description('view forked blocks')
    .action(viewFile);

program.command('connect')
    .option('-h, --host <host>', 'Hyperion local control api')
    .action(async (args) => {
        let hyperionIndexer = 'ws://localhost:4321';
        if (args.host) {
            hyperionIndexer = args.host;
        }
        const controller = new WebSocket(hyperionIndexer + '/local');
        controller.on('open', () => {
            console.log('Connected to Hyperion Controller');
        });
        controller.on('message', (data) => {
            const parsed = JSON.parse(data.toString());
            console.log(parsed);
        });
        controller.on('close', () => {
            console.log('Disconnected from Hyperion Controller');
        });
        controller.on('error', (err) => {
            console.log(err);
        });
    });

program.parse();





