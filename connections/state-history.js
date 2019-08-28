const WebSocket = require('ws');

function connectStateHistorySocket(onMessage, onDisconnect, onError) {
    const ws = new WebSocket(process.env.NODEOS_WS, null, {
        perMessageDeflate: false
    });
    ws.on('open', () => {
        if (process.env.DEBUG === 'true') {
            console.log('[SHiP] websocket connected!');
        }
    });
    ws.on('message', onMessage);
    ws.on('close', () => {
        if (process.env.DEBUG === 'true') {
            console.log('[SHiP] websocket disconnected!');
        }
        onDisconnect();
    });
    ws.on('error', (err) => {
        console.log(`${process.env.NODEOS_WS} :: ${err.message}`);
    });
    return ws;
}

module.exports = {
    connectStateHistorySocket
};
