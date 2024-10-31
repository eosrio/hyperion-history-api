import {readFileSync} from "node:fs";
import {Client} from "@elastic/elasticsearch";
import {HyperionBlock} from "./interfaces.js";
import path from "path";

export function readConnectionConfig() {
    const connectionsConfigPath = path.join(import.meta.dirname, '../../../', 'config/connections.json');
    const file = readFileSync(connectionsConfigPath, 'utf8');
    return JSON.parse(file);
}

export function initESClient(config: any) {
    const node = `${config.elasticsearch.protocol}://${config.elasticsearch.host}`;
    return new Client({
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

export function readChainConfig(chain: string) {
    const chainConfigPath = path.join(import.meta.dirname, '../../../', `config/chains/${chain}.config.json`);
    const file = readFileSync(chainConfigPath, 'utf8');
    return JSON.parse(file);
}

export async function getFirstIndexedBlock(client: Client, blockIndex: string) {
    const result = await client.search<HyperionBlock>({
        index: blockIndex,
        size: 1,
        sort: [{block_num: {order: 'asc'}}]
    });
    if (result.hits.hits[0]._source) {
        return result.hits.hits[0]._source.block_num;
    } else {
        console.log('No blocks indexed yet');
        process.exit();
    }
}

export async function getLastIndexedBlock(client: Client, blockIndex: string) {
    const result = await client.search<HyperionBlock>({
        index: blockIndex,
        size: 1,
        sort: [{block_num: {order: 'desc'}}]
    });
    if (result.hits.hits[0]._source) {
        return result.hits.hits[0]._source.block_num;
    } else {
        console.log('No blocks indexed yet');
        process.exit();
    }
}

export async function getBlocks(client: any, indexName: string, startingBlock: any, finalBlock: any, size: any) {
    return await client.search({
        index: indexName,
        size: size,
        sort: [{block_num: {order: "desc"}}],
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

