const {addApiServer, addIndexer} = require('./ecosystem_settings.cjs');
const {readdirSync, readFileSync} = require("fs");
const path = require('path');

const apps = [];
const chainsRoot = path.join(__dirname, '../config', 'chains');

console.log(`Reading chain configs from ${chainsRoot}`);

let apiCount = 0;
let indexerCount = 0;

readdirSync(chainsRoot)
    .filter(f => f.endsWith('.config.json') && !f.startsWith('example'))
    .forEach(value => {
        const configFile = readFileSync(path.join(chainsRoot, value))
        const config = JSON.parse(configFile.toString());
        const chainName = config.settings.chain;
        if (config.api.enabled) {
            const apiHeap = config.api.node_max_old_space_size;
            const traceDeprecation = config.api.node_trace_deprecation;
            const traceWarnings = config.api.node_trace_warnings;
            apps.push(addApiServer(chainName, config.api.pm2_scaling, apiHeap, traceDeprecation, traceWarnings));
            apiCount++;
        }
        if (config.indexer.enabled) {
            const indexerHeap = config.indexer.node_max_old_space_size;
            const traceDeprecation = config.indexer.node_trace_deprecation;
            const traceWarnings = config.indexer.node_trace_warnings;
            apps.push(addIndexer(chainName, indexerHeap, traceDeprecation, traceWarnings));
            indexerCount++;
        }
    });

console.log(`${indexerCount} chain indexers and ${apiCount} APIs enabled`);

module.exports = {apps};
