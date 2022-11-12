import {Client, estypes} from "@elastic/elasticsearch";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {Serialize} from "eosjs";
import {fileURLToPath} from "node:url";
import {HyperionAction} from "../interfaces/hyperion-action.js";
import {Cluster} from "cluster";
import {Serializable} from "child_process";
import {JsonRpc} from "enf-eosjs";
import {Abieos} from "@eosrio/node-abieos";
import {FastifyInstance} from "fastify";
import {config} from "./config.js";

function getLastResult(results: estypes.SearchResponse) {
    if (results.hits?.hits?.length > 0) {
        if (results.hits.hits[0].sort) {
            const last = results.hits.hits[0].sort[0];
            if (last && typeof last === 'number') {
                return last;
            } else if (typeof last === 'string') {
                return parseInt(last, 10);
            } else {
                return 1;
            }
        } else {
            return 1;
        }
    } else {
        return 1;
    }
}

export async function getLastIndexedBlockByDelta(es_client: Client, chain: string) {
    const results = await es_client.search({
        index: chain + '-delta-*',
        size: 1,
        query: {bool: {filter: {match_all: {}}}},
        sort: [{block_num: {order: "desc"}}]
    });
    return getLastResult(results);
}

export async function getLastIndexedBlock(es_client: Client, chain: string) {
    const results: estypes.SearchResponse = await es_client.search({
        index: chain + '-block-*',
        size: 1,
        query: {bool: {filter: {match_all: {}}}},
        sort: [{block_num: {order: "desc"}}]
    });
    return getLastResult(results);
}

export async function getFirstIndexedBlock(esClient: Client, chain: string): Promise<number> {
    const results: estypes.SearchResponse = await esClient.search({
        index: chain + '-block-*',
        size: 1,
        query: {bool: {filter: {match_all: {}}}},
        sort: [{block_num: {order: "asc"}}]
    });
    return getLastResult(results);
}

export async function getLastIndexedBlockWithTotalBlocks(es_client: Client, chain: string): Promise<[number, number]> {
    const results = await es_client.search({
        index: chain + '-block-*',
        size: 1,
        query: {bool: {filter: {match_all: {}}}},
        sort: [{block_num: {order: "desc"}}],
        track_total_hits: true
    });
    let lastBlock = getLastResult(results);
    let totalBlocks = 1;
    if (results.hits.total) {
        if (typeof results.hits.total !== "number") {
            totalBlocks = results.hits.total.value;
        } else {
            totalBlocks = results.hits.total;
        }
    }
    return [lastBlock, totalBlocks];
}


export async function getLastIndexedABI(es_client: Client, chain: string) {
    const results = await es_client.search({
        index: chain + '-abi-*',
        size: 1,
        query: {
            match_all: {}
        },
        sort: [{block: {order: "desc"}}]
    });
    return getLastResult(results);
}

export async function getLastIndexedBlockByDeltaFromRange(es_client: Client, chain: string, first: number, last: number) {
    const results = await es_client.search({
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
        sort: [{block_num: {order: "desc"}}]
    });
    return getLastResult(results);
}

export async function getLastIndexedBlockFromRange(es_client: Client, chain: string, first: number, last: number) {
    const results = await es_client.search({
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
        sort: [{block_num: {order: "desc"}}]
    });
    return getLastResult(results);
}

export function messageAllWorkers(cl: Cluster, payload: Serializable) {
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
                } catch (e: any) {
                    hLog('Failed to message worker!');
                    hLog(e);
                }
            } else {
                hLog('Worker not found!');
            }
        }
    }
}

export function serialize(
    type: string,
    value: any,
    txtEnc: TextEncoder,
    txtDec: TextDecoder,
    types: Map<string, Serialize.Type>
) {
    const buffer = new Serialize.SerialBuffer({
        textEncoder: txtEnc,
        textDecoder: txtDec
    });
    Serialize.getType(types, type).serialize(buffer, value);
    return buffer.asUint8Array();
}

export function deserialize(
    typeName: string,
    array: Uint8Array,
    txtEnc: TextEncoder,
    txtDec: TextDecoder,
    types: Map<string, Serialize.Type>
): any {
    const buffer = new Serialize.SerialBuffer({
        textEncoder: txtEnc,
        textDecoder: txtDec,
        array
    });
    return Serialize
        .getType(types, typeName)
        .deserialize(buffer, new Serialize.SerializerState({bytesAsUint8Array: true}));
}

function getNested(path_array: string[], jsonObj: Record<string, any>): any {
    const nextPath = path_array.shift();
    if (!nextPath) {
        return null;
    }
    const nextValue = jsonObj[nextPath];
    if (!nextValue) {
        return null;
    } else {
        if (typeof nextValue !== 'object') {
            return nextValue;
        } else {
            if (Array.isArray(nextValue)) {
                return nextValue;
            } else {
                return getNested(path_array, nextValue);
            }
        }
    }
}

export function checkFilter(filter: { field: string, value: string }, _source: HyperionAction) {
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
    let role;
    if (process.env.worker_role) {
        role = `[${(process.env.worker_id as string).toString().padStart(2, '0')} - ${process.env.worker_role}]`;
    } else {
        role = process.title && process.title.endsWith('-api') ? `[API]` : `[MASTER]`;
    }
    if (process.env.TRACE_LOGS === 'true') {
        const e = new Error();
        if (e.stack) {
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
    if (config && config.settings.debug) {
        hLog(text, ...extra);
    }
}

export function getPackageJson(): any {
    return JSON.parse(readFileSync(resolve('package.json')).toString());
}

export const __filename = () => fileURLToPath(import.meta.url);

export async function getAbiFromHeadBlock(rpc: JsonRpc, code: string) {
    let _abi;
    try {
        _abi = (await rpc.get_abi(code)).abi;
    } catch (e) {
        hLog(e);
    }
    return {
        abi: _abi,
        valid_until: null,
        valid_from: null
    };
}

export async function fetchAbiAtBlock(client: Client,
                                      chain: string,
                                      contractName: string,
                                      lastBlock: number,
                                      getJson: boolean): Promise<any> {
    try {
        const t_start = process.hrtime.bigint();
        const _includes = ["actions", "tables", "block"];
        if (getJson) {
            _includes.push("abi");
        } else {
            _includes.push("abi_hex");
        }
        const contractTerm = {term: {account: contractName}};
        const lteQuery = {
            bool: {must: [contractTerm, {range: {block: {lte: lastBlock}}}]}
        };
        const gteQuery = {
            bool: {must: [contractTerm, {range: {block: {gte: lastBlock}}}]}
        };
        const queryResult = await client.search<any>({
            index: `${chain}-abi-*`,
            size: 1,
            query: lteQuery,
            sort: [{block: {order: "desc"}}],
            _source: {includes: _includes}
        });
        const results = queryResult.hits.hits;
        if (results.length > 0) {
            const nextRefResponse = await client.search<any>({
                index: `${chain}-abi-*`,
                size: 1,
                query: gteQuery,
                sort: [{block: {order: "asc"}}],
                _source: {includes: ["block"]}
            });
            const nextRef = nextRefResponse.hits.hits;
            const t_end = process.hrtime.bigint();
            const results = queryResult.hits.hits;
            const duration = (Number(t_end - t_start) / 1000 / 1000).toFixed(2);
            hLog(`fetchAbiAtBlock took: ${duration} ms`);
            const from = results[0]._source.block;
            let until = -1;
            if (nextRef.length > 0) {
                until = nextRef[0]._source.block;
            }
            return {
                valid_from: from,
                valid_until: until,
                ...results[0]._source
            };
        } else {
            return null;
        }
    } catch (e: any) {
        hLog(e);
        return null;
    }
}

const abiRemapping: Record<string, any> = {
    "_Bool": "bool"
};

export async function getContractAtBlock(
    esClient: Client,
    rpc: JsonRpc,
    chain: string,
    accountName: string,
    blockNum: number,
    check_action?: string
) {
    let savedAbi, abi;
    savedAbi = await fetchAbiAtBlock(esClient, chain, accountName, blockNum, true);
    if (savedAbi === null || (savedAbi.actions && !savedAbi.actions.includes(check_action))) {
        savedAbi = await getAbiFromHeadBlock(rpc, accountName);
        if (!savedAbi) return [null, null];
        abi = savedAbi.abi;
    } else {
        try {
            abi = JSON.parse(savedAbi.abi);
        } catch (e) {
            hLog(e);
            return [null, null];
        }
    }
    if (!abi) return [null, null];
    const initialTypes = Serialize.createInitialTypes();
    let types: Map<string, Serialize.Type> | undefined
    try {
        types = Serialize.getTypesFromAbi(initialTypes, abi);
    } catch (e) {
        let remapped = false;
        for (const struct of abi.structs) {
            for (const field of struct.fields) {
                if (abiRemapping[field.type]) {
                    field.type = abiRemapping[field.type];
                    remapped = true;
                }
            }
        }
        if (remapped) {
            try {
                types = Serialize.getTypesFromAbi(initialTypes, abi);
            } catch (e) {
                hLog('failed after remapping abi');
                hLog(accountName, blockNum, check_action);
                hLog(e);
            }
        } else {
            hLog(accountName, blockNum);
            hLog(e);
        }
    }
    const actions = new Map();
    for (const {name, type} of abi.actions) {
        if (types) {
            actions.set(name, Serialize.getType(types, type));
        }
    }
    const result = {types, actions, tables: abi.tables};
    if (check_action) {
        if (actions.has(check_action)) {
            try {
                Abieos.getInstance().loadAbi(accountName, JSON.stringify(abi));
            } catch (e) {
                hLog(e);
            }
        }
    }
    return [result, abi];
}

export function getIndexPatternFromBlockHint(blockNumHint: string, fastify: FastifyInstance): string {
    const b = parseInt(blockNumHint, 10);
    const s = fastify.manager.config.settings;
    if (b) {
        const idxPart = Math.ceil(b / s.index_partition_size).toString().padStart(6, '0');
        return fastify.manager.chain + `-action-${s.index_version}-${idxPart}`;
    } else {
        return fastify.manager.chain + '-action-*';
    }
}
