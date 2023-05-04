import {readFileSync} from "node:fs";
import {Client, estypes} from "@elastic/elasticsearch";
import {HyperionBlock} from "./interfaces.js";

export function readConnectionConfig() {
    const file = readFileSync('connections.json', 'utf8');
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
        ssl: {
            rejectUnauthorized: false
        }
    });
}

export function readChainConfig(chain: string) {
    const file = readFileSync(`chains/${chain}.config.json`, 'utf8');
    return JSON.parse(file);
}

export async function getFirstIndexedBlock(client: Client, blockIndex: string) {
    const {body} = await client.search<estypes.SearchResponse<HyperionBlock>>({
        index: blockIndex,
        size: 1,
        body: {
            sort: [{block_num: {order: 'asc'}}]
        }
    });
    if (body.hits.hits[0]._source) {
        return body.hits.hits[0]._source.block_num;
    } else {
        console.log('No blocks indexed yet');
        process.exit();
    }
}

export async function getLastIndexedBlock(client: Client, blockIndex: string) {
    const {body} = await client.search<estypes.SearchResponse<HyperionBlock>>({
        index: blockIndex,
        size: 1,
        body: {
            sort: [{block_num: {order: 'desc'}}]
        }
    });
    if (body.hits.hits[0]._source) {
        return body.hits.hits[0]._source.block_num;
    } else {
        console.log('No blocks indexed yet');
        process.exit();
    }
}

export async function getBlocks(client: any, indexName: string, blocoInicial: any, blocoFinal: any, size: any) {
    return await client.search({
        index: indexName,
        size: size,
        body: {
            sort: [{block_num: {order: "desc"}}],
            query: {
                range: {
                    block_num: {
                        gte: blocoFinal,
                        lte: blocoInicial,
                    },
                },
            },
        }
    });
}

