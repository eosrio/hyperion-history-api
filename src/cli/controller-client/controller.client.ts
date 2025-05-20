import {WebSocket} from "ws";
import {readConnectionConfig} from "../repair-cli/functions.js";

export class IndexerController {

    ws: any;

    constructor(private chain: string, private host?: string) {
    }

    private async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const config = readConnectionConfig();
            const controlPort = config.chains[this.chain].control_port;
            let hyperionIndexer = `ws://localhost:${controlPort}`;
            if (this.host) {
                hyperionIndexer = `ws://${this.host}:${controlPort}`;
            }

            // Set a connection timeout
            const connectionTimeout = setTimeout(() => {
                if (this.ws) {
                    this.ws.close();
                }
                reject(new Error(`Connection timeout when connecting to ${hyperionIndexer}/local`));
            }, 5000);

            this.ws = new WebSocket(hyperionIndexer + '/local');

            this.ws.on('open', () => {
                clearTimeout(connectionTimeout);
                console.log('Connected to Hyperion Controller');
                resolve();
            });

            this.ws.on('error', (error: any) => {
                clearTimeout(connectionTimeout);
                reject(new Error(`Failed to connect to Hyperion Controller: ${error.message}`));
            });
        });
    }

    async pause(type: string): Promise<string> {
        await this.connect();
        return await new Promise<string>((resolve, reject) => {
            console.log();
            console.log();

            // Set a timeout for the pause response
            const pauseTimeout = setTimeout(() => {
                reject(new Error('Timeout waiting for indexer to pause'));
            }, 10000);

            this.ws!.send(JSON.stringify({
                event: 'pause-indexer',
                type: type
            }));

            const messageHandler = (data: any) => {
                try {
                    const message = JSON.parse(data);
                    if (message.event === 'indexer-paused') {
                        clearTimeout(pauseTimeout);
                        this.ws!.off('message', messageHandler);
                        console.log('Indexer paused');
                        resolve(message.mId);
                    }
                } catch (e) {
                    console.error('Error parsing pause response:', e);
                }
            };

            this.ws!.on('message', messageHandler);

            this.ws!.on('close', () => {
                clearTimeout(pauseTimeout);
                reject(new Error('Connection closed while waiting for indexer to pause'));
            });

            this.ws!.on('error', (error: any) => {
                clearTimeout(pauseTimeout);
                reject(new Error(`WebSocket error during pause operation: ${error.message}`));
            });
        });
    }

    async resume(type: string, mId: string): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            await this.connect();
        }
        await new Promise<void>((resolve, reject) => {
            // Set a timeout for the resume response
            const resumeTimeout = setTimeout(() => {
                reject(new Error('Timeout waiting for indexer to resume'));
            }, 10000);

            this.ws!.send(JSON.stringify({
                event: 'resume-indexer',
                type: type,
                mId: mId
            }));

            const messageHandler = (data: any) => {
                try {
                    const message = JSON.parse(data);
                    if (message.event === 'indexer-resumed') {
                        clearTimeout(resumeTimeout);
                        this.ws!.off('message', messageHandler);
                        console.log('Indexer resumed');
                        resolve();
                    }
                } catch (e) {
                    console.error('Error parsing resume response:', e);
                }
            };

            this.ws!.on('message', messageHandler);

            this.ws!.on('close', () => {
                clearTimeout(resumeTimeout);
                reject(new Error('Connection closed while waiting for indexer to resume'));
            });

            this.ws!.on('error', (error: any) => {
                clearTimeout(resumeTimeout);
                reject(new Error(`WebSocket error during resume operation: ${error.message}`));
            });
        });
    }

    close() {
        if (this.ws) {
            this.ws.close();
        }
    }

    async stop() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            await this.connect();
        }
        await new Promise<void>((resolve, reject) => {
            // Set a timeout for the stop response
            const stopTimeout = setTimeout(() => {
                reject(new Error('Timeout waiting for indexer to stop'));
            }, 60000);

            this.ws!.send(JSON.stringify({event: 'stop-indexer'}));
            const messageHandler = (data: any) => {
                try {
                    const message = JSON.parse(data);
                    if (message.event === 'indexer-stopped') {
                        clearTimeout(stopTimeout);
                        this.ws!.off('message', messageHandler);
                        resolve();
                    } else {
                        console.log(message);
                    }
                } catch (e) {
                    console.error('Error parsing resume response:', e);
                }
            };

            this.ws!.on('message', messageHandler);

            this.ws!.on('close', () => {
                clearTimeout(stopTimeout);
                reject(new Error('Connection closed while waiting for indexer to stop'));
            });

            this.ws!.on('error', (error: any) => {
                clearTimeout(stopTimeout);
                reject(new Error(`WebSocket error during stop operation: ${error.message}`));
            });
        });
    }
}