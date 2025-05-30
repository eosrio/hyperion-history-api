import { BulkWriteResult, Collection, Db } from "mongodb";
import { ConnectionManager } from "../connections/manager.class.js";
import { Message } from "amqplib";
import { hLog } from "./common_functions.js";
import { IAccount } from "../../interfaces/table-account.js";
import { IProposal } from "../../interfaces/table-proposal.js";
import { IVoter } from "../../interfaces/table-voter.js";
import { IPermission } from "../../interfaces/table-permissions.js";
import { last } from "lodash";

export class MongoRoutes {

    cm: ConnectionManager;
    routes: Record<string, any> = {};
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

        this.routes['state'] = (payload: Message[], callback: (indexed_size?: number) => void) => {

            // filter permission messages
            const permissionMessages = payload.filter((msg: Message) => {
                const headers = msg.properties.headers as any;
                return headers.type === 'permission';
            });

            if (permissionMessages.length > 0) {
                const operations = payload.map((msg: Message) => {
                    const data = JSON.parse(msg.content.toString()) as IPermission & { present: number };
                    // console.log('permission', data);
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
                });

                // console.log(operations);

                this.permissionsCollection?.bulkWrite(operations, { ordered: false })
                    // .then((value) => {
                    //     console.log(value);
                    //     console.log('Permission messages indexed:', permissionMessages.length);
                    // })
                    .catch(reason => {
                        hLog('error', 'mongo-routes', 'state', reason);
                    })
                    .finally(() => {
                        callback(payload.length);
                    });
            }

            const permissionLinkMessages = payload.filter((msg: Message) => {
                const headers = msg.properties.headers as any;
                return headers.type === 'permission_link';
            });

            if (permissionLinkMessages.length > 0) {
                const operations = permissionLinkMessages.map((msg: Message) => {
                    const data = JSON.parse(msg.content.toString()) as IPermission & { present: number };
                    // console.log('permission_link', data);
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
                });

                this.permissionsCollection?.bulkWrite(operations, { ordered: false })
                    // .then((value) => {
                    //     console.log(value);
                    //     console.log('Permission link messages indexed:', permissionLinkMessages.length);
                    // })
                    .catch(reason => {
                        hLog('error', 'mongo-routes', 'state', reason);
                    })
                    .finally(() => {
                        callback(permissionLinkMessages.length);
                    });
            }

            if (permissionMessages.length === 0 && permissionLinkMessages.length === 0) {
                // No permission messages, just ack
                console.log('Unexpected state message without permissions', payload);
                callback(0);
            }
        };

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

        this.routes['table-voters'] = (payload: Message[], callback: (indexed_size?: number) => void) => {
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

            this.votersCollection?.bulkWrite(operations, { ordered: false }).catch(reason => {
                hLog('error', 'mongo-routes', 'table-voters', reason);
            }).finally(() => {
                callback(payload.length);
            });
        };
    }

    private addDynamicRoutes() {
        this.routes['dynamic-table'] = (payload: Message[], callback: (indexed_size?: number) => void) => {
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

            const promises: Promise<BulkWriteResult>[] = [];

            groupedOps.forEach((value, key) => {
                if (this.db) {
                    promises.push(this.db.collection(key).bulkWrite(value, { ordered: false }))
                }
            });

            Promise.all(promises).finally(() => {
                callback(payload.length);
            });
        }

    }
}
