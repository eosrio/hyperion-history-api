import {debugLog, hLog} from "../helpers/common_functions.js";

import WebSocket, {RawData, ErrorEvent} from 'ws';

export class StateHistorySocket {
    private ws?: WebSocket;
    private shipUrl;
    private readonly max_payload_mb;
    private shipUrls: string[];
    public activeShipIndex = 0;

    constructor(shipUrl: string | string[], max_payload_mb: number) {

        if (shipUrl instanceof Array) {
            this.shipUrl = shipUrl[this.activeShipIndex];
            this.shipUrls = shipUrl;
        } else {
            this.shipUrl = shipUrl;
            this.shipUrls = [shipUrl];
        }

        if (max_payload_mb) {
            this.max_payload_mb = max_payload_mb;
        } else {
            this.max_payload_mb = 256;
        }
    }

    setShipUrls(urls: string[]) {
        this.shipUrls = urls;
    }

    setActiveIndex(idx: number) {
        if (idx < this.shipUrls.length) {
            if (this.shipUrls[idx]) {
                this.shipUrl = this.shipUrls[idx];
                hLog(`Setting ship url to: ${this.shipUrl}`);
            }
        }
    }

    useNextShip() {
        this.activeShipIndex++;
        if (this.activeShipIndex >= this.shipUrls.length) {
            this.activeShipIndex = 0;
        }
        this.setActiveIndex(this.activeShipIndex);
    }

    connect(
        onMessage: (data: RawData) => void,
        onDisconnect: () => void,
        onError: (err: ErrorEvent) => void,
        onConnected: () => void
    ) {
        debugLog(`Connecting to ${this.shipUrl}...`);
        hLog(`Connecting to ${this.shipUrl}...`);
        this.ws = new WebSocket(this.shipUrl, {
            perMessageDeflate: false,
            maxPayload: this.max_payload_mb * 1024 * 1024,
            handshakeTimeout: 1000,
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
