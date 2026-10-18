import type { Collection, Db } from "mongodb";
import type { ConnectionManager } from "../connections/manager.class.js";
import type { Message } from "amqplib";
import { IAccount } from "../../interfaces/table-account.js";
import { IProposal } from "../../interfaces/table-proposal.js";
import { IVoter } from "../../interfaces/table-voter.js";
import { IPermission } from "../../interfaces/table-permissions.js";

export type MongoRouteFunction = (payload: Message[]) => Promise<number>;

export class MongoRoutes {

    cm: ConnectionManager;
    routes: Record<string, MongoRouteFunction> = {};
    private db?: Db;
    private accountsCollection?: Collection<IAccount>;
    private proposalsCollection?: Collection<IProposal>;
    private votersCollection?: Collection<IVoter>;
    private permissionsCollection?: Collection<IPermission>;

    constructor(connectionManager: ConnectionManager) {
        this.cm = connectionManager;
        this.cm.prepareMongoClient();
        if (this.cm.mongodbClient && this.cm.conn.mongodb) {
            this.db = this.cm.mongodbClient.db(`${this.cm.conn.mongodb.database_prefix}_${this.cm.chain}`);
            this.accountsCollection = this.db.collection('accounts');
            this.proposalsCollection = this.db.collection('proposals');
            this.votersCollection = this.db.collection('voters');
            this.permissionsCollection = this.db.collection('permissions');
            this.addRoutes();
            this.addDynamicRoutes();
        }
    }

    addRoutes() {

        this.routes['state'] = async (payload: Message[]) => {
            // Permissions and links share keys: preserve their delivered order on replay.
            const operations: any[] = payload.map((msg: Message) => {
                const type = msg.properties.headers?.type;
                if (type === 'permission') {
                    const data = JSON.parse(msg.content.toString()) as IPermission & { present: number };
                    if (data.present !== 0) {
                        return {
                            updateOne: {
                                filter: {
                                    account: data.owner,
                                    perm_name: data.name
                                },
                                update: {
                                    $set: {
                                        block_num: data.block_num,
                                        parent: data.parent,
                                        required_auth: data.auth,
                                        last_updated: data.last_updated
                                    }
                                },
                                upsert: true
                            }
                        };
                    } else {
                        return {
                            deleteOne: {
                                filter: {
                                    account: data.owner,
                                    perm_name: data.name
                                }
                            }
                        };
                    }
                } else if (type === 'permission_link') {
                    const data = JSON.parse(msg.content.toString()) as IPermission & { present: number };
                    if (data.present !== 0) {
                        return {
                            updateOne: {
                                filter: {
                                    account: data.account,
                                    perm_name: data.permission
                                },
                                update: {
                                    $set: {
                                        block_num: data.block_num,
                                        last_updated: data['@timestamp']
                                    },
                                    $addToSet: {
                                        linked_actions: {
                                            account: data.code,
                                            action: data.action
                                        }
                                    }
                                },
                                upsert: true
                            }
                        };
                    } else {
                        return {
                            updateOne: {
                                filter: {
                                    account: data.account,
                                    perm_name: data.permission
                                },
                                update: {
                                    $pull: {
                                        linked_actions: {
                                            account: data.code,
                                            action: data.action
                                        } as any
                                    }
                                },
                                upsert: false
                            }
                        };
                    }
                }
                throw new Error(`Unexpected MongoDB state message type: ${type}`);
            });
            await this.permissionsCollection!.bulkWrite(operations, { ordered: true });
            return payload.length;
        };

        this.routes['table-accounts'] = async (payload: Message[]) => {
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

            await this.accountsCollection!.bulkWrite(operations, { ordered: true });
            return payload.length;
        };

        this.routes['table-proposals'] = async (payload: Message[]) => {
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

            await this.proposalsCollection!.bulkWrite(operations, { ordered: true });
            return payload.length;
        };

        this.routes['table-voters'] = async (payload: Message[]) => {
            const operations = payload.map((msg: Message) => {
                const data = JSON.parse(msg.content.toString()) as IVoter;
                return {
                    updateOne: {
                        filter: {
                            voter: data.voter
                        },
                        update: {
                            $set: {
                                block_num: data.block_num,
                                is_proxy: data.is_proxy,
                                last_vote_weight: data.last_vote_weight,
                                producers: data.producers,
                                proxied_vote_weight: data.proxied_vote_weight,
                                primary_key: data.primary_key,
                                staked: data.staked,
                            }
                        },
                        upsert: true
                    }
                };
            });

            await this.votersCollection!.bulkWrite(operations, { ordered: true });
            return payload.length;
        };
    }

    private addDynamicRoutes() {
        this.routes['dynamic-table'] = async (payload: Message[]) => {
            const groupedOps = new Map<string, any[]>();
            payload.forEach((msg: Message) => {
                const delta = JSON.parse(msg.content.toString()) as any;
                const headers = msg.properties.headers as any;

                const op = {};

                if (headers.present === 1) {
                    op['updateOne'] = {
                        filter: {
                            '@scope': delta.scope,
                            '@pk': delta.primary_key
                        },
                        update: {
                            $set: {
                                '@scope': delta.scope,
                                '@pk': delta.primary_key,
                                '@payer': delta.payer,
                                '@block_num': delta.block_num,
                                '@block_time': delta['@timestamp'],
                                '@block_id': delta['block_id'],
                                ...delta.data
                            }
                        },
                        upsert: true
                    };
                } else {
                    op['deleteOne'] = {
                        filter: {
                            '@scope': delta.scope,
                            '@pk': delta.primary_key
                        }
                    };
                }

                const collection = headers.code + '-' + headers.table;
                const col = groupedOps.get(collection);
                if (col) {
                    col.push(op);
                } else {
                    groupedOps.set(collection, [op]);
                }
                // hLog(msg.properties.headers, delta);
            });

            // Drain every collection before a failed batch is retried; otherwise an old
            // in-flight write could complete after its replay.
            const results = await Promise.allSettled([...groupedOps].map(async ([key, operations]) => {
                return await this.db!.collection(key).bulkWrite(operations, { ordered: true });
            }));
            for (const result of results) {
                if (result.status === 'rejected') throw result.reason;
            }
            return payload.length;
        }

    }
}
