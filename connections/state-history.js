const WebSocket = require('ws');

class StateHistorySocket {
    #ws;
    #shipUrl;

    constructor(ship_url) {
        this.#shipUrl = ship_url;
    }

    connect(onMessage, onDisconnect, onError, onConnected) {
        console.log(`[SHIP] Connecting to ${this.#shipUrl}...`);
        this.#ws = new WebSocket(this.#shipUrl, null, {
            perMessageDeflate: false
        });
        this.#ws.on('open', () => {
            console.log('[SHIP] Websocket connected!');
            if (onConnected) {
                onConnected();
            }
        });
        this.#ws.on('message', onMessage);
        this.#ws.on('close', () => {
            console.log('[SHIP] Websocket disconnected!');
            onDisconnect();
        });
        this.#ws.on('error', (err) => {
            console.log(`${this.#shipUrl} :: ${err.message}`);
        });
    }

    close() {
        this.#ws.close();
    }

    send(payload) {
        this.#ws.send(payload);
    }
}

module.exports = {
    StateHistorySocket
};
