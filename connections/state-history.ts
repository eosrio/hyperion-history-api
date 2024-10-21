import {debugLog, hLog} from "../helpers/common_functions";

import WebSocket from 'ws';

export class StateHistorySocket {
    private ws;
    private shipUrl;
    private readonly max_payload_mb;
    retryOnDisconnect = true;
    connected = false;

    selectedUrlIndex = 0;
    shipEndpoints: string[] = [];

    constructor(ship_url: string | string[], max_payload_mb: number) {

        if (Array.isArray(ship_url)) {
            this.shipUrl = ship_url[0];
            this.shipEndpoints = ship_url;
        } else {
            this.shipUrl = ship_url;
        }

        if (max_payload_mb) {
            this.max_payload_mb = max_payload_mb;
        } else {
            this.max_payload_mb = 256;
        }
    }

    nextUrl() {
        if(this.shipEndpoints.length > 0) {
            this.selectedUrlIndex++;
            if(this.selectedUrlIndex >= this.shipEndpoints.length) {
                this.selectedUrlIndex = 0;
            }
            this.shipUrl = this.shipEndpoints[this.selectedUrlIndex];
            hLog(`Switching to next endpoint: ${this.shipUrl}`);
        }
    }

    connect(
        onMessage: (data: WebSocket.MessageEvent) => void,
        onDisconnect: () => void,
        onError: (event: WebSocket.ErrorEvent) => void,
        onConnected: () => void
    ) {
        debugLog(`Connecting to ${this.shipUrl}...`);
        this.ws = new WebSocket(this.shipUrl, {
            perMessageDeflate: false,
            maxPayload: this.max_payload_mb * 1024 * 1024,
        });
        this.ws.on('open', () => {
            this.connected = true;
            hLog('Websocket connected!');
            if (onConnected) {
                onConnected();
            }
        });
        this.ws.on('error', (event: WebSocket.ErrorEvent) => {
            onError(event);
        });
        this.ws.on('message', (data: WebSocket.MessageEvent) => onMessage(data));
        this.ws.on('close', () => {
            this.connected = false;
            hLog('Websocket disconnected!');
            if (this.retryOnDisconnect) {
                onDisconnect();
            }
        });
        this.ws.on('error', (err) => {
            hLog(`${this.shipUrl} :: ${err.message}`);
        });
    }

    close(graceful: boolean) {
        if (graceful) {
            this.retryOnDisconnect = false;
        }
        this.ws.close();
    }

    send(payload) {
        this.ws.send(payload);
    }
}
