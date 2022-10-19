import {HyperionWorker} from "./hyperionWorker.js";
import {hLog} from "../helpers/common_functions.js";
import {Message} from "amqplib";
import {createHash} from "crypto";

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

// noinspection JSUnusedGlobalSymbols
export default class MainDSWorker extends HyperionWorker {

    queueName!: string;
    retryMap = new Map<string, number>();
    retryUpdates = false;

    constructor() {
        super();
    }

    assertQueues(): void {
        if (this.ch) {
            this.queueName = this.chain + ":delta_rm";
            hLog(`Launched delta updater, consuming from ${this.queueName}`);
            this.ch.assertQueue(this.queueName, {durable: true});
            this.ch.prefetch(1);
            this.ch.consume(this.queueName, this.onConsume.bind(this));
        }
    }

    onConsume(data: Message | null): void {
        if (data) {
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
    }

    getIndexPartition(blockNum: number): string {
        return Math.ceil(blockNum / this.conf.settings.index_partition_size).toString().padStart(6, '0');
    }

    async updateDelta(delta: HyperionDelta): Promise<boolean> {
        // TODO: update only on specific blockrange
        // console.log(delta.block_num, '-->', this.getIndexPartition(delta.block_num));
        const identifier = `${delta.code}-${delta.table}-${delta.scope}-${delta.primary_key}-${delta.block_num}`;
        try {
            const updateByQuery = {
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
            };
            const searchResult = await this.manager.elasticsearchClient.updateByQuery({
                index: this.chain + '-delta-*',
                conflicts: "proceed",
                body: updateByQuery
            });
            if (searchResult.total === 0) {

                if (!this.retryUpdates) {
                    // hLog(`Skipping ${identifier}`);
                    return true;
                }

                const hash = createHash('sha256')
                    .update(identifier)
                    .digest('hex');
                if (!this.retryMap.has(hash)) {
                    this.retryMap.set(hash, 1);
                } else {
                    const retries = this.retryMap.get(hash);
                    if (retries && retries > 3) {
                        // abort update after 3 attempts
                        hLog(`Hyperion wasn't able to update previous deltas for ${identifier}`);
                        this.retryMap.delete(hash);
                        return true;
                    } else {
                        if (retries) {
                            this.retryMap.set(hash, retries + 1);
                        }
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 100));
                return false;
            } else {
                if (searchResult.took && searchResult.took > 500) {
                    hLog(`Updated Deltas: ${searchResult.updated} | Took: ${searchResult.took} ms`);
                    hLog(identifier);
                }
                return true;
            }
        } catch (e: any) {
            hLog(e.message);
            return false;
        }
    }

    onIpcMessage(msg: any): void {
    }

    async run(): Promise<void> {
    }
}
