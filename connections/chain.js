const fetch = require('node-fetch');
const {JsonRpc} = require('eosjs');

function connectRpc() {
    const eos_endpoint = process.env.NODEOS_HTTP;
    return new JsonRpc(eos_endpoint, {fetch});
}

module.exports = {
    connectRpc
};
