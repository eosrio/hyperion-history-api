const WebSocket = require('ws');

function connectStateHistorySocket(onMessage) {
    const ws = new WebSocket(process.env.NODEOS_WS, null, {
        perMessageDeflate: false
    });
    ws.on('message', onMessage);
    return ws;
}

module.exports = {
    connectStateHistorySocket
};
