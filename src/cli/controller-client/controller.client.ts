import { WebSocket, RawData } from "ws";
import { readConnectionConfig } from "../repair-cli/functions.js";
import { HyperionConnections } from "../../interfaces/hyperionConnections.js";

export class IndexerController {

    ws: WebSocket | null = null;
    private connectionPromise: Promise<void> | null = null;

    constructor(private chain: string, private host?: string) { }

    private async connect(): Promise<void> {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }

        if (this.connectionPromise) {
            return this.connectionPromise;
        }

        this.connectionPromise = new Promise((resolve, reject) => {
            let config: HyperionConnections;
            try {
                config = readConnectionConfig();
            } catch (err: any) {
                this.connectionPromise = null;
                if (err.code === 'ENOENT') {
                    reject(new Error(
                        `\\n[Hyperion CLI Error]\\n` +
                        `Could not find the required configuration file: 'config/connections.json'.\\n` +
                        `\\nTo fix this, you can:\\n` +
                        `  1. Run \\x1b[36m./hyp-config connections init\\x1b[0m to create a new configuration interactively.\\n` +
                        `  2. Or copy the example: \\x1b[36mcp references/connections.ref.json config/connections.json\\x1b[0m\\n` +
                        `\\nSee './hyp-config connections --help' for more options.`
                    ));
                } else {
                    reject(new Error(`Error reading connection config: ${err.message}`));
                }
                return;
            }

            const chainConfig = config.chains[this.chain];
            if (!chainConfig) {
                this.connectionPromise = null;
                reject(new Error(`No configuration found for chain: ${this.chain}`));
                return;
            }
            const controlPort = chainConfig.control_port;
            let hyperionIndexer = `ws://localhost:${controlPort}`;
            if (this.host) {
                hyperionIndexer = `ws://${this.host}:${controlPort}`;
            }

            // Clean up any existing socket before creating a new one
            if (this.ws) {
                this.ws.removeAllListeners();
                if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                    this.ws.terminate(); // Force close if not already closed
                }
                this.ws = null;
            }

            const newWs = new WebSocket(hyperionIndexer + '/local');
            let connectionTimeoutId: NodeJS.Timeout;

            const onOpen = () => {
                clearTimeout(connectionTimeoutId);
                newWs.off('error', onError);
                this.ws = newWs;
                console.log('Connected to Hyperion Controller');
                this.connectionPromise = null;
                resolve();
            };

            const onError = (error: Error) => {
                clearTimeout(connectionTimeoutId);
                newWs.off('open', onOpen);
                if (this.ws === newWs) {
                    this.ws = null;
                }
                this.connectionPromise = null;
                reject(new Error(`Failed to connect to Hyperion Controller: ${error.message}`));
            };

            connectionTimeoutId = setTimeout(() => {
                newWs.off('open', onOpen);
                newWs.off('error', onError);
                if (newWs.readyState !== WebSocket.OPEN && newWs.readyState !== WebSocket.CLOSED) {
                    newWs.terminate();
                }
                if (this.ws === newWs) {
                    this.ws = null;
                }
                this.connectionPromise = null;
                reject(new Error(`Connection timeout when connecting to ${hyperionIndexer}/local`));
            }, 5000);

            newWs.on('open', onOpen);
            newWs.on('error', onError);
        });
        return this.connectionPromise;
    }

    private async _sendRequestAndAwaitResponse<T>(
        requestPayload: any,
        successCondition: (
            message: any,
            resolve: (value: T | PromiseLike<T>) => void,
            reject: (reason?: any) => void
        ) => boolean,
        operationDescription: string,
        timeoutMs: number = 10000,
        customParseErrorHandler?: (error: any, rawMessageText?: string) => void
    ): Promise<T> {

        await this.connect();

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket connection is not open after connect() attempt.');
        }

        const currentWs = this.ws;

        return new Promise<T>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                cleanupListeners();
                reject(new Error(`Timeout waiting for ${operationDescription}`));
            }, timeoutMs);

            let messageHandler: ((rawData: RawData) => void) | null = null;
            let closeHandler: ((code: number, reason: Buffer) => void) | null = null;
            let errorHandler: ((error: Error) => void) | null = null;

            const cleanupListeners = () => {
                clearTimeout(timeoutId);
                if (currentWs) {
                    if (messageHandler) currentWs.off('message', messageHandler);
                    if (closeHandler) currentWs.off('close', closeHandler);
                    if (errorHandler) currentWs.off('error', errorHandler);
                }
            };

            const resolveWrapper = (value: T | PromiseLike<T>) => {
                cleanupListeners();
                resolve(value);
            };

            const rejectWrapper = (reason?: any) => {
                cleanupListeners();
                reject(reason);
            };

            messageHandler = (rawData: RawData) => {
                const messageText = rawData.toString();
                try {
                    const message = JSON.parse(messageText);
                    // successCondition returns true if it handled the message (called resolve/reject)
                    // or false if it's an interim message (e.g. stop() logging)
                    if (successCondition(message, resolveWrapper, rejectWrapper)) {
                        // If true, resolve/reject (and thus cleanup) was called by successCondition
                    }
                } catch (e) {
                    if (customParseErrorHandler) {
                        customParseErrorHandler(e, messageText);
                    } else {
                        console.error(`Error parsing ${operationDescription} response JSON: "${messageText}". Error:`, e);
                    }
                }
            };

            closeHandler = () => {
                cleanupListeners();
                reject(new Error(`Connection closed while waiting for ${operationDescription}`));
            };

            errorHandler = (error: Error) => {
                cleanupListeners();
                reject(new Error(`WebSocket error during ${operationDescription} operation: ${error.message}`));
            };

            currentWs.on('message', messageHandler);
            currentWs.on('close', closeHandler);
            currentWs.on('error', errorHandler);

            currentWs.send(JSON.stringify(requestPayload), (sendError) => {
                if (sendError) {
                    cleanupListeners();
                    reject(new Error(`Failed to send message for ${operationDescription}: ${sendError.message}`));
                }
            });
        });
    }

    async pause(type: string): Promise<string> {
        return this._sendRequestAndAwaitResponse<string>(
            { event: 'pause_indexer', type: type },
            (message, resolve) => {
                if (message.event === 'indexer_paused') {
                    console.log('Indexer paused');
                    resolve(message.mId);
                    return true;
                }
                return false;
            },
            'indexer to pause',
            10000
        );
    }

    async resume(type: string, mId: string): Promise<void> {
        return this._sendRequestAndAwaitResponse<void>(
            { event: 'resume_indexer', type: type, mId: mId },
            (message, resolve) => {
                if (message.event === 'indexer_resumed') {
                    console.log('Indexer resumed');
                    resolve();
                    return true;
                }
                return false;
            },
            'indexer to resume',
            10000
        );
    }

    async start(): Promise<void> {
        return this._sendRequestAndAwaitResponse<void>(
            { event: 'start_indexer' },
            (message, resolve) => {
                if (message.event === 'indexer-started') {
                    console.log('Indexer start command acknowledged');
                    resolve();
                    return true;
                } else if (message.event === 'indexer-already-running') {
                    console.log('Indexer is already running');
                    resolve();
                    return true;
                }
                return false;
            },
            'indexer to start',
            10000,
            (error, messageText) => {
                console.error(`Error parsing start response JSON: "${messageText}". Error:`, error);
            }
        );
    }

    close() {
        if (this.connectionPromise) {
            // If a connection is actively being established, aborting it here can be complex.
            // For now, we primarily focus on closing an established or idle ws.
            // The connectionPromise itself will eventually timeout or error if ws.close() affects it.
        }
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close();
            } else if (this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
                // Only terminate if not already closing or closed to avoid errors
                this.ws.terminate();
            }
            this.ws = null;
        }
        this.connectionPromise = null;
    }

    async stop(): Promise<void> {
        return this._sendRequestAndAwaitResponse<void>(
            { event: 'stop_indexer' },
            (message, resolve) => {
                if (message.event === 'indexer_stopped') {
                    resolve();
                    return true;
                } else {
                    console.log(message); // Log other messages while waiting for 'indexer_stopped'
                }
                return false;
            },
            'indexer to stop',
            60000,
            (error, messageText) => {
                console.error(`Error parsing stop response JSON: "${messageText}". Error:`, error);
            }
        );
    }

    /**
     * Request the global usage map from the indexer master process.
     */
    async getUsageMap(): Promise<any> {
        return this._sendRequestAndAwaitResponse<any>(
            { event: 'get_usage_map' },
            (message, resolve) => {
                if (message.event === 'usage_map') {
                    // Return complete response including timing and load distribution data
                    resolve({
                        data: message.data,
                        timing: message.timing,
                        loadDistributionPeriod: message.loadDistributionPeriod
                    });
                    return true;
                }
                return false;
            },
            'usage map response',
            10000,
            () => { /* ignore parse errors */ }
        );
    }

    /**
     * Request memory usage from all workers via the indexer master process.
     */
    async getMemoryUsage(): Promise<any> {
        return this._sendRequestAndAwaitResponse<any>(
            { event: 'get_memory_usage' },
            (message, resolve) => {
                if (message.event === 'memory_usage') {
                    resolve(message.data);
                    return true;
                }
                return false;
            },
            'memory usage response',
            10000,
            () => { /* ignore parse errors */ }
        );
    }

    /**
     * Request V8 heap statistics from all workers via the indexer master process.
     */
    async getHeapStats(): Promise<any> {
        return this._sendRequestAndAwaitResponse<any>(
            { event: 'get_heap' },
            (message, resolve) => {
                if (message.event === 'v8_heap_report') {
                    resolve(message.data);
                    return true;
                }
                return false;
            },
            'heap stats response',
            10000,
            () => { /* ignore parse errors */ }
        );
    }

    async reloadContractStateConfig(contractName: string): Promise<any> {
        return this._sendRequestAndAwaitResponse<any>(
            { event: 'reload_contract_config', data: { contract: contractName } },
            (message, resolve) => {
                if (message.event === 'contract_config_reloaded') {
                    console.log('Contract state config reloaded successfully');
                    resolve(message.data);
                    return true;
                } else if (message.event === 'contract_config_reload_failed') {
                    console.error(`Failed to reload contract state config for ${contractName}: ${message.error}`);
                    resolve(null);
                    return true;
                }
                console.log(message); // Log other messages while waiting for 'contract_config_reloaded'
                return false;
            },
            'contract state config reload',
            10000
        );
    }
}