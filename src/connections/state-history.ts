import {debugLog, hLog} from "../helpers/common_functions.js";

import WebSocket, {RawData, ErrorEvent} from 'ws';

export class StateHistorySocket {
    private ws?: WebSocket;
    private readonly shipUrl;
    private readonly max_payload_mb;

    constructor(ship_url: string, max_payload_mb: number) {
        this.shipUrl = ship_url;
        if (max_payload_mb) {
            this.max_payload_mb = max_payload_mb;
        } else {
            this.max_payload_mb = 256;
        }
    }

    connect(
        onMessage: (data: RawData) => void,
        onDisconnect: () => void,
        onError: (err: ErrorEvent) => void,
        onConnected: () => void
    ) {
        debugLog(`Connecting to ${this.shipUrl}...`);
        this.ws = new WebSocket(this.shipUrl, {
            perMessageDeflate: false,
            maxPayload: this.max_payload_mb * 1024 * 1024,
        });
        this.ws.on('open', () => {
            hLog('Websocket connected!');
            if (onConnected) {
                onConnected();
            }
        });
        this.ws.on('message', (data: RawData) => {
            if (onMessage) {
                onMessage(data);
            }
        });
        this.ws.on('close', () => {
            hLog('Websocket disconnected!');
            if (onDisconnect) {
                onDisconnect();
            }
        });
        this.ws.on('error', (err: ErrorEvent) => {
            hLog(`${this.shipUrl} :: ${err.message}`);
            onError(err);
        });
    }

    close() {
        if (this.ws) {
            this.ws.close();
        }
    }

    send(payload: any) {
        if (this.ws) {
            this.ws.send(payload);
        }
    }
}
