const action = {
    "settings": {
        "index": {
            "number_of_shards": 3,
            "refresh_interval": "20s",
            "number_of_replicas": 0,
            "sort.field": "receipt.global_sequence",
            "sort.order": "desc"
        },
        "index.codec": "best_compression"
    },
    "mappings": {
        "_doc": {
            "properties": {
                "@data": {
                    "properties": {
                        "transfer": {
                            "properties": {
                                "from": {
                                    "type": "keyword"
                                },
                                "to": {
                                    "type": "keyword"
                                },
                                "amount": {
                                    "type": "float"
                                },
                                "symbol": {
                                    "type": "keyword"
                                },
                            }
                        }
                    }
                },
                "timestamp": {
                    "type": "date"
                },
                "depth": {
                    "type": "byte"
                },
                "trx_id": {
                    "type": "keyword"
                },
                "producer": {
                    "type": "keyword"
                },
                "parent.root": {
                    "type": "boolean"
                },
                "parent.seq": {
                    "type": "long"
                },
                "context_free": {
                    "enabled": false
                },
                "receipt.receiver": {
                    "type": "keyword"
                },
                "receipt.global_sequence": {
                    "type": "long"
                },
                "receipt.abi_sequence": {
                    "enabled": false
                },
                "receipt.act_digest": {
                    "enabled": false
                },
                "receipt.recv_sequence": {
                    "enabled": false
                },
                "receipt.auth_sequence": {
                    "enabled": false
                },
                "receipt.code_sequence": {
                    "enabled": false
                },
                "block_num": {
                    "type": "long"
                },
                "act.account": {
                    "type": "keyword"
                },
                "act.name": {
                    "type": "keyword"
                },
                "act.data": {
                    "enabled": false
                },
                "act.authorization.actor": {
                    "type": "keyword"
                },
                "act.authorization.permission": {
                    "enabled": false
                },
                "elapsed": {
                    "type": "short"
                },
                "except": {
                    "enabled": false
                },
                "account_ram_deltas.account": {
                    "enabled": false
                },
                "account_ram_deltas.delta": {
                    "enabled": false
                }
            }
        }
    }
};

const transaction = {
    "settings": {
        "index": {
            "number_of_shards": 3,
            "refresh_interval": "20s",
            "number_of_replicas": 0,
            "sort.field": "block_num",
            "sort.order": "desc"
        },
        "index.codec": "best_compression"
    },
    "mappings": {
        "_doc": {
            "properties": {
                "block_num": {
                    "type": "long"
                },
                "timestamp": {
                    "type": "date"
                }
            }
        }
    }
};

const block = {
    "settings": {
        "index": {
            "number_of_shards": 3,
            "refresh_interval": "20s",
            "number_of_replicas": 0,
            "sort.field": "block_num",
            "sort.order": "desc"
        },
        "index.codec": "best_compression"
    },
    "mappings": {
        "_doc": {
            "properties": {
                "block_num": {
                    "type": "long"
                },
                "producer": {
                    "type": "keyword"
                },
                "new_producers.producers.block_signing_key": {
                    "enabled": false
                },
                "new_producers.producers.producer_name": {
                    "type": "keyword"
                },
                "new_producers.version": {
                    "type": "long"
                },
                "timestamp": {
                    "type": "date"
                },
                "schedule_version": {
                    "type": "double"
                }
            }
        }
    }
};

module.exports = {action, block, transaction};
