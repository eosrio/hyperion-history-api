const {addApiServer, addIndexer} = require('./scripts/ecosystem.helpers.cjs');
const {readdirSync, readFileSync} = require("node:fs");
const path = require('node:path');

const apps = [];
const chainsRoot = path.join(path.resolve(), 'config', 'chains');
readdirSync(chainsRoot)
    .filter(f => f.endsWith('.config.json') && !f.startsWith('example'))
    .forEach(value => {
        const configFile = readFileSync(path.join(chainsRoot, value))
        const config = JSON.parse(configFile.toString());
        const chainName = config.settings.chain;
        if (config.api.enabled) {
            const apiHeap = config.api.node_max_old_space_size;
            apps.push(addApiServer(chainName, config.api.pm2_scaling, apiHeap));
        }
        if (config.indexer.enabled) {
            const indexerHeap = config.indexer.node_max_old_space_size;
            apps.push(addIndexer(chainName, indexerHeap));
        }
    });

console.log(apps);
module.exports = {apps};
