import {debugLog, deserialize, hLog, serialize} from "../helpers/common_functions.js";
import WebSocket from 'ws';
import {Abieos} from "@eosrio/node-abieos";
import {Abi} from "eosjs/dist/eosjs-rpc-interfaces.js";
import {Serialize} from "eosjs";

export interface ShipServer {
    node: LabelledShipNode;
    chainId: string;
    active: boolean;
    traceBeginBlock: number;
    traceEndBlock: number;
}

export interface LabelledShipNode {
    label: string;
    url: string;
}

export class StateHistorySocket {
    private ws;
    private readonly max_payload_mb;
    retryOnDisconnect = true;
    connected = false;

    selectedUrlIndex = 0;
    shipEndpoints: LabelledShipNode[] = [];
    private shipNode: LabelledShipNode;
    private shipNodes: ShipServer[] = [];

    constructor(ship_url: string | (string | LabelledShipNode)[], max_payload_mb?: number) {

        const shipNodeData = process.env.validated_ship_servers;
        if (shipNodeData) {
            try {
                const validatedShipNodes = JSON.parse(shipNodeData);
                if (validatedShipNodes.length > 0) {
                    this.shipNodes = validatedShipNodes;
                    const activeNodes = validatedShipNodes.filter((s: ShipServer) => s.active);

                    if (activeNodes.length === 0) {
                        hLog('[FATAL ERROR] No active SHIP servers found!');
                    }

                    this.shipNode = activeNodes[0].node;
                }
            } catch (e: any) {
                hLog(`Error parsing validated ship servers: ${e.message}`);
                process.exit(1);
            }
        }

        if (Array.isArray(ship_url)) {
            const first = ship_url[0];
            if (typeof first === 'string') {
                this.shipNode = {label: 'primary', url: first};
            } else {
                this.shipNode = first;
            }
            this.shipEndpoints = ship_url.map((item, idx) => {
                if (typeof item === 'string') {
                    return {label: idx === 0 ? 'primary' : `node-${idx + 1}`, url: item};
                } else {
                    return item;
                }
            });
        } else {
            this.shipNode = {label: 'primary', url: ship_url};
            this.shipEndpoints = [this.shipNode];
        }

        if (max_payload_mb) {
            this.max_payload_mb = max_payload_mb;
        } else {
            this.max_payload_mb = 256;
        }
    }

    nextUrl() {
        if (this.shipNodes.length > 0) {
            this.selectedUrlIndex++;
            if (this.selectedUrlIndex >= this.shipNodes.length) {
                this.selectedUrlIndex = 0;
            }
            this.shipNode = this.shipNodes[this.selectedUrlIndex].node;
            hLog(`Switching to next endpoint: ${this.shipNode.label} - ${this.shipNode.url}`);
        }
    }

    connect(
        onMessage: (data: WebSocket.MessageEvent) => void,
        onDisconnect: () => void,
        onError: (event: WebSocket.ErrorEvent) => void,
        onConnected: () => void
    ) {
        debugLog(`Connecting to (${this.shipNode.label}) ${this.shipNode.url}...`);
        this.ws = new WebSocket(this.shipNode.url, {
            perMessageDeflate: false,
            maxPayload: this.max_payload_mb * 1024 * 1024,
        });
        this.ws.on('open', () => {
            this.connected = true;
            hLog(`Websocket connected! | Using ${this.shipNode.label}: ${this.shipNode.url}`);
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
            hLog(`${this.shipNode.url} (${this.shipNode.label} :: ${err.message}`);
        });
    }

    close(graceful: boolean) {
        if (graceful) {
            this.retryOnDisconnect = false;
        }
        this.ws.close();
    }

    send(payload: Uint8Array) {
        this.ws.send(payload);
    }

    async validateShipServers(chainId: string): Promise<ShipServer[]> {
        let servers = this.shipEndpoints.map((node: LabelledShipNode) => {
            return {
                active: false,
                chainId: '',
                node,
                traceBeginBlock: 0,
                traceEndBlock: 0
            };
        });

        await this.testShipServers(servers);

        // remove servers from other chains
        servers = servers.filter(s => {
            if (s.chainId.toLowerCase() === chainId.toLowerCase()) {
                return true;
            } else {
                if (s.chainId) {
                    hLog(`⚠️⚠️️ Removing SHIP Server ${s.node.url} :: Chain ID mismatch`);
                    hLog(`⚠️⚠️ Expected: ${chainId}`);
                    hLog(`⚠️⚠️ Found: ${s.chainId}`);
                }
                return false;
            }
        });

        const uniqueUrls = new Set();

        servers = servers.filter(s => {
            if (uniqueUrls.has(s.node.url)) {
                hLog(`⚠️ Removing SHIP Server ${s.node.url} :: Duplicate URL`);
                return false;
            }
            uniqueUrls.add(s.node.url);
            return true;
        });

        return servers;
    }

    private async testShipServers(servers: ShipServer[]) {
        for (const server of servers) {
            await this.testShipServer(server);
        }
    }

    private async testShipServer(server: ShipServer) {
        await new Promise<void>(resolve => {
            let protocolAbi: Abi | undefined = undefined;
            let types: Map<string, Serialize.Type>;

            const abieos = Abieos.getInstance();
            const tables = new Map();
            const txEnc = new TextEncoder();
            const txDec = new TextDecoder();

            const timeout = setTimeout(() => {
                server.active = false;
                hLog(`Testing SHIP Server ${server.node.url} :: Timeout after 5s`);
                resolve();
            }, 5000);

            hLog(`Testing SHIP Server ${server.node.url}`);
            const tempWS = new WebSocket(server.node.url);
            tempWS.on('message', (data) => {
                if (!protocolAbi) {
                    const abiString = data.toString();
                    abieos.loadAbi("0", abiString);
                    protocolAbi = JSON.parse(abiString) as Abi;
                    types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), protocolAbi);
                    protocolAbi.tables.map((table) => {
                        return tables.set(table.name, table.type);
                    });
                    // notify master about first abi
                    // process.send?.({event: 'init_abi', data: abiString});
                    // request status
                    tempWS.send(serialize('request', ['get_status_request_v0', {}], txEnc, txDec, types));
                } else {
                    const result = deserialize('result', data, txEnc, txDec, types);
                    if (result[0] === 'get_status_result_v0') {
                        if (result[1].chain_id) {
                            server.chainId = result[1].chain_id.toLowerCase();
                            server.traceBeginBlock = result[1].trace_begin_block;
                            server.traceEndBlock = result[1].trace_end_block;
                            server.active = true;
                            clearTimeout(timeout);
                            tempWS.close();
                        }
                    }
                }
            });
            tempWS.on('error', (err) => {
                hLog(`${server.node.label} SHIP Test Failed ${server.node.url} :: ${err.message}`);
                server.active = false;
                tempWS.close();
            });
            tempWS.on('close', () => {
                resolve();
            });
        });
    }
}
