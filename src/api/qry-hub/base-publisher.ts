import { PrivateKey, PublicKey } from "@wharfkit/antelope";
import { io, Socket as SocketIO } from "socket.io-client";
import { hLog } from "../../indexer/helpers/common_functions.js";

export const DEFAULT_HUB_URL = 'api.hub.qry.network';

export interface QRYPublisherOptions {
    // host ("api.hub.qry.network", "localhost:3501") or full URL ("https://hub.example/ws/providers")
    hubUrl?: string;
    instancePrivateKey: string;
    metadata?: any;
    onConnect?: () => void;
    onMetadataRequest?: () => void;
    // reconnect backoff, in milliseconds
    minRetryDelayMs?: number;
    maxRetryDelayMs?: number;
}

export interface HubEndpoints {
    // base for the HTTP login routes (/challenge, /session)
    httpBase: string;
    // origin for the socket.io connection and its path
    socketOrigin: string;
    socketPath: string;
}

// Bare hosts keep the historical behavior: localhost talks to the hub ports directly, any
// other host goes through the public proxy under /ws/providers. A full URL is used as given.
export function resolveHubEndpoints(hubUrl: string = DEFAULT_HUB_URL): HubEndpoints {
    const raw = hubUrl.trim().replace(/\/+$/, '');
    let url: URL;
    if (/^[a-z]+:\/\//i.test(raw)) {
        url = new URL(raw);
    } else if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(raw)) {
        url = new URL(`http://${raw}`);
    } else {
        url = new URL(`https://${raw}`);
        if (url.pathname === '/' || url.pathname === '') {
            url.pathname = '/ws/providers';
        }
    }
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Unsupported hub URL protocol: ${url.protocol}`);
    }
    const basePath = url.pathname.replace(/\/+$/, '');
    return {
        httpBase: `${url.origin}${basePath}`,
        socketOrigin: `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`,
        socketPath: `${basePath}/socket.io`,
    };
}

// Exponential backoff with full jitter, capped.
export function retryDelay(attempt: number, minMs: number, maxMs: number, random: () => number = Math.random): number {
    const ceiling = Math.min(maxMs, minMs * 2 ** Math.max(0, attempt));
    return Math.round(minMs + random() * (ceiling - minMs));
}

export class QRYBasePublisher {
    private opts: QRYPublisherOptions;
    private endpoints: HubEndpoints;

    // instance keys
    private privateKey: PrivateKey;
    publicKey: PublicKey;
    socket?: SocketIO;

    sessionToken?: string;
    metadata?: any;

    onConnect?: () => void;
    onMetadataRequest?: () => void;

    private stopped = false;
    private attempt = 0;
    private retryTimer?: ReturnType<typeof setTimeout>;
    private connecting = false;
    private notRegisteredLogged = false;

    // Throws on an invalid key or hub URL; the caller decides to run without the hub.
    constructor(options: QRYPublisherOptions) {
        this.opts = options;
        this.onConnect = options.onConnect;
        this.onMetadataRequest = options.onMetadataRequest;
        this.metadata = options.metadata;
        if (!this.opts.instancePrivateKey) {
            throw new Error('Instance private key is required');
        }
        this.privateKey = PrivateKey.fromString(this.opts.instancePrivateKey);
        this.publicKey = this.privateKey.toPublic();
        this.endpoints = resolveHubEndpoints(this.opts.hubUrl);
    }

    get hubBase(): string {
        return this.endpoints.httpBase;
    }

    get connected(): boolean {
        return this.socket?.connected === true;
    }

    // Starts the connection loop and returns at once; the API never waits on the hub.
    connect() {
        this.stopped = false;
        this.openSession().catch(e => hLog(`QRY Hub connection error: ${e.message}`));
    }

    close() {
        this.stopped = true;
        clearTimeout(this.retryTimer);
        this.dropSocket();
    }

    // Every (re)connection runs the full challenge/session login, so an expired or rejected
    // session is replaced instead of being re-sent forever.
    private async openSession() {
        if (this.stopped || this.connecting) {
            return;
        }
        this.connecting = true;
        try {
            const challenge = await this.requestChallenge();
            if (!challenge) {
                return this.scheduleReconnect();
            }
            const token = await this.requestSession(challenge);
            if (!token) {
                return this.scheduleReconnect();
            }
            this.sessionToken = token;
            this.openSocket();
        } catch (e: any) {
            hLog(`QRY Hub login failed: ${e.message}`);
            this.scheduleReconnect();
        } finally {
            this.connecting = false;
        }
    }

    private openSocket() {
        this.dropSocket();
        const socket = io(this.endpoints.socketOrigin, {
            path: this.endpoints.socketPath,
            transports: ['websocket'],
            // reconnects are handled here so that each one gets a fresh session
            reconnection: false,
            auth: (cb) => {
                cb({
                    publicKey: this.publicKey.toString(),
                    token: this.sessionToken
                });
            }
        });
        this.socket = socket;

        socket.on('connect', () => {
            this.attempt = 0;
            this.notRegisteredLogged = false;
            hLog('✅  Connected to QRY Hub');
            if (typeof this.onConnect === 'function') {
                this.onConnect();
            }
        });

        socket.on('message', (msg: any) => {
            if (msg === 'metadata-request') {
                if (this.metadata) {
                    this.sendMetadata(this.metadata);
                }
                if (typeof this.onMetadataRequest === 'function') {
                    this.onMetadataRequest();
                }
            }
        });

        socket.on('error', (error: any) => {
            if (error === 'SESSION_EXPIRED') {
                hLog('QRY Hub session expired, logging in again');
            } else if (error === 'INSTANCE_NOT_REGISTERED') {
                this.logNotRegistered();
            } else {
                hLog('QRY Hub socket error:', error);
            }
        });

        // Covers server-side disconnects too, after which socket.io would not retry on its own.
        socket.on('disconnect', (reason) => {
            if (this.socket !== socket || this.stopped) {
                return;
            }
            hLog(`Disconnected from QRY Hub (${reason})`);
            this.scheduleReconnect();
        });

        socket.on('connect_error', (error: Error) => {
            if (this.socket !== socket || this.stopped) {
                return;
            }
            hLog(`QRY Hub connection failed: ${error.message}`);
            this.scheduleReconnect();
        });
    }

    private dropSocket() {
        const socket = this.socket;
        this.socket = undefined;
        if (socket) {
            socket.removeAllListeners();
            socket.disconnect();
        }
    }

    private scheduleReconnect() {
        if (this.stopped || this.retryTimer) {
            return;
        }
        const delay = retryDelay(this.attempt++, this.opts.minRetryDelayMs ?? 3000, this.opts.maxRetryDelayMs ?? 300000);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.openSession().catch(e => hLog(`QRY Hub reconnect error: ${e.message}`));
        }, delay);
    }

    private logNotRegistered() {
        if (!this.notRegisteredLogged) {
            hLog(`QRY Hub: instance ${this.publicKey.toString()} is not registered; retrying with backoff`);
            this.notRegisteredLogged = true;
        }
    }

    private async requestChallenge(): Promise<string | null> {
        const response = await fetch(`${this.endpoints.httpBase}/challenge`, {
            method: 'GET',
            headers: {
                'Content-Type': 'text/plain',
                'X-Instance-Key': this.publicKey.toString(),
            },
            signal: AbortSignal.timeout(10000),
        });
        const body = await response.text();
        if (response.status === 200) {
            return body;
        }
        if (body === 'INSTANCE_NOT_REGISTERED') {
            this.logNotRegistered();
        } else {
            hLog(`QRY Hub challenge failed (${response.status}): ${body.slice(0, 200)}`);
        }
        return null;
    }

    private async requestSession(challenge: string): Promise<string | null> {
        const signature = this.privateKey.signMessage(challenge);
        const response = await fetch(`${this.endpoints.httpBase}/session`, {
            method: 'GET',
            headers: {
                'Content-Type': 'text/plain',
                'X-Instance-Key': this.publicKey.toString(),
                'X-Signature': signature.toString(),
            },
            signal: AbortSignal.timeout(10000),
        });
        const body = await response.text();
        if (response.status !== 200) {
            hLog(`QRY Hub session failed (${response.status}): ${body.slice(0, 200)}`);
            return null;
        }
        return body;
    }

    public sendMetadata(data: any) {
        this.socket?.connected && this.socket.emit('instance-metadata', data);
    }

    // Records are dropped while disconnected; usage is re-sent in full on the next metadata request.
    public publish(data: any) {
        this.socket?.connected && this.socket.emit('instance-data', data);
    }

    publishApiUsage(counter: number, timestamp?: string) {
        this.publish({type: 'api_usage', data: {counter, timestamp}});
    }

    publishPastApiUsage(dataPoints: { ct: number, ts: string }[]) {
        hLog(`Publishing past API usage to hub: ${dataPoints.length} data points`);
        this.publish({type: 'past_api_usage', data: dataPoints});
    }

    publishIndexerStatus(status: 'none' | 'offline' | 'delayed' | 'active') {
        hLog(`Publishing indexer status to hub: ${status}`);
        this.publish({type: 'indexer_status', data: {status}});
    }
}
