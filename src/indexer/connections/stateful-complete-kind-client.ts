import {MongoClient, type MongoClientOptions} from 'mongodb';

/** One lazy bounded pool per chain/manager. Credentials remain in the existing host configuration. */
export class StatefulCompleteKindMongoClient {
    private pending?: Promise<MongoClient>;
    private client?: MongoClient;
    private timeout?: number;
    private closed = false;
    constructor(private readonly connection: () => {uri: string; options: MongoClientOptions},
        private readonly create = (uri: string, options: MongoClientOptions) => new MongoClient(uri, options)) {}
    get(operationTimeoutMS: number): Promise<MongoClient> {
        if (this.closed || !Number.isSafeInteger(operationTimeoutMS) || operationTimeoutMS < 1 || operationTimeoutMS > 30_000
            || this.timeout !== undefined && this.timeout !== operationTimeoutMS)
            return Promise.reject(new Error('Complete-kind MongoDB client configuration is unavailable'));
        this.timeout = operationTimeoutMS;
        this.pending ??= Promise.resolve().then(async () => {
            const source = this.connection();
            const client = this.create(source.uri, {...source.options, retryReads: false, retryWrites: false, maxAdaptiveRetries: 0,
                maxPoolSize: 2, minPoolSize: 0, maxConnecting: 1, waitQueueTimeoutMS: operationTimeoutMS,
                connectTimeoutMS: operationTimeoutMS, serverSelectionTimeoutMS: operationTimeoutMS});
            this.client = client;
            try {
                if (client.options.retryReads !== false || client.options.retryWrites !== false || client.options.maxAdaptiveRetries !== 0
                    || client.options.maxPoolSize !== 2 || client.options.minPoolSize !== 0 || client.options.maxConnecting !== 1
                    || client.options.waitQueueTimeoutMS !== operationTimeoutMS || client.options.connectTimeoutMS !== operationTimeoutMS
                    || client.options.serverSelectionTimeoutMS !== operationTimeoutMS)
                    throw new Error('Pinned driver did not enforce complete-kind client bounds');
                await client.connect();
                if (this.closed) throw new Error('Complete-kind MongoDB client was closed while connecting');
                return client;
            } catch (error) {await client.close(); this.client = undefined; this.pending = undefined; throw error;}
        });
        const selected = this.pending;
        void selected.catch(() => {if (this.pending === selected) this.pending = undefined;});
        return this.pending;
    }
    async close(): Promise<void> {
        this.closed = true;
        await this.pending?.catch(() => {});
        const client = this.client; this.client = undefined;
        if (client) await client.close();
    }
}
