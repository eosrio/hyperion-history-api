import { Client, estypes } from "@elastic/elasticsearch";
import { Cluster } from "node:cluster";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getTotalValue } from "../../api/helpers/functions.js";
import { HyperionConfig } from "../../interfaces/hyperionConfig.js";
import { RequestFilter } from "../../interfaces/stream-requests.js";

let config: HyperionConfig | undefined;

export function getConfigPath(): string {
    let configFile = process.env.CONFIG_JSON;
    if (!configFile) {
        if (process.env.CHAIN_NAME) {
            configFile = `./config/chains/${process.env.CHAIN_NAME}.config.json`;
        } else {
            console.error('No chain name specified! Please set the CHAIN_NAME environment variable or CONFIG_JSON.');
            process.exit(1);
        }
    }
    return configFile;
}

function readConfigFromFile() {
    const configFile = getConfigPath();
    const conf_path = join(import.meta.dirname, '../../../', configFile || "");
    let errorMsg = '';
    if (existsSync(conf_path)) {
        try {
            config = JSON.parse(readFileSync(conf_path).toString());
        } catch (e: any) {
            errorMsg = e.message;

        }
    }

    if (!config && existsSync(configFile)) {
        try {
            config = JSON.parse(readFileSync(configFile).toString());
        } catch (e: any) {
            errorMsg = e.message;
        }
    }

    if (!config) {
        console.error(errorMsg);
        console.log(`Configuration not found: ${conf_path}`);
        process.exit(1);
    }
}

export function getLastResult(results: estypes.SearchResponse<any, any>) {
    if (results.hits?.hits?.length > 0) {
        const firstHit = results.hits.hits[0];
        if (firstHit.sort) {
            return parseInt(firstHit.sort[0]?.toString() ?? '1', 10);
        } else {
            return 1;
        }
    } else {
        return 1;
    }
}

export async function getLastIndexedBlockByDelta(es_client: Client, chain: string) {
    const results = await es_client.search<any>({
        index: chain + '-delta-*',
        size: 1,
        query: { bool: { filter: { match_all: {} } } },
        sort: [{ block_num: { order: "desc" } }]
    });
    return getLastResult(results);
}

export async function getLastIndexedBlock(es_client: Client, chain: string) {
    const results = await es_client.search<any>({
        index: chain + '-block-*',
        size: 1,
        query: { bool: { filter: { match_all: {} } } },
        sort: [{ block_num: { order: "desc" } }]
    });
    return getLastResult(results);
}

export async function getLastIndexedBlockWithTotalBlocks(es_client: Client, chain: string): Promise<[number, number]> {
    const results = await es_client.search<any>({
        index: chain + '-block-*',
        size: 1,
        query: { bool: { filter: { match_all: {} } } },
        sort: [{ block_num: { order: "desc" } }],
        track_total_hits: true
    });
    let lastBlock = getLastResult(results);
    let totalBlocks = getTotalValue(results) || 1;
    return [lastBlock, totalBlocks];
}

export async function getFirstIndexedBlock(es_client: Client, chain: string, partition_size?: number): Promise<number> {

    try {
        const indices = await es_client.cat.indices({
            index: chain + '-action-*',
            s: 'index',
            v: true,
            format: 'json'
        });

        if (indices.length === 0) {
            throw new Error('No indices found for chain: ' + chain);
        }

        // get the first index name
        const firstIndex = indices[0].index;

        let firstIndexedBlock = 0;

        if (firstIndex) {
            const parts = firstIndex.split('-');
            const blockChunk = parts[parts.length - 1];
            const blockChunkSize = partition_size || 10000000;
            const startBlock = (parseInt(blockChunk) - 1) * blockChunkSize;
            const endBlock = startBlock + blockChunkSize;

            // perform a search to get the first block in the index using a range query
            const results = await es_client.search<any>({
                index: chain + '-block-*',
                size: 1,
                query: { range: { block_num: { gte: startBlock, lte: endBlock } } },
                sort: [{ block_num: { order: "asc" } }]
            });
            if (results.hits?.hits?.length > 0) {
                firstIndexedBlock = getLastResult(results);
            }
        }

        // 2 is the minimum first block in the state history index
        if (firstIndexedBlock < 2) {
            // as a fallback, get the first block in the whole index (not recommended)
            const results = await es_client.search<any>({
                index: chain + '-block-*',
                size: 1,
                query: { bool: { filter: { match_all: {} } } },
                sort: [{ block_num: { order: "asc" } }]
            });
            firstIndexedBlock = getLastResult(results);
        }
        return firstIndexedBlock;
    } catch (e) {
        console.error('Error getting first indexed block:', e);
        throw new Error('Error getting first indexed block');
    }
}


export async function getLastIndexedABI(es_client: Client, chain: string) {
    const results = await es_client.search<any>({
        index: chain + '-abi-*',
        size: 1,
        query: {
            match_all: {}
        },
        sort: [{ block: { order: "desc" } }]
    });
    return getLastResult(results);
}

export async function getLastIndexedBlockByDeltaFromRange(es_client: Client, chain: string, first: number, last: number) {
    const results = await es_client.search<any>({
        index: chain + '-delta-*',
        size: 1,
        query: {
            range: {
                block_num: {
                    "gte": first,
                    "lt": last,
                    "boost": 2
                }
            }
        },
        sort: [{ block_num: { order: "desc" } }]
    });
    return getLastResult(results);
}

export async function getLastIndexedBlockFromRange(es_client: Client, chain: string, first: number, last: number) {
    const results = await es_client.search<any>({
        index: chain + '-block-*',
        size: 1,
        query: {
            range: {
                block_num: {
                    "gte": first,
                    "lt": last,
                    "boost": 2
                }
            }
        },
        sort: [{ block_num: { order: "desc" } }]
    });
    return getLastResult(results);
}

export function messageAllWorkers(cl: Cluster, payload: {
    event: string,
    target?: string,
    data?: any
}) {
    for (const c in cl.workers) {
        if (cl.workers.hasOwnProperty(c)) {
            const _w = cl.workers[c];
            if (_w) {
                try {
                    if (_w.isConnected()) {
                        _w.send(payload);
                    } else {
                        hLog('Worker is not connected!');
                    }
                } catch (e) {
                    hLog('Failed to message worker!');
                    hLog(e);
                }
            } else {
                hLog('Worker not found!');
            }
        }
    }
}

function getNested(path_array: string[], jsonObj: Record<string, any>, operator?: string) {
    const nextPath = path_array.shift();
    if (!nextPath) {
        return jsonObj;
    }
    const nextValue = jsonObj[nextPath];
    if (nextPath.endsWith(']')) {
        const index = parseInt(nextPath.substring(nextPath.indexOf('[') + 1, nextPath.indexOf(']')));
        const field = nextPath.substring(0, nextPath.indexOf('['));
        if (Array.isArray(jsonObj[field])) {
            return getNested(path_array, jsonObj[field][index], operator);
        } else {
            return null;
        }
    }
    if (!nextValue) {
        return null;
    } else {
        if (typeof nextValue !== 'object') {
            return nextValue;
        } else {
            if (Array.isArray(nextValue)) {
                return nextValue;
            } else {
                return getNested(path_array, nextValue, operator);
            }
        }
    }
}

export function checkMetaFilter(filter: RequestFilter, _source: any, metaField: string) {
    if (filter.field && filter.value) {
        const fieldParts = filter.field.split(".");
        let fieldValue = getNested(fieldParts, _source, filter.operator);
        if (!fieldValue) {
            if (fieldParts[0].startsWith('@')) {
                if (metaField === 'action') {
                    const actName = fieldParts[0].replace('@', '');
                    if (_source.act.name === actName) {
                        fieldParts[0] = 'data';
                        fieldParts.unshift('act');
                        fieldValue = getNested(fieldParts, _source);
                    }
                } else if (metaField === 'delta') {
                    const tableName = fieldParts[0].replace('@', '');
                    if (_source.table === tableName) {
                        fieldParts[0] = 'data';
                        fieldValue = getNested(fieldParts, _source);
                    }
                }
            } else {
                fieldValue = getNested(["data", ...fieldParts], _source);
            }
        }
        if (fieldValue) {
            if (Array.isArray(fieldValue)) {
                return fieldValue.some(item => {
                    return checkMetaFilter({
                        field: fieldParts.join('.'),
                        operator: filter.operator,
                        value: filter.value
                    }, item, metaField);
                });
            } else {
                if (filter.asset && filter.asset !== '' && typeof fieldValue === 'string') {
                    const [amount, symbol] = fieldValue.split(' ');
                    if (symbol === filter.asset) {
                        fieldValue = parseFloat(amount);
                    }
                }
                switch (filter.operator) {
                    case "eq": {
                        return fieldValue === filter.value;
                    }
                    case "gt": {
                        return fieldValue > filter.value;
                    }
                    case "gte": {
                        return fieldValue >= filter.value;
                    }
                    case "lt": {
                        return fieldValue < filter.value;
                    }
                    case "lte": {
                        return fieldValue <= filter.value;
                    }
                    case "ne": {
                        return fieldValue !== filter.value;
                    }
                    case "contains": {
                        return (fieldValue as string).includes(String(filter.value));
                    }
                    case "starts_with": {
                        return (fieldValue as string).startsWith(String(filter.value));
                    }
                    case "ends_with": {
                        return (fieldValue as string).endsWith(String(filter.value));
                    }
                    default: {
                        return fieldValue === filter.value;
                    }
                }
            }
        } else {
            return !filter.value;
        }
    } else {
        return false;
    }
}

export function checkFilter(filter: RequestFilter, _source: any) {
    if (filter.field && filter.value) {
        let fieldValue = getNested(filter.field.split("."), _source);
        if (!fieldValue) {
            const fArray = filter.field.split(".");
            if (fArray[0].startsWith('@')) {
                const actName = fArray[0].replace('@', '');
                if (_source.act.name === actName) {
                    fArray[0] = 'data';
                    fArray.unshift('act');
                    fieldValue = getNested(fArray, _source);
                }
            }
        }
        if (fieldValue) {
            if (Array.isArray(fieldValue)) {
                return fieldValue.indexOf(filter.value) !== -1;
            } else {
                return fieldValue === filter.value;
            }
        } else {
            return !filter.value;
        }
    } else {
        return false;
    }
}

export function hLog(input: any, ...extra: any[]) {
    let role: string;
    if (process.env.worker_role) {
        const id = parseInt(process.env.worker_id ?? "");
        role = `[${process.pid} - ${(id < 10 ? '0' : '') + id.toString()}_${process.env.worker_role}]`;
    } else {
        if (process.env.script && process.env.script === './api/server.js') {
            role = `[${process.pid} - api]`;
        } else {
            role = `[${process.pid} - 00_master]`;
        }
    }
    if (process.env.TRACE_LOGS === 'true') {
        const e = new Error();
        if (e && e.stack) {
            const frame = e.stack.split("\n")[2];
            const where = frame.split(" ")[6].split(/[:()]/);
            const arr = where[1].split("/");
            const fileName = arr[arr.length - 1];
            const lineNumber = where[2];
            role += ` ${fileName}:${lineNumber}`;
        }
    }
    console.log(role, input, ...extra);
}

export function debugLog(text: any, ...extra: any[]) {
    if (!config) {
        readConfigFromFile();
    }
    if (config?.settings.debug) {
        hLog('[debug]', text, ...extra);
    }
}

export async function sleep(ms): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitUntilReady(executor: () => Promise<boolean>, attempts: number, interval: number, onError: () => void): Promise<void> {
    let i = 0;
    while (i < attempts) {
        if (await executor()) {
            return;
        }
        await sleep(interval);
        i++;
    }
    onError();
}
