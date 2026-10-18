import { Channel, ConsumeMessage } from "amqplib";
import { cargo, QueueObject } from "async";

import { RabbitQueueDef } from "../definitions/index-queues.js";
import { hLog } from "../helpers/common_functions.js";
import { ElasticRoutes, RouteFunction } from '../helpers/elastic-routes.js';
import { MongoRoutes } from "../helpers/mongo-routes.js";
import { indexMongoBatch } from "../helpers/mongo-batch.js";
import { HyperionWorker } from "./hyperionWorker.js";

interface IndexDelivery {
    message: ConsumeMessage;
    channel: Channel;
}

export default class IndexerWorker extends HyperionWorker {

    private indexQueue: QueueObject<IndexDelivery>;
    private temp_indexed_count = 0;
    private consumerTag: string | undefined;

    esRoutes: ElasticRoutes;
    mongoRoutes: MongoRoutes;

    constructor() {
        super();
        if (!process.env.type) {
            hLog("[FATAL] env.type is not defined!");
            process.exit(1);
        }
        if (!process.env.queue) {
            hLog("[FATAL] env.queue is not defined!");
            process.exit(1);
        }

        this.esRoutes = new ElasticRoutes(this.manager);

        this.mongoRoutes = new MongoRoutes(this.manager);

        this.indexQueue = cargo((deliveries: IndexDelivery[], callback) => {
            const channel = this.ch;
            // Closed-channel deliveries are requeued by RabbitMQ. Never write them
            // or settle their old delivery tags on a replacement channel.
            const payload = deliveries.filter(delivery => delivery.channel === channel)
                .map(delivery => delivery.message);

            if (this.ch_ready && payload.length > 0 && process.env.type && channel) {
                const stopDb = this.profiler.start('db_indexing');
                const doneCallback = (indexed_size?: number) => {
                    stopDb();
                    if (indexed_size) {
                        this.temp_indexed_count += indexed_size;
                    }
                    try {
                        callback();
                    } catch (e: any) {
                        hLog(`${e.message} on ${process.env.type}`);
                    }
                };

                if (this.mongoRoutes.routes[process.env.type]) {
                    void indexMongoBatch(payload, this.mongoRoutes.routes[process.env.type], channel,
                        () => this.ch_ready && this.ch === channel,
                        reason => hLog('MongoDB batch remains pending:', process.env.type, reason)
                    ).then(doneCallback);
                } else if (this.esRoutes.routes[process.env.type]) {
                    // call route type
                    (this.esRoutes.routes[process.env.type] as RouteFunction)(payload, channel, (indexed_size?: number) => {
                        doneCallback(indexed_size);
                    });
                } else {
                    stopDb();
                    callback();
                }
            } else {
                callback();
            }

        }, this.conf.prefetch.index);
    }

    async assertQueues(): Promise<void> {
        try {
            const queueName = process.env.queue;
            const channel = this.ch;
            if (channel && queueName) {
                this.ch_ready = true;
                hLog('Starting consumer on:', queueName);
                channel.on('close', () => {
                    hLog('Channel closed for queue:', queueName);
                    if (this.ch === channel) {
                        this.indexQueue.pause();
                        this.ch_ready = false;
                    }
                });
                await channel.assertQueue(queueName, RabbitQueueDef);
                await channel.prefetch(this.conf.prefetch.index);
                const consume = await channel.consume(queueName, message => {
                    if (message) this.indexQueue.push({ message, channel });
                });
                this.consumerTag = consume.consumerTag;
                this.indexQueue.resume();
            }
        } catch (e: any) {
            hLog(`Error asserting queue: ${e.message}`);
            process.exit(1);
        }
    }

    startMonitoring() {
        setInterval(() => {
            if (this.temp_indexed_count > 0) {
                process.send?.({ event: 'add_index', size: this.temp_indexed_count });
            }
            this.temp_indexed_count = 0;
        }, 1000);
    }

    async onIpcMessage(msg: any): Promise<void> {
        if (msg.event === 'pause_indexer') {
            await this.pauseIndexer(msg);
        } else if (msg.event === 'resume_indexer') {
            await this.resumeIndexer(msg);
        }
    }

    private async pauseIndexer(msg: any) {
        if (this.indexQueue && this.ch && this.consumerTag) {
            await this.ch.cancel(this.consumerTag);
            if (this.indexQueue.length() > 0) {
                this.indexQueue.drain(() => {
                    process.send?.({
                        event: 'indexer_paused',
                        mId: msg.mId
                    });
                });
            } else {
                process.send?.({
                    event: 'indexer_paused',
                    mId: msg.mId
                });
            }
        }
    }

    private async resumeIndexer(msg: { mId: string }) {
        hLog(`Attempting to resume indexer. mId: ${msg.mId}`);
        const channel = this.ch;
        if (channel) {
            try {
                const queueName = process.env.queue;
                if (!queueName) {
                    hLog('[resumeIndexer] Queue name is not defined');
                    return;
                }

                const consume = await channel.consume(queueName, message => {
                    if (message) this.indexQueue.push({ message, channel });
                });
                this.consumerTag = consume.consumerTag;

                hLog(`[IPC] Indexer resumed! ConsumerTag: ${this.consumerTag}`);
                process.send?.({
                    event: 'indexer_resumed',
                    mId: msg.mId
                });
            } catch (error) {
                hLog(`[IPC] Error resuming indexer: ${error}`);
                process.send?.({
                    event: 'indexer-resume-failed',
                    mId: msg.mId,
                    error: error
                });
            }
        } else {
            hLog('[IPC] Channel not ready');
            process.send?.({
                event: 'indexer-resume-failed',
                mId: msg.mId,
                error: 'Channel not ready'
            });
        }
    }

    async run(): Promise<void> {
        this.startMonitoring();
    }
}
