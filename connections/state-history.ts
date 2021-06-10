import {debugLog, hLog} from "../helpers/common_functions";

const WebSocket = require('ws');

export class StateHistorySocket {
    private ws;
    private readonly shipUrl;
    private readonly max_payload_mb;

    constructor(ship_url, max_payload_mb) {
        this.shipUrl = ship_url;
        if (max_payload_mb) {
            this.max_payload_mb = max_payload_mb;
        } else {
            this.max_payload_mb = 256;
        }
    }

    connect(onMessage, onDisconnect, onError, onConnected) {
        debugLog(`Connecting to ${this.shipUrl}...`);
        this.ws = new WebSocket(this.shipUrl, null, {
            perMessageDeflate: false,
            maxPayload: this.max_payload_mb * 1024 * 1024,
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
