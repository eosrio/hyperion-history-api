import {HyperionWorker} from "./hyperionWorker";
import {hLog} from "../helpers/common_functions";
import {Message} from "amqplib";

interface HyperionDelta {
    "@timestamp": string;
    code: string;
    scope: string;
    table: string;
    primary_key: string;
    block_num: number;
    block_id: string;
    data: any;
}

export default class MainDSWorker extends HyperionWorker {
    constructor() {
        super();
    }

    assertQueues(): void {
        if (this.ch) {
            const queue = this.chain + ":delta_rm";
            this.ch.assertQueue(queue, {durable: true});
            this.ch.prefetch(1);
            this.ch.consume(queue, this.onConsume.bind(this));
        }
    }

    onConsume(data: Message) {
        const deltaData = JSON.parse(Buffer.from(data.content).toString());
        this.updateDelta(deltaData).then((status) => {
            if (status) {
                this.ch.ack(data);
            } else {
                this.ch.nack(data, false, true);
            }
        }).catch((err) => {
            console.log(err);
            this.ch.nack(data);
        });
    }

    async updateDelta(delta: HyperionDelta): Promise<boolean> {
        try {
            const searchResult = await this.manager.elasticsearchClient.updateByQuery({
                index: this.chain + '-delta-*',
                conflicts: "proceed",
                body: {
                    query: {
                        bool: {
                            must: [
                                {term: {"code": {"value": delta.code}}},
                                {term: {"table": {"value": delta.table}}},
                                {term: {"scope": {"value": delta.scope}}},
                                {term: {"primary_key": {"value": delta.primary_key}}},
                                {range: {"block_num": {"lte": delta.block_num}}}
                            ],
                            must_not: [{exists: {field: "deleted_at"}}]
                        }
                    },
                    script: {
                        source: "ctx._source.deleted_at = params.blk",
                        lang: "painless",
                        params: {
                            "blk": delta.block_num
                        }
                    }
                }
            });
            if (searchResult.body.total === 0) {
                // no results, send back to queue
                // hLog(`Updated Deltas: ${searchResult.body.updated}`);
                // hLog(delta);
                await new Promise(resolve => setTimeout(resolve, 100));
                return false;
            } else {
                hLog(`Updated Deltas: ${searchResult.body.updated}`);
                return true;
            }
        } catch (e) {
            hLog(e.message);
            return false;
        }
    }

    onIpcMessage(msg: any): void {
    }

    async run(): Promise<void> {
        hLog('Launching delta updater!');
    }
}
