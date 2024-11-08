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
            if (this.ch_ready && payload && process.env.type && this.ch) {

                if (this.conf.indexer.experimental_mongodb_state && this.mongoRoutes.routes[process.env.type]) {
                    // call route type
                    (this.mongoRoutes.routes[process.env.type] as any)(payload, (indexed_size?: number) => {
                        // if (indexed_size) {
                        //     this.temp_indexed_count += indexed_size;
                        // }
                        // console.log('MongoDB indexed: ', indexed_size);
                    });
                }

                if (this.esRoutes.routes[process.env.type]) {
                    // call route type
                    (this.esRoutes.routes[process.env.type] as RouteFunction)(payload, this.ch, (indexed_size?: number) => {
                        if (indexed_size) {
                            this.temp_indexed_count += indexed_size;
                        }
                        try {
                            callback();
                        } catch (e: any) {
                            hLog(`${e.message} on ${process.env.type}`);
                        }
                    });
                } else {
                    hLog(`No route for type: ${process.env.type}`);
                    process.exit(1);
                }
            }

            // if (this.conf.prefetch.index === payload.length) {
            //     hLog(`Max index prefetch reached on ${process.env.type} = ${payload.length}`);
            // }

        }, this.conf.prefetch.index);
    }

    assertQueues(): void {
        try {
            if (this.ch && process.env.queue) {
                this.ch_ready = true;
                this.ch.on('close', () => {
                    this.indexQueue.pause();
                    this.ch_ready = false;
                });
                this.ch.assertQueue(process.env.queue, RabbitQueueDef);
                this.ch.prefetch(this.conf.prefetch.index);
                this.ch.consume(process.env.queue, this.indexQueue.push);
            }
        } catch (e) {
            console.error('rabbitmq error!');
            console.log(e);
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

    onIpcMessage(msg: any): void {
        // console.log(msg);
    }

    async run(): Promise<void> {
        this.startMonitoring();
    }
}
