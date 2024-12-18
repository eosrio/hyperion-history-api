import {HyperionWorker} from "./hyperionWorker";
import {cargo, QueueObject} from "async";
import {ElasticRoutes} from '../helpers/elastic-routes';

import {hLog} from "../helpers/common_functions";
import {Message} from "amqplib";
import {RabbitQueueDef} from "../definitions/index-queues";

export default class IndexerWorker extends HyperionWorker {

    private indexQueue: QueueObject<any>;
    private temp_indexed_count = 0;

    esRoutes: ElasticRoutes;

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
        this.indexQueue = cargo((payload: Message[], callback) => {
            if (this.ch_ready && payload && process.env.type) {
                if (this.esRoutes.routes[process.env.type]) {

                    // call route type
                    this.esRoutes.routes[process.env.type](payload, this.ch, (indexed_size) => {
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
        })
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
                setTimeout(() => {
                    this.indexQueue.resume();
                }, 2000);
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
