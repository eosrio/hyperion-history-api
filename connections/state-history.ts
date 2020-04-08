import {hLog} from "../helpers/common_functions";

const WebSocket = require('ws');

export class StateHistorySocket {
    private ws;
    private readonly shipUrl;

    constructor(ship_url) {
        this.shipUrl = ship_url;
    }

    connect(onMessage, onDisconnect, onError, onConnected) {
        hLog(`Connecting to ${this.shipUrl}...`);
        this.ws = new WebSocket(this.shipUrl, null, {
            perMessageDeflate: false
        });
        this.ws.on('open', () => {
            hLog('Websocket connected!');
            if (onConnected) {
                onConnected();
            }
        });
        this.ws.on('message', onMessage);
        this.ws.on('close', () => {
            hLog('Websocket disconnected!');
            onDisconnect();
        });
        this.ws.on('error', (err) => {
            hLog(`${this.shipUrl} :: ${err.message}`);
        });
    }

    close() {
        this.ws.close();
    }

    send(payload) {
        this.ws.send(payload);
    }
}
