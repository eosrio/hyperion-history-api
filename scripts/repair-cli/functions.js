"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBlocks = exports.getLastIndexedBlock = exports.getFirstIndexedBlock = exports.readChainConfig = exports.initESClient = exports.readConnectionConfig = void 0;
const node_fs_1 = require("node:fs");
const elasticsearch_1 = require("@elastic/elasticsearch");
function readConnectionConfig() {
    const file = (0, node_fs_1.readFileSync)('connections.json', 'utf8');
    return JSON.parse(file);
}
exports.readConnectionConfig = readConnectionConfig;
function initESClient(config) {
    const node = `${config.elasticsearch.protocol}://${config.elasticsearch.host}`;
    return new elasticsearch_1.Client({
        nodes: [node],
        auth: {
            username: config.elasticsearch.user,
            password: config.elasticsearch.pass
        },
        tls: {
            rejectUnauthorized: false
        }
    });
}
exports.initESClient = initESClient;
function readChainConfig(chain) {
    const file = (0, node_fs_1.readFileSync)(`chains/${chain}.config.json`, 'utf8');
    return JSON.parse(file);
}
exports.readChainConfig = readChainConfig;
async function getFirstIndexedBlock(client, blockIndex) {
    const result = await client.search({
        index: blockIndex,
        size: 1,
        sort: [{ block_num: { order: 'asc' } }]
    });
    if (result.hits.hits[0]._source) {
        return result.hits.hits[0]._source.block_num;
    }
    else {
        console.log('No blocks indexed yet');
        process.exit();
    }
}
exports.getFirstIndexedBlock = getFirstIndexedBlock;
async function getLastIndexedBlock(client, blockIndex) {
    const result = await client.search({
        index: blockIndex,
        size: 1,
        sort: [{ block_num: { order: 'desc' } }]
    });
    if (result.hits.hits[0]._source) {
        return result.hits.hits[0]._source.block_num;
    }
    else {
        console.log('No blocks indexed yet');
        process.exit();
    }
}
exports.getLastIndexedBlock = getLastIndexedBlock;
async function getBlocks(client, indexName, startingBlock, finalBlock, size) {
    return await client.search({
        index: indexName,
        size: size,
        sort: [{ block_num: { order: "desc" } }],
        query: {
            range: {
                block_num: {
                    gte: finalBlock,
                    lte: startingBlock,
                },
            },
        },
    });
}
exports.getBlocks = getBlocks;
//# sourceMappingURL=functions.js.map