const {Serialize} = require('eosjs');
const zlib = require('zlib');

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

module.exports = {
    onError,
    deserialize,
    serialize,
    unzipAsync
};
