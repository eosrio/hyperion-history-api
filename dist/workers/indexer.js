import { HyperionWorker } from "./hyperionWorker.js";
import { cargo } from "async";
import { ElasticRoutes } from '../helpers/elastic-routes.js';
import { hLog } from "../helpers/common_functions.js";
export default class IndexerWorker extends HyperionWorker {
    indexQueue;
    temp_indexed_count = 0;
    esRoutes;
    distributionMap;
    constructor() {
        super();
        if (process.env.distribution) {
            try {
                this.distributionMap = JSON.parse(process.env.distribution);
            }
            catch {
                hLog('Failed to parse distribution map');
            }
        }
        this.esRoutes = new ElasticRoutes(this.manager, this.distributionMap);
        this.indexQueue = cargo((payload, callback) => {
            if (this.ch_ready && payload) {
                if (this.esRoutes.routes[process.env.type]) {
                    // call route type
                    this.esRoutes.routes[process.env.type](payload, this.ch, (indexed_size) => {
                        if (indexed_size) {
                            this.temp_indexed_count += indexed_size;
                        }
                        try {
                            callback();
                        }
                        catch (e) {
                            hLog(`${e.message} on ${process.env.type}`);
                        }
                    });
                }
                else {
                    hLog(`No route for type: ${process.env.type}`);
                    process.exit(1);
                }
            }
        });
    }
    assertQueues() {
        try {
            if (this.ch) {
                this.ch_ready = true;
                this.ch.on('close', () => {
                    this.indexQueue.pause();
                    this.ch_ready = false;
                });
                this.ch.assertQueue(process.env.queue, { durable: true });
                this.ch.prefetch(this.conf.prefetch.index);
                this.ch.consume(process.env.queue, this.indexQueue.push);
            }
        }
        catch (e) {
            console.error('rabbitmq error!');
            console.log(e);
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
    onIpcMessage(msg) {
        // console.log(msg);
    }
    async run() {
        this.startMonitoring();
    }
}
