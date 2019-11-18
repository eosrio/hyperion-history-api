const {Serialize} = require('eosjs');
const zlib = require('zlib');
const prettyjson = require("prettyjson");

function onError(err) {
    console.log(process.env['worker_role']);
    console.log(err);
}

function serialize(type, value, txtEnc, txtDec, types) {
    const buffer = new Serialize.SerialBuffer({
        textEncoder: txtEnc,
        textDecoder: txtDec
    });
    Serialize.getType(types, type).serialize(buffer, value);
    return buffer.asUint8Array();
}

function deserialize(type, array, txtEnc, txtDec, types) {
    const buffer = new Serialize.SerialBuffer({
        textEncoder: txtEnc,
        textDecoder: txtDec,
        array
    });
    return Serialize.getType(types, type).deserialize(buffer, new Serialize.SerializerState({bytesAsUint8Array: true}));
}

function unzipAsync(data) {
    return new Promise((resolve, reject) => {
        zlib.unzip(data, (err, result) => {
            if (err) {
                reject();
            } else {
                resolve(result);
            }
        })
    });
}

async function getLastIndexedBlock(es_client) {
    const results = await es_client.search({
        index: process.env.CHAIN + '-block-*',
        size: 1,
        body: {
            query: {bool: {filter: {match_all: {}}}},
            sort: [{block_num: {order: "desc"}}],
            size: 1
        }
    });
    if (results['body']['hits']['hits'].length > 0) {
        return parseInt(results['body']['hits']['hits'][0]['sort'][0], 10);
    } else {
        return 0;
    }
}

async function getLastIndexedBlockByDelta(es_client) {
    const results = await es_client.search({
        index: process.env.CHAIN + '-delta-*',
        size: 1,
        body: {
            query: {bool: {filter: {match_all: {}}}},
            sort: [{block_num: {order: "desc"}}],
            size: 1
        }
    });
    if (results['body']['hits']['hits'].length > 0) {
        return parseInt(results['body']['hits']['hits'][0]['sort'][0], 10);
    } else {
        return 0;
    }
}

async function getFirstIndexedBlockFromRange(es_client, first, last) {
    const results = await es_client.search({
        index: process.env.CHAIN + '-block-*',
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
            sort: [{block_num: {order: "asc"}}],
            size: 1
        }
    });
    if (results['body']['hits']['hits'].length > 0) {
        return parseInt(results['body']['hits']['hits'][0]['sort'][0], 10);
    } else {
        return 0;
    }
}

async function getLastIndexedBlockFromRange(es_client, first, last) {
    const results = await es_client.search({
        index: process.env.CHAIN + '-block-*',
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
    if (results['body']['hits']['hits'].length > 0) {
        return parseInt(results['body']['hits']['hits'][0]['sort'][0], 10);
    } else {
        return 0;
    }
}

async function getLastIndexedABI(es_client, first, last) {
    const results = await es_client.search({
        index: process.env.CHAIN + '-abi-*',
        size: 1,
        body: {
            query: {
                match_all: {}
            },
            sort: [{block: {order: "desc"}}],
            size: 1
        }
    });
    if (results['body']['hits']['hits'].length > 0) {
        return parseInt(results['body']['hits']['hits'][0]['sort'][0], 10);
    } else {
        return 1;
    }
}

async function getLastIndexedBlockByDeltaFromRange(es_client, first, last) {
    const results = await es_client.search({
        index: process.env.CHAIN + '-delta-*',
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
    if (results['body']['hits']['hits'].length > 0) {
        return parseInt(results['body']['hits']['hits'][0]['sort'][0], 10);
    } else {
        return 0;
    }
}

function messageAllWorkers(cl, payload) {
    for (const c in cl.workers) {
        if (cl.workers.hasOwnProperty(c)) {
            const _w = cl.workers[c];
            _w.send(payload);
        }
    }
}

function printWorkerMap(wmp) {
    console.log('--------------------------------------------------');
    console.log(prettyjson.render({
        'workers': wmp
    }, {
        numberColor: 'grey'
    }));
    console.log('--------------------------------------------------');
}

function onSaveAbi(data, abiCacheMap, rClient) {
    const key = data['block'] + ":" + data['account'];
    debugLog(key);
    rClient.set(process.env.CHAIN + ":" + key, data['abi']);
    let versionMap;
    if (!abiCacheMap[data['account']]) {
        versionMap = [];
        versionMap.push(parseInt(data['block']));
    } else {
        versionMap = abiCacheMap[data['account']];
        versionMap.push(parseInt(data['block']));
        versionMap.sort(function (a, b) {
            return a - b;
        });
        versionMap = Array.from(new Set(versionMap));
    }
    abiCacheMap[data['account']] = versionMap;
}

function debugLog(text) {
    if (process.env.DEBUG === 'true') {
        console.log(text);
    }
}

module.exports = {
    debugLog,
    onError,
    deserialize,
    serialize,
    unzipAsync,
    getLastIndexedBlock,
    messageAllWorkers,
    printWorkerMap,
    getLastIndexedBlockFromRange,
    getFirstIndexedBlockFromRange,
    getLastIndexedBlockByDeltaFromRange,
    getLastIndexedBlockByDelta,
    getLastIndexedABI,
    onSaveAbi
};
