const action = {
    "order": 0,
    "index_patterns": [
        process.env.CHAIN + "-action-*"
    ],
    "settings": {
        "index": {
            "lifecycle": {
                "name": "50G30D",
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
            "@timestamp": {"type": "date"},
            "global_sequence": {"type": "long"},
            "account_ram_deltas.delta": {"enabled": false},
            "account_ram_deltas.account": {"enabled": false},
            "act.authorization.permission": {"enabled": false},
            "act.authorization.actor": {"type": "keyword"},
            "act.account": {"type": "keyword"},
            "act.name": {"type": "keyword"},
            "act.data": {"enabled": false},
            "block_num": {"type": "long"},
            "action_ordinal": {"type": "long"},
            "creator_action_ordinal": {"type": "long"},
            "cpu_usage_us": {"type": "integer"},
            "net_usage_words": {"type": "integer"},
            "code_sequence": {"type": "integer"},
            "abi_sequence": {"type": "integer"},
            "trx_id": {"type": "keyword"},
            "producer": {"type": "keyword"},
            "receipts": {
                "properties": {
                    "global_sequence": {"type": "long"},
                    "recv_sequence": {"type": "long"},
                    "receiver": {"type": "keyword"},
                    "auth_sequence": {
                        "properties": {
                            "account": {"type": "keyword"},
                            "sequence": {"type": "integer"}
                        }
                    }
                }
            },
            "@newaccount": {
                "properties": {
                    "active": {"type": "object"},
                    "owner": {"type": "object"},
                    "newact": {"type": "keyword"}
                }
            },
            "@updateauth": {
                "properties": {
                    "permission": {"type": "keyword"},
                    "parent": {"type": "keyword"},
                    "auth": {"type": "object"}
                }
            },
            "@transfer": {
                "properties": {
                    "from": {"type": "keyword"},
                    "to": {"type": "keyword"},
                    "amount": {"type": "float"},
                    "symbol": {"type": "keyword"},
                    "memo": {"type": "text"}
                }
            },
            "@unstaketorex": {
                "properties": {
                    "owner": {"type": "keyword"},
                    "receiver": {"type": "keyword"},
                    "amount": {"type": "float"}
                }
            },
            "@buyrex": {
                "properties": {
                    "from": {"type": "keyword"},
                    "amount": {"type": "float"}
                }
            },
            "@buyram": {
                "properties": {
                    "payer": {"type": "keyword"},
                    "receiver": {"type": "keyword"},
                    "quant": {"type": "float"}
                }
            },
            "@buyrambytes": {
                "properties": {
                    "payer": {"type": "keyword"},
                    "receiver": {"type": "keyword"},
                    "bytes": {"type": "long"}
                }
            },
            "@delegatebw": {
                "properties": {
                    "from": {"type": "keyword"},
                    "receiver": {"type": "keyword"},
                    "stake_cpu_quantity": {"type": "float"},
                    "stake_net_quantity": {"type": "float"},
                    "transfer": {"type": "boolean"},
                    "amount": {"type": "float"}
                }
            },
            "@undelegatebw": {
                "properties": {
                    "from": {"type": "keyword"},
                    "receiver": {"type": "keyword"},
                    "unstake_cpu_quantity": {"type": "float"},
                    "unstake_net_quantity": {"type": "float"},
                    "amount": {"type": "float"}
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
            "block": {"type": "long"},
            "account": {"type": "keyword"},
            "abi": {"enabled": false}
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
            "block_num": {"type": "long"},
            "producer": {"type": "keyword"},
            "new_producers.producers.block_signing_key": {"enabled": false},
            "new_producers.producers.producer_name": {"type": "keyword"},
            "new_producers.version": {"type": "long"},
            "@timestamp": {"type": "date"},
            "schedule_version": {"type": "double"},
            "cpu_usage": {"type": "integer"},
            "net_usage": {"type": "integer"}
        }
    }
};

const tableProposals = {
    "index_patterns": [process.env.CHAIN + "-table-proposals-*"],
    "settings": {
        "index": {
            "number_of_shards": 3,
            "refresh_interval": "5s",
            "number_of_replicas": 0,
            "sort.field": "block_num",
            "sort.order": "desc"
        }
    },
    "mappings": {
        "properties": {
            "proposal_name": {"type": "keyword"},
            "requested_approvals": {"type": "object"},
            "provided_approvals": {"type": "object"},
            "executed": {"type": "boolean"},
            "block_num": {"type": "long"}
        }
    }
};

const tableAccounts = {
    "index_patterns": [process.env.CHAIN + "-table-accounts-*"],
    "settings": {
        "index": {
            "number_of_shards": 3,
            "refresh_interval": "5s",
            "number_of_replicas": 0,
            "sort.field": "amount",
            "sort.order": "desc"
        }
    },
    "mappings": {
        "properties": {
            "code": {"type": "keyword"},
            "scope": {"type": "keyword"},
            "amount": {"type": "float"},
            "symbol": {"type": "keyword"},
            "primary_key": {"type": "keyword"},
            "block_num": {"type": "long"}
        }
    }
};

const tableUserRes = {
    "index_patterns": [process.env.CHAIN + "-table-userres-*"],
    "settings": {
        "index": {
            "number_of_shards": 3,
            "refresh_interval": "5s",
            "number_of_replicas": 0,
            "sort.field": "total_weight",
            "sort.order": "desc"
        }
    },
    "mappings": {
        "properties": {
            "owner": {"type": "keyword"},
            "total_weight": {"type": "float"},
            "net_weight": {"type": "float"},
            "cpu_weight": {"type": "float"},
            "ram_bytes": {"type": "long"},
            "primary_key": {"type": "keyword"},
            "block_num": {"type": "long"}
        }
    }
};

const tableDelBand = {
    "index_patterns": [process.env.CHAIN + "-table-delband-*"],
    "settings": {
        "index": {
            "number_of_shards": 3,
            "refresh_interval": "5s",
            "number_of_replicas": 0,
            "sort.field": "total_weight",
            "sort.order": "desc"
        }
    },
    "mappings": {
        "properties": {
            "from": {"type": "keyword"},
            "to": {"type": "keyword"},
            "total_weight": {"type": "float"},
            "net_weight": {"type": "float"},
            "cpu_weight": {"type": "float"},
            "primary_key": {"type": "keyword"},
            "block_num": {"type": "long"}
        }
    }
};

const tableVoters = {
    "index_patterns": [process.env.CHAIN + "-table-voters-*"],
    "settings": {
        "index": {
            "number_of_shards": 3,
            "refresh_interval": "5s",
            "number_of_replicas": 0,
            "sort.field": "last_vote_weight",
            "sort.order": "desc"
        }
    },
    "mappings": {
        "properties": {
            "voter": {"type": "keyword"},
            "producers": {"type": "keyword"},
            "last_vote_weight": {"type": "double"},
            "is_proxy": {"type": "boolean"},
            "proxied_vote_weight": {"type": "double"},
            "staked": {"type": "double"},
            "proxy": {"type": "keyword"},
            "primary_key": {"type": "keyword"},
            "block_num": {"type": "long"}
        }
    }
};

const delta = {
    "index_patterns": [process.env.CHAIN + "-delta-*"],
    "settings": {
        "index": {
            "lifecycle": {
                "name": "50G30D",
                "rollover_alias": process.env.CHAIN + "-delta"
            },
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
            "block_num": {"type": "long"},
            "present": {"type": "boolean"},
            "code": {"type": "keyword"},
            "scope": {"type": "keyword"},
            "table": {"type": "keyword"},
            "payer": {"type": "keyword"},
            "data": {"enabled": false},
            "primary_key": {"type": "keyword"},
            "@approvals.proposal_name": {"type": "keyword"},
            "@approvals.provided_approvals": {"type": "object"},
            "@approvals.requested_approvals": {"type": "object"},
            "@accounts.amount": {"type": "float"},
            "@accounts.symbol": {"type": "keyword"},
            "@voters.is_proxy": {"type": "boolean"},
            "@voters.producers": {"type": "keyword"},
            "@voters.last_vote_weight": {"type": "double"},
            "@voters.proxied_vote_weight": {"type": "double"},
            "@voters.staked": {"type": "float"},
            "@voters.proxy": {"type": "keyword"},
            "@producers.total_votes": {"type": "double"},
            "@producers.is_active": {"type": "boolean"},
            "@producers.unpaid_blocks": {"type": "long"},
            "@global.data": {
                "properties": {
                    "last_name_close": {"type": "date"},
                    "last_pervote_bucket_fill": {"type": "date"},
                    "last_producer_schedule_update": {"type": "date"},
                    "perblock_bucket": {"type": "double"},
                    "pervote_bucket": {"type": "double"},
                    "total_activated_stake": {"type": "double"},
                    "total_producer_vote_weight": {"type": "double"},
                    "total_ram_kb_reserved": {"type": "float"},
                    "total_ram_stake": {"type": "float"},
                    "total_unpaid_blocks": {"type": "long"},
                }
            }
        }
    }
};

module.exports = {
    action, block, abi, delta,
    "table-proposals": tableProposals,
    "table-accounts": tableAccounts,
    "table-delband": tableDelBand,
    "table-userres": tableUserRes,
    "table-voters": tableVoters
};
