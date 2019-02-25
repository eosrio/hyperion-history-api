const action = {
    "order": 0,
    "index_patterns": [
        process.env.CHAIN + "-action-*"
    ],
    "settings": {
        "routing": {
            "allocation": {
                "require": {
                    "box_type": "hot"
                }
            }
        },
        "index": {
            "lifecycle": {
                "name": process.env.CHAIN + "_action",
                "rollover_alias": process.env.CHAIN + "-action"
            },
            "codec": "best_compression",
            "refresh_interval": "10s",
            "number_of_shards": "4",
            "number_of_replicas": "0",
            "sort": {
                "field": "global_sequence",
                "order": "desc"
            }
        }
    },
    "mappings": {
        "properties": {
            "@timestamp": {
                "type": "date"
            },
            "global_sequence": {
                "type": "long"
            },
            "parent": {
                "type": "long"
            },
            "act.data": {
                "enabled": false
            },
            "account_ram_deltas.delta": {
                "enabled": false
            },
            "act.account": {
                "type": "keyword"
            },
            "elapsed": {
                "type": "long"
            },
            "block_num": {
                "type": "long"
            },
            "act.authorization.permission": {
                "enabled": false
            },
            "@newaccount": {
                "properties": {
                    "active": {
                        "type": "object"
                    },
                    "owner": {
                        "type": "object"
                    }
                }
            },
            "@transfer": {
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
                    }
                }
            },
            "act.authorization.actor": {
                "type": "keyword"
            },
            "account_ram_deltas.account": {
                "enabled": false
            },
            "act.name": {
                "type": "keyword"
            },
            "trx_id": {
                "type": "keyword"
            },
            "producer": {
                "type": "keyword"
            }
        }
    },
    "aliases": {}
};

const transaction = {
    "index_patterns": [process.env.CHAIN + "-transaction-*"],
    "settings": {
        "index": {
            "number_of_shards": 2,
            "refresh_interval": "10s",
            "number_of_replicas": 0,
            "sort.field": "block_num",
            "sort.order": "desc"
        },
        "index.codec": "best_compression"
    },
    "mappings": {
        "properties": {
            "block_num": {
                "type": "long"
            },
            "@timestamp": {
                "type": "date"
            },
            "cpu": {
                "type": "long"
            },
            "net": {
                "type": "long"
            }
        }
    }
};

const account = {
    "index_patterns": [process.env.CHAIN + "-account-*"],
    "settings": {
        "index": {
            "number_of_shards": 1,
            "refresh_interval": "5s",
            "number_of_replicas": 0
        },
        "index.codec": "best_compression"
    },
    "mappings": {
        "properties": {
            "name": {
                "type": "keyword"
            },
            "updated_on": {
                "type": "date"
            },
            "keys_updated_on": {
                "type": "date"
            },
            "auth": {
                "dynamic": false,
                "properties": {
                    "active": {
                        "dynamic": true,
                        "type": "object"
                    },
                    "owner": {
                        "dynamic": true,
                        "type": "object"
                    }
                }
            }
        }
    }
};

const abi = {
    "index_patterns": [process.env.CHAIN + "-abi-*"],
    "settings": {
        "index": {
            "number_of_shards": 1,
            "refresh_interval": "10s",
            "number_of_replicas": 0
        },
        "index.codec": "best_compression"
    },
    "mappings": {
        "properties": {
            "block": {
                "type": "long"
            },
            "account": {
                "type": "keyword"
            },
            "abi": {
                "enabled": false
            }
        }
    }
};

const block = {
    "index_patterns": [process.env.CHAIN + "-block-*"],
    "settings": {
        "index": {
            "number_of_shards": 2,
            "refresh_interval": "5s",
            "number_of_replicas": 0,
            "sort.field": "block_num",
            "sort.order": "desc"
        },
        "index.codec": "best_compression"
    },
    "mappings": {
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
            "@timestamp": {
                "type": "date"
            },
            "schedule_version": {
                "type": "double"
            }
        }
    }
};

module.exports = {action, block, transaction, account, abi};
