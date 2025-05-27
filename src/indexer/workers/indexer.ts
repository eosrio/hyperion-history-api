import {cargo, QueueObject} from "async";
import {Message} from "amqplib";

import {HyperionWorker} from "./hyperionWorker.js";
import {ElasticRoutes, RouteFunction} from '../helpers/elastic-routes.js';
import {hLog} from "../helpers/common_functions.js";
import {RabbitQueueDef} from "../definitions/index-queues.js";
import {MongoRoutes} from "../helpers/mongo-routes.js";

export default class IndexerWorker extends HyperionWorker {

    private indexQueue: QueueObject<any>;
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

        this.indexQueue = cargo((payload: Message[], callback) => {

            // hLog(`Indexing (${process.env.type}): `, payload.length);

            if (this.ch_ready && payload && process.env.type && this.ch) {

                if (this.mongoRoutes.routes[process.env.type]) {
                    // call route type
                    (this.mongoRoutes.routes[process.env.type] as any)(payload, (indexed_size?: number) => {
                        if (indexed_size) {
                            this.temp_indexed_count += indexed_size;
                        }
                        // console.log('MongoDB indexed: ', indexed_size, ' on ', process.env.type);
                        try {
                            this.ch?.ackAll();
                            callback();
                        } catch (e: any) {
                            hLog(`${e.message} on ${process.env.type}`);
                        }
                    });
                } else if (this.esRoutes.routes[process.env.type]) {
                    // call route type
                    (this.esRoutes.routes[process.env.type] as RouteFunction)(payload, this.ch, (indexed_size?: number) => {
                        if (indexed_size) {
                            this.temp_indexed_count += indexed_size;
                        }
                        // console.log('ES indexed: ', indexed_size, ' on ', process.env.type);
                        try {
                            callback();
                        } catch (e: any) {
                            hLog(`${e.message} on ${process.env.type}`);
                        }
                    });
                }
            }

        }, this.conf.prefetch.index);
    }

    async assertQueues(): Promise<void> {
        try {
            const queueName = process.env.queue;
            if (this.ch && queueName) {
                this.ch_ready = true;
                console.log('Consumer on:', queueName);
                this.ch.on('close', () => {
                    hLog('Channel closed for queue:', queueName);
                    this.indexQueue.pause();
                    this.ch_ready = false;
                });
                await this.ch.assertQueue(queueName, RabbitQueueDef);
                await this.ch.prefetch(this.conf.prefetch.index);
                const consume = await this.ch.consume(queueName, this.indexQueue.push);
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
                process.send?.({event: 'add_index', size: this.temp_indexed_count});
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
        console.log(`Attempting to resume indexer. mId: ${msg.mId}`);
        if (this.ch) {
            try {
                const queueName = process.env.queue;
                if (!queueName) {
                    hLog('[resumeIndexer] Queue name is not defined');
                    return;
                }

                const consume = await this.ch.consume(queueName, this.indexQueue.push);
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
