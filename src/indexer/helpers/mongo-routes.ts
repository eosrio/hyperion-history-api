import { Collection, Db } from "mongodb";
import { ConnectionManager } from "../connections/manager.class.js";
import { Message } from "amqplib";
import { hLog } from "./common_functions.js";
import { IAccount } from "../../interfaces/table-account.js";
import { IProposal } from "../../interfaces/table-proposal.js";

export class MongoRoutes {

    cm: ConnectionManager;
    routes: Record<string, any> = {};
    private db?: Db;
    private accountsCollection?: Collection<IAccount>;
    private proposalsCollection?: Collection<IProposal>;

    constructor(connectionManager: ConnectionManager) {
        this.cm = connectionManager;
        this.cm.prepareMongoClient();
        if (this.cm.mongodbClient && this.cm.conn.mongodb) {
            this.db = this.cm.mongodbClient.db(`${this.cm.conn.mongodb.database_prefix}_${this.cm.chain}`);
            this.accountsCollection = this.db.collection('accounts');
            this.proposalsCollection = this.db.collection('proposals');
            this.addRoutes();
        }
    }

    addRoutes() {
        this.routes['table-accounts'] = (payload: Message[], callback: (indexed_size?: number) => void) => {
            // index
            const operations = payload.map((msg: Message) => {
                const data = JSON.parse(msg.content.toString()) as IAccount & { present: number };
                if (data.present !== 0) {
                    return {
                        updateOne: {
                            filter: {
                                code: data.code,
                                scope: data.scope,
                                symbol: data.symbol
                            },
                            update: {
                                $set: {
                                    block_num: data.block_num,
                                    amount: data.amount
                                }
                            },
                            upsert: true
                        }
                    };
                } else {
                    return {
                        deleteOne: {
                            filter: {
                                code: data.code,
                                scope: data.scope,
                                symbol: data.symbol
                            }
                        }
                    };
                }
            });

            this.accountsCollection?.bulkWrite(operations, { ordered: false }).catch(reason => {
                hLog('error', 'mongo-routes', 'table-accounts', reason);
            }).finally(() => {
                // TODO: ack
                // channel.ackAll();
                callback(payload.length);
            });
        };

        this.routes['table-proposals'] = (payload: Message[], callback: (indexed_size?: number) => void) => {
            const operations = payload.map((msg: Message) => {
                const data = JSON.parse(msg.content.toString()) as IProposal;
                return {
                    updateOne: {
                        filter: {
                            proposal_name: data.proposal_name,
                            proposer: data.proposer
                        },
                        update: {
                            $set: data
                        },
                        upsert: true
                    }
                };
            });

            this.proposalsCollection?.bulkWrite(operations, { ordered: false }).catch(reason => {
                hLog('error', 'mongo-routes', 'table-proposals', reason);
            }).finally(() => {
                callback(payload.length);
            });
        };
    }
}
