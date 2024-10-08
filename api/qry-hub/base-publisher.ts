import {PrivateKey, PublicKey} from "@wharfkit/antelope";
import {io, Socket as SocketIO} from "socket.io-client";
import {hLog} from "../../helpers/common_functions";

export interface QRYPublisherOptions {
    hubUrl: string;
    instancePrivateKey: string;
}

export class QRYBasePublisher {
    private opts: QRYPublisherOptions;

    // instance keys
    private privateKey!: PrivateKey;
    publicKey!: PublicKey;
    private socket?: SocketIO;

    sessionToken?: string;
    private metadata: any;

    onConnect?: () => void;

    constructor(options: QRYPublisherOptions) {
        this.opts = options;
        if (!this.opts.instancePrivateKey) {
            throw new Error('Instance private key is required');
        }
        this.checkPrivateKey();
    }

    private checkPrivateKey() {
        try {
            this.privateKey = PrivateKey.fromString(this.opts.instancePrivateKey);
        } catch (e: any) {
            console.log(`FATAL ERROR: ${e.message}`);
            process.exit();
        }
        if (this.privateKey) {
            this.publicKey = this.privateKey.toPublic();
        }
    }

    async connect() {
        // request challenge from hub based on the public key
        const challenge = await this.requestChallenge();
        if (!challenge) {
            console.log('Failed to get challenge from hub');
            return;
        }
        // send signature to hub for verification
        const token = await this.requestSession(challenge);
        if (!token) {
            console.log('Failed to get session token from hub');
            return;
        }
        this.sessionToken = token;
        const protocol = this.opts.hubUrl.startsWith('localhost') ? 'ws' : 'wss';
        this.socket = io(`${protocol}://${this.opts.hubUrl}`, {
            path: this.opts.hubUrl.startsWith('localhost') ? undefined : '/ws/providers/socket.io',
            transports: ['websocket'],
            auth: (cb) => {
                cb({
                    publicKey: this.publicKey.toString(),
                    token: this.sessionToken
                });
            }
        });
        this.socket.on('connect', () => {
            hLog('✅  Connected to QRY Hub');
            this.sendMetadata(this.metadata);
            this.onConnect?.();
        });
        this.socket.on('disconnect', (reason) => {
            hLog('Disconnected from hub', reason);
        });
        this.socket.on('error', (error: any) => {
            hLog('Socket error:', error);
            if (error === 'INSTANCE_NOT_REGISTERED') {
                console.error('Instance not registered');
            }
        });
    }

    private async requestSession(challenge: string) {
        // console.log('Sending signature to hub...');
        const signature = this.privateKey.signMessage(challenge);
        let url = `http://${this.opts.hubUrl}/session`;
        if (!this.opts.hubUrl.startsWith('localhost')) {
            url = `https://${this.opts.hubUrl}/ws/providers/session`;
        }
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'plain/text',
                'X-Instance-Key': this.publicKey.toString(),
                'X-Signature': signature.toString(),
            },
        });
        if (response.status !== 200) {
            return null;
        } else {
            return await response.text();
        }
    }

    private async requestChallenge() {
        // console.log('Requesting challenge from hub...');
        let url = `http://${this.opts.hubUrl}/challenge`;
        if (!this.opts.hubUrl.startsWith('localhost')) {
            url = `https://${this.opts.hubUrl}/ws/providers/challenge`;
        }
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'text/plain',
                'X-Instance-Key': this.publicKey.toString(),
            },
        });
        if (response.status !== 200) {
            const error = await response.text();
            if (error === 'INSTANCE_NOT_REGISTERED') {
                console.error('Instance not registered');
                return null;
            } else {
                console.error('Failed to get challenge from hub');
                console.error(error);
                return null;
            }
        } else {
            return await response.text();
        }
    }

    public sendMetadata(data: any) {
        if (!this.socket) {
            console.error('Socket not connected');
            return;
        }
        this.socket.emit('instance-metadata', data);
    }

    public publish(data: any) {
        if (!this.socket) {
            console.error('Socket not connected');
            return;
        }
        this.socket.emit('instance-data', data);
    }

    setMetadata(meta: any) {
        this.metadata = meta;
    }

    publishApiUsage(counter: number, timestamp?: string) {
        this.publish({
            type: 'api_usage',
            data: {counter, timestamp}
        });
    }

    publishPastApiUsage(datapoints: {ct: number, ts: string}[]) {
        this.publish({
            type: 'past_api_usage',
            data: datapoints
        });
    }

    publishIndexerStatus(status: 'none' | 'offline' | 'delayed' | 'active') {
        hLog(`Publishing indexer status to hub: ${status}`);
        this.publish({
            type: 'indexer_status',
            data: {status}
        });
    }
}