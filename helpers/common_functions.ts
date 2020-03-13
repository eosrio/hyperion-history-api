import {ApiResponse, Client} from "@elastic/elasticsearch";
import {Serialize} from "../addons/eosjs-native";

function getLastResult(results: ApiResponse) {
    if (results.body.hits?.hits?.length > 0) {
        return parseInt(results.body.hits.hits[0].sort[0], 10);
    } else {
        return 1;
    }
}

export async function getLastIndexedBlockByDelta(es_client: Client, chain: string) {
    const results: ApiResponse = await es_client.search({
        index: chain + '-delta-*',
        size: 1,
        body: {
            query: {bool: {filter: {match_all: {}}}},
            sort: [{block_num: {order: "desc"}}],
            size: 1
        }
    });
    return getLastResult(results);
}

export async function getLastIndexedBlock(es_client: Client, chain: string) {
    const results: ApiResponse = await es_client.search({
        index: chain + '-block-*',
        size: 1,
        body: {
            query: {bool: {filter: {match_all: {}}}},
            sort: [{block_num: {order: "desc"}}],
            size: 1
        }
    });
    return getLastResult(results);
}

export async function getLastIndexedABI(es_client: Client, chain: string) {
    const results: ApiResponse = await es_client.search({
        index: chain + '-abi-*',
        size: 1,
        body: {
            query: {
                match_all: {}
            },
            sort: [{block: {order: "desc"}}],
            size: 1
        }
    });
    return getLastResult(results);
}

export async function getLastIndexedBlockByDeltaFromRange(es_client: Client, chain: string, first: number, last: number) {
    const results: ApiResponse = await es_client.search({
        index: chain + '-delta-*',
        size: 1,
        body: {
            query: {
                range: {
                    block_num: {
                        "gte": first,
                        "lt": last,
                        "boost": 2
                    }
                }
            },
            sort: [{block_num: {order: "desc"}}],
            size: 1
        }
    });
    return getLastResult(results);
}

export async function getLastIndexedBlockFromRange(es_client: Client, chain: string, first: number, last: number) {
    const results = await es_client.search({
        index: chain + '-block-*',
        size: 1,
        body: {
            query: {
                range: {
                    block_num: {
                        "gte": first,
                        "lt": last,
                        "boost": 2
                    }
                }
            },
            sort: [{block_num: {order: "desc"}}],
            size: 1
        }
    });
    return getLastResult(results);
}

export function messageAllWorkers(cl, payload) {
    for (const c in cl.workers) {
        if (cl.workers.hasOwnProperty(c)) {
            const _w = cl.workers[c];
            _w.send(payload);
        }
    }
}

export function serialize(type, value, txtEnc, txtDec, types) {
    const buffer = new Serialize.SerialBuffer({
        textEncoder: txtEnc,
        textDecoder: txtDec
    });
    Serialize.getType(types, type).serialize(buffer, value);
    return buffer.asUint8Array();
}

export function deserialize(type, array, txtEnc, txtDec, types) {
    const buffer = new Serialize.SerialBuffer({
        textEncoder: txtEnc,
        textDecoder: txtDec,
        array
    });
    return Serialize.getType(types, type).deserialize(buffer, new Serialize.SerializerState({bytesAsUint8Array: true}));
}

function getNested(path_array, jsonObj) {
    const nextPath = path_array.shift();
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

export function checkFilter(filter, _source) {
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
        const id = parseInt(process.env.worker_id);
        role = `[${(id < 10 ? '0' : '') + id.toString()}_${process.env.worker_role}]`;
    } else {
        role = '[00_master]';
    }
    if (process.env.TRACE_LOGS === 'true') {
        const e = new Error();
        const frame = e.stack.split("\n")[2];
        const where = frame.split(" ")[6].split(/[:()]/);
        const arr = where[1].split("/");
        const fileName = arr[arr.length - 1];
        const lineNumber = where[2];
        role += ` ${fileName}:${lineNumber}`;
    }
    console.log(role, input, ...extra);
}
