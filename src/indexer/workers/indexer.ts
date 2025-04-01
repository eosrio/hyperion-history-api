import { cargo, QueueObject } from "async";
import { Message } from "amqplib";

import { HyperionWorker } from "./hyperionWorker.js";
import { ElasticRoutes, RouteFunction } from '../helpers/elastic-routes.js';
import { hLog } from "../helpers/common_functions.js";
import { RabbitQueueDef } from "../definitions/index-queues.js";
import { MongoRoutes } from "../helpers/mongo-routes.js";

export default class IndexerWorker extends HyperionWorker {

    private indexQueue: QueueObject<any>;
    private temp_indexed_count = 0;
    private consumerTag: string | undefined;

    esRoutes: ElasticRoutes;
    mongoRoutes: MongoRoutes;

    constructor() {
        console.log(`aqui`, process.env.type, process.env.queue);
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

                if (this.conf.indexer.experimental_mongodb_state && this.mongoRoutes.routes[process.env.type]) {
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
                process.send?.({ event: 'add_index', size: this.temp_indexed_count });
            }
            this.temp_indexed_count = 0;
        }, 1000);
    }

    onIpcMessage(msg: any): void {
        if (msg.event === 'pause-indexer') {
            hLog(`[IPC]`, msg);
            if (this.indexQueue && this.ch && this.consumerTag) {
                hLog(`[IPC] Pausing indexer... Subscription: ${msg.mId}`);
                // this.indexQueue.pause();
                this.ch.cancel(this.consumerTag);
                if (this.indexQueue.length() > 0) {
                    this.indexQueue.drain(() => {
                        hLog(`[IPC] Indexer paused!`);
                        process.send?.({
                            event: 'indexer-paused',
                            mId: msg.mId
                        });
                    });
                } else {
                    hLog(`[IPC] Indexer paused!`);
                    process.send?.({
                        event: 'indexer-paused',
                        mId: msg.mId
                    });
                }
            }
        }
    }

    async run(): Promise<void> {
        this.startMonitoring();
    }
}
