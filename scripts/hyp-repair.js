"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const node_fs_1 = require("node:fs");
// @ts-ignore
const cli_progress_1 = __importDefault(require("cli-progress"));
const eosjs_1 = require("eosjs");
const cross_fetch_1 = __importDefault(require("cross-fetch"));
const fs_1 = require("fs");
const functions_js_1 = require("./repair-cli/functions.js");
const ws_1 = require("ws");
const progressBar = new cli_progress_1.default.SingleBar({}, cli_progress_1.default.Presets.shades_classic);
const program = new commander_1.Command();
const errorRanges = [];
let pendingBlock = null;
const missingBlocks = [];
async function run(client, rpc, indexName, blockInit, firstBlock, qtdTotal, loop = 1) {
    let blockInitial = blockInit;
    let blockFinal = blockInitial - qtdTotal;
    const tRef = process.hrtime.bigint();
    progressBar.start(loop, 0);
    for (let i = 1; i <= loop; i++) {
        if (blockFinal < firstBlock) {
            blockFinal = firstBlock;
        }
        try {
            let { body } = await (0, functions_js_1.getBlocks)(client, indexName, blockInitial, blockFinal, qtdTotal);
            let { hits: { hits } } = body;
            const blocks = hits.map((obj) => obj._source);
            await findForksOnRange(blocks, rpc);
            blockInitial = blockFinal;
            blockFinal = blockInitial - qtdTotal;
            progressBar.update(i);
        }
        catch (e) {
            console.log("Error: ", e.message);
            process.exit(1);
        }
    }
    progressBar.stop();
    console.log("=========== Forked Ranges ===========");
    console.table(errorRanges);
    console.log("=========== Missing Ranges ==========");
    console.table(missingBlocks);
    const tDiff = Number(process.hrtime.bigint() - tRef) / 1000000;
    console.log(`Total time: ${Math.round(tDiff / 1000)}s`);
}
async function findForksOnRange(blocks, rpc) {
    const removals = new Set();
    let start = null;
    let end = null;
    if (pendingBlock && blocks[0].block_num !== pendingBlock.block_num) {
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
            console.log(`\nBlock number mismatch, expected: ${currentBlockNumber - 1} got ${previousBlock.block_num}`);
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
        }
        else {
            if (start) {
                const blockData = await rpc.get_block_info(currentBlockNumber);
                if (blockData) {
                    if (blockData.id !== currentBlock.block_id) {
                        removals.add(currentBlock.block_id);
                    }
                    else {
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
async function scanChain(chain, args) {
    const chainConfig = (0, functions_js_1.readChainConfig)(chain);
    console.log(chainConfig.settings.index_version);
    const config = (0, functions_js_1.readConnectionConfig)();
    const client = (0, functions_js_1.initESClient)(config);
    const jsonRpc = new eosjs_1.JsonRpc(config.chains[chain].http, { fetch: cross_fetch_1.default });
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
    }
    else {
        firstBlock = await (0, functions_js_1.getFirstIndexedBlock)(client, blockIndex);
    }
    if (args.last) {
        lastBlock = args.last;
    }
    else {
        lastBlock = await (0, functions_js_1.getLastIndexedBlock)(client, blockIndex);
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
        if (!(0, fs_1.existsSync)('.repair')) {
            (0, fs_1.mkdirSync)('.repair');
        }
    }
    if (errorRanges.length > 0) {
        let path = `.repair/${chain}-${firstBlock + 2}-${lastBlock}-forked-blocks.json`;
        if (args.outFile) {
            path = args.outFile + '-forked-blocks.json';
        }
        (0, fs_1.writeFileSync)(path, JSON.stringify(errorRanges));
    }
    if (missingBlocks.length > 0) {
        let path = `.repair/${chain}-${firstBlock + 2}-${lastBlock}-missing-blocks.json`;
        if (args.outFile) {
            path = args.outFile + '-missing-blocks.json';
        }
        (0, fs_1.writeFileSync)(path, JSON.stringify(missingBlocks));
    }
}
async function repairMissing(chain, file, args) {
    console.log(chain, file, args);
    const chainConfig = (0, functions_js_1.readChainConfig)(chain);
    console.log(chainConfig.settings.index_version);
    const config = (0, functions_js_1.readConnectionConfig)();
    const client = (0, functions_js_1.initESClient)(config);
    const ping = await client.ping();
    if (!ping) {
        console.log('Could not connect to ElasticSearch');
        process.exit();
    }
    let hyperionIndexer = 'ws://localhost:4321';
    if (args.host) {
        hyperionIndexer = args.host;
    }
    const controller = new ws_1.WebSocket(hyperionIndexer + '/local');
    controller.on('open', async () => {
        console.log('Connected to Hyperion Controller');
        const missingBlocks = JSON.parse((0, node_fs_1.readFileSync)(file).toString());
        console.log(missingBlocks);
        const payload = {
            "event": "fill_missing_blocks",
            "data": missingBlocks
        };
        controller.send(JSON.stringify(payload));
    });
    controller.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.event === 'repair_completed') {
            console.log(`Hyperion repair completed!`);
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
async function repairChain(chain, file, args) {
    console.log(chain, file, args);
    const chainConfig = (0, functions_js_1.readChainConfig)(chain);
    console.log(chainConfig.settings.index_version);
    const config = (0, functions_js_1.readConnectionConfig)();
    const client = (0, functions_js_1.initESClient)(config);
    const ping = await client.ping();
    if (!ping) {
        console.log('Could not connect to ElasticSearch');
        process.exit();
    }
    const forkedBlocks = JSON.parse((0, node_fs_1.readFileSync)(file).toString());
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
                        must: [{ range: { block_num: { lte: range.start, gte: range.end } } }]
                    }
                }
            }
        };
        if (args.dry) {
            const resultActions = await client.search(searchActions);
            if (resultActions.body.hits.total?.value > 0) {
                deleteActions += resultActions.body.hits.total?.value;
            }
        }
        else {
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
                        must: [{ range: { block_num: { lte: range.start, gte: range.end } } }]
                    }
                }
            }
        };
        if (args.dry) {
            const resultDeltas = await client.search(searchDeltas);
            if (resultDeltas.body.hits.total?.value > 0) {
                deleteDeltas += resultDeltas.body.hits.total?.value;
            }
        }
        else {
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
                        must: [{ range: { block: { lte: range.start, gte: range.end } } }]
                    }
                }
            }
        };
        if (args.dry) {
            const resultAbis = await client.search(searchAbis);
            if (resultAbis.body.hits.total?.value > 0) {
                deleteAbis += resultAbis.body.hits.total?.value;
                console.log('ABIs', { lte: range.start, gte: range.end });
            }
        }
        else {
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
                        must: [{ range: { block_num: { lte: range.start, gte: range.end } } }]
                    }
                }
            }
        };
        if (args.dry) {
            const resultAccounts = await client.search(searchAccounts);
            if (resultAccounts.body.hits.total?.value > 0) {
                console.log('[WARNING]', resultAccounts.body.hits.total?.value, 'accounts needs to be updated');
                console.log({ lte: range.start, gte: range.end });
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
                        must: [{ range: { block_num: { lte: range.start, gte: range.end } } }]
                    }
                }
            }
        };
        if (args.dry) {
            const resultVoters = await client.search(searchVoters);
            if (resultVoters.body.hits.total?.value > 0) {
                console.log('[WARNING]', resultVoters.body.hits.total?.value, 'voters needs to be updated');
                console.log({ lte: range.start, gte: range.end });
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
                        must: [{ range: { block_num: { lte: range.start, gte: range.end } } }]
                    }
                }
            }
        };
        if (args.dry) {
            const resultProposals = await client.search(searchProposals);
            if (resultProposals.body.hits.total?.value > 0) {
                console.log('[WARNING]', resultProposals.body.hits.total?.value, 'proposals needs to be updated');
                console.log({ lte: range.start, gte: range.end });
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
                        must: [{ range: { block_num: { lte: range.start, gte: range.end } } }]
                    }
                }
            }
        };
        if (args.dry) {
            const resultLinks = await client.search(searchLinks);
            if (resultLinks.body.hits.total?.value > 0) {
                console.log('[WARNING]', resultLinks.body.hits.total?.value, 'links needs to be updated');
                console.log({ lte: range.start, gte: range.end });
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
                        must: [{ range: { block_num: { lte: range.start, gte: range.end } } }]
                    }
                }
            }
        };
        if (args.dry) {
            const resultPermissions = await client.search(searchPermissions);
            if (resultPermissions.body.hits.total?.value > 0) {
                console.log('[WARNING]', resultPermissions.body.hits.total?.value, 'permissions needs to be updated');
                console.log({ lte: range.start, gte: range.end });
            }
        }
        for (const id of range.ids) {
            const searchBlocks = {
                index: blockIndex,
                body: {
                    query: { bool: { must: [{ term: { block_id: { value: id } } }] } }
                }
            };
            if (args.dry) {
                const resultBlocks = await client.search(searchBlocks);
                if (resultBlocks.body.hits.hits[0]._source) {
                    deleteBlocks++;
                }
            }
            else {
                const result = await client.deleteByQuery(searchBlocks);
            }
        }
    }
    if (args.dry) {
        console.log(`DRY-RUN: Would have deleted ${deleteBlocks} blocks, ${deleteActions} actions, ${deleteDeltas} deltas and ${deleteAbis} ABIs`);
    }
    else {
        console.log(`Deleted ${deleteBlocks} blocks, ${deleteActions} actions, ${deleteDeltas} deltas and ${deleteAbis} ABIs`);
    }
}
function viewFile(file) {
    const data = (0, node_fs_1.readFileSync)(file, 'utf8');
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
    let valid = false;
    if (args.host) {
        hyperionIndexer = args.host;
    }
    try {
        const controller = new ws_1.WebSocket(hyperionIndexer + '/local');
        controller.on('open', () => {
            valid = true;
            controller.close();
        });
        controller.on('close', () => {
            if (valid) {
                console.log(`✅  Hyperion Indexer Online - ${hyperionIndexer}`);
            }
        });
        controller.on('error', (err) => {
            console.log("Error:", err.message);
            console.log(`Failed to connect on Hyperion Indexer at ${hyperionIndexer}, please use "--host ws://ADDRESS:PORT" to specify a remote indexer connection`);
        });
    }
    catch (e) {
        console.log(e.message);
    }
});
program.parse();
//# sourceMappingURL=hyp-repair.js.map