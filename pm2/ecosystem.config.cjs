const { addApiServer, addIndexer } = require('./ecosystem_settings.cjs');
const { readdirSync, readFileSync } = require("fs");
const path = require('path');

const apps = [];
const chainsRoot = path.join(__dirname, '../config', 'chains');

console.log(`Reading chain configs from ${chainsRoot}`);

const appName = process.argv[5];

const parts = appName.split('-');

// wax-test-indexer should be valid, split into wax-test and indexer
const chain = parts.slice(0, -1).join('-'); // Join all but the last part for the chain name
const type = parts[parts.length - 1]; // Last part is the type (api or indexer)
if (parts.length < 2) {
    console.error(`\x1b[31mERROR: Invalid app name format: ${appName}. Expected format: <chain>-<type>\x1b[0m`);
    process.exit(1);
}

if (!chain || !type) {
    console.error(`\x1b[31mERROR: Invalid app name format: ${appName}. Expected format: <chain>-<type>\x1b[0m`);
    process.exit(1);
}

if (type !== 'api' && type !== 'indexer') {
    console.error(`\x1b[31mERROR: Invalid app type: ${type}. Expected 'api' or 'indexer'.\x1b[0m`);
    process.exit(1);
}

let apiCount = 0;
let indexerCount = 0;

const files = readdirSync(chainsRoot);

const chainConfigFiles = files.filter(f => f.endsWith('.config.json') && !f.startsWith('example'));

if (chainConfigFiles.length === 0) {
    console.error(`\x1b[31mERROR: No chain config files found in ${chainsRoot}\x1b[0m`);
    process.exit(1);
}

chainConfigFiles.forEach(value => {
    const configFile = readFileSync(path.join(chainsRoot, value))
    const config = JSON.parse(configFile.toString());
    const chainName = config.settings.chain;

    if (chainName !== chain) {
        return;
    }

    if (config.api.enabled && type === 'api') {
        const apiHeap = config.api.node_max_old_space_size;
        const traceDeprecation = config.api.node_trace_deprecation;
        const traceWarnings = config.api.node_trace_warnings;
        apps.push(addApiServer(chainName, config.api.pm2_scaling, apiHeap, traceDeprecation, traceWarnings));
        apiCount++;
    }

    if (config.indexer.enabled && type === 'indexer') {
        const indexerHeap = config.indexer.node_max_old_space_size;
        const traceDeprecation = config.indexer.node_trace_deprecation;
        const traceWarnings = config.indexer.node_trace_warnings;
        apps.push(addIndexer(chainName, indexerHeap, traceDeprecation, traceWarnings));
        indexerCount++;
    }
});

if (apps.length === 0) {
    console.error(`\x1b[31mERROR: Chain "${chain}" not found!\x1b[0m`);
    // print available chains, in cyan, one in each line with bullet point
    console.error(`\x1b[36mAvailable chains:\x1b[0m`);
    chainConfigFiles.forEach(f => {
        console.error(`\x1b[36m - ${f.replace('.config.json', '')}\x1b[0m`);
    });
    process.exit(1);
}

module.exports = { apps };
