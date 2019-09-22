const WebSocket = require('ws');

class StateHistorySocket {
    #ws;
    #shipUrl;

    constructor(ship_url) {
        this.#shipUrl = ship_url;
    }

    connect(onMessage, onDisconnect, onError) {
        this.#ws = new WebSocket(this.#shipUrl, null, {
            perMessageDeflate: false
        });
        this.#ws.on('open', () => {
            if (process.env.DEBUG === 'true') {
                console.log('[SHiP] websocket connected!');
            }
        });
        this.#ws.on('message', onMessage);
        this.#ws.on('close', () => {
            if (process.env.DEBUG === 'true') {
                console.log('[SHiP] websocket disconnected!');
            }
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
