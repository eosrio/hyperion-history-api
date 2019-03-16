const WebSocket = require('ws');

function connectStateHistorySocket(onMessage) {
    const ws = new WebSocket(process.env.NODEOS_WS, null, {
        perMessageDeflate: false
    });
    ws.on('open', () => {
        console.log('[SHiP] websocket connected!');
    });
    ws.on('message', onMessage);
    ws.on('close', () => {
        console.log('[SHiP] websocket disconnected!');
    });
    return ws;
}

module.exports = {
    connectStateHistorySocket
};
