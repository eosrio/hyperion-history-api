import { Name, UInt64 } from "@wharfkit/antelope";
import { cargo } from "async";
import { IVoter } from "../../interfaces/table-voter.js";
import { Synchronizer } from "./synchronizer.js";

export class VoterSynchronizer extends Synchronizer<IVoter> {

    constructor(chain: string) {
        super(chain, 'voters');
    }

    private async* scan() {
        let lb: UInt64 | undefined = undefined;
        let more = false;
        do {
            const result = await this.client.v1.chain.get_table_rows({
                code: "eosio",
                table: "voters",
                scope: "eosio",
                limit: 300,
                lower_bound: lb ? lb : undefined
            });

            for (const voter of result.rows) {
                const data = {
                    block_num: this.currentBlock,
                    is_proxy: voter.is_proxy === 1,
                    last_vote_weight: voter.last_vote_weight,
                    primary_key: Name.from(voter.owner).value.toString(),
                    producers: voter.producers,
                    proxied_vote_weight: voter.proxied_vote_weight,
                    proxy: voter.proxy,
                    staked: voter.staked,
                    voter: voter.owner
                };
                this.totalItems++;
                yield data;
            }
            lb = result.next_key;
            more = result.more;
        } while (more);
    }

    public async run() {
        const info = await this.client.v1.chain.get_info();
        this.currentBlock = info.head_block_num.toNumber();

        await this.setupMongo('voters', [
            { fields: { voter: 1 }, options: { unique: true } },
            { fields: { producers: 1 } },
            { fields: { is_proxy: 1 } }
        ]);

        try {
            if (this.collection) {
                const cargoQueue = cargo((docs: any[], cb) => {
                    this.collection!.bulkWrite(docs.map(doc => {
                        return {
                            updateOne: {
                                filter: {
                                    voter: doc.voter
                                },
                                update: {
                                    $set: {
                                        block_num: doc.block_num,
                                        is_proxy: doc.is_proxy,
                                        last_vote_weight: doc.last_vote_weight,
                                        producers: doc.producers,
                                        proxied_vote_weight: doc.proxied_vote_weight,
                                        proxy: doc.proxy,
                                        staked: doc.staked
                                    }
                                },
                                upsert: true
                            }
                        };
                    })).finally(() => {
                        cb();
                    });
                }, 1000);

                for await (const doc of this.scan()) {
                    cargoQueue.push(doc).catch(console.log);
                }

                await cargoQueue.drain();

                console.log(`Processed ${this.totalItems} accounts`);
                await this.mongoClient?.close();
            } else {
                const bulkResponse = await this.elastic.helpers.bulk({
                    flushBytes: 1000000,
                    datasource: this.scan(),
                    onDocument: (doc) => [{ index: { _id: doc.voter, _index: this.indexName } }, doc],
                    onDrop: (doc) => console.log('doc', doc)
                });
                console.log(`bulkResponse`, bulkResponse);
                console.log(`${bulkResponse.successful} accounts`);
            }
        } catch (e) {
            console.log(e);
            process.exit();
        }
    }
}
