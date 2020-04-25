import {ConfigurationModule} from "../modules/config";

const shards = 2;
const replicas = 0;
const refresh = "1s";
const defaultLifecyclePolicy = "10G30D";

export * from './index-lifecycle-policies';

// LZ4 Compression
// const compression = 'default';
// DEFLATE
const compression = "best_compression";

const cm = new ConfigurationModule();
const chain = cm.config.settings.chain;

const defaultIndexSettings = {
    "index": {
        "number_of_shards": shards,
        "refresh_interval": refresh,
        "number_of_replicas": replicas,
        "codec": compression
    }
};

export const action = {
    order: 0,
    index_patterns: [
        chain + "-action-*"
    ],
    settings: {
        index: {
            lifecycle: {
                "name": defaultLifecyclePolicy,
                "rollover_alias": chain + "-action"
            },
            codec: compression,
            refresh_interval: refresh,
            number_of_shards: shards * 2,
            number_of_replicas: replicas,
            sort: {
                field: "global_sequence",
                order: "desc"
            }
        }
    },
    mappings: {
        properties: {
            "@timestamp": {"type": "date"},
            "global_sequence": {"type": "long"},
            "account_ram_deltas.delta": {"type": "integer"},
            "account_ram_deltas.account": {"type": "keyword"},
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
            "notified": {"type": "keyword"},
            "inline_count": {"type": "short"},
            "max_inline": {"type": "short"},
            "inline_filtered": {"type": "boolean"},
            "receipts": {
                "properties": {
                    "global_sequence": {"type": "long"},
                    "recv_sequence": {"type": "long"},
                    "receiver": {"type": "keyword"},
                    "auth_sequence": {
                        "properties": {
                            "account": {"type": "keyword"},
                            "sequence": {"type": "long"}
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

export const delta = {
    "index_patterns": [chain + "-delta-*"],
    "settings": {
        "index": {
            "lifecycle": {
                "name": defaultLifecyclePolicy,
                "rollover_alias": chain + "-delta"
            },
            "codec": compression,
            "number_of_shards": shards * 2,
            "refresh_interval": refresh,
            "number_of_replicas": replicas
        }
    },
    "mappings": {
        "properties": {
            "block_num": {"type": "long"},
            "@timestamp": {"type": "date"},
            "data": {"enabled": false},
            "code": {"type": "keyword"},
            "present": {"type": "boolean"},
            "scope": {"type": "keyword"},
            "table": {"type": "keyword"},
            "payer": {"type": "keyword"},
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

export const abi = {
    "index_patterns": [chain + "-abi-*"],
    "settings": defaultIndexSettings,
    "mappings": {
        "properties": {
            "@timestamp": {"type": "date"},
            "block": {"type": "long"},
            "account": {"type": "keyword"},
            "abi": {"enabled": false},
            "abi_hex": {"enabled": false},
            "actions": {"type": "keyword"},
            "tables": {"type": "keyword"}
        }
    }
};

export const permissionLink = {
    "index_patterns": [chain + "-link-*"],
    "settings": defaultIndexSettings,
    "mappings": {
        "properties": {
            "block_num": {"type": "long"},
            "@timestamp": {"type": "date"},
            "present": {"type": "boolean"},
            "account": {"type": "keyword"},
            "code": {"type": "keyword"},
            "action": {"type": "keyword"},
            "permission": {"type": "keyword"}
        }
    }
};

export const permission = {
    "index_patterns": [chain + "-perm-*"],
    "settings": defaultIndexSettings,
    "mappings": {
        "properties": {
            "block_num": {"type": "long"},
            "present": {"type": "boolean"},
            "owner": {"type": "keyword"},
            "name": {"type": "keyword"},
            "parent": {"type": "keyword"},
            "last_updated": {"type": "date"},
            "auth": {"type": "object"}
        }
    }
};

export const resourceLimits = {
    "index_patterns": [chain + "-reslimits-*"],
    "settings": defaultIndexSettings,
    "mappings": {
        "properties": {
            "block_num": {"type": "long"},
            "@timestamp": {"type": "date"},
            "owner": {"type": "keyword"},
            "total_weight": {"type": "long"},
            "net_weight": {"type": "long"},
            "cpu_weight": {"type": "long"},
            "ram_bytes": {"type": "long"}
        }
    }
};

export const resourceUsage = {
    "index_patterns": [chain + "-userres-*"],
    "settings": defaultIndexSettings,
    "mappings": {
        "properties": {
            "block_num": {"type": "long"},
            "@timestamp": {"type": "date"},
            "owner": {"type": "keyword"},
            "net_used": {"type": "long"},
            "net_total": {"type": "long"},
            "net_pct": {"type": "float"},
            "cpu_used": {"type": "long"},
            "cpu_total": {"type": "long"},
            "cpu_pct": {"type": "float"},
            "ram": {"type": "long"}
        }
    }
};


export const logs = {
    "index_patterns": [chain + "-logs-*"],
    "settings": defaultIndexSettings
};

export const block = {
    "index_patterns": [chain + "-block-*"],
    "settings": {
        "index": {
            "codec": compression,
            "number_of_shards": shards,
            "refresh_interval": refresh,
            "number_of_replicas": replicas,
            "sort.field": "block_num",
            "sort.order": "desc"
        }
    },
    "mappings": {
        "properties": {
            "@timestamp": {"type": "date"},
            "block_num": {"type": "long"},
            "block_id": {"type": "keyword"},
            "prev_id": {"type": "keyword"},
            "producer": {"type": "keyword"},
            "new_producers.producers.block_signing_key": {"enabled": false},
            "new_producers.producers.producer_name": {"type": "keyword"},
            "new_producers.version": {"type": "long"},
            "schedule_version": {"type": "double"},
            "cpu_usage": {"type": "integer"},
            "net_usage": {"type": "integer"}
        }
    }
};

export const tableProposals = {
    "index_patterns": [chain + "-table-proposals-*"],
    "settings": {
        "index": {
            "codec": compression,
            "number_of_shards": shards,
            "refresh_interval": refresh,
            "number_of_replicas": replicas,
            "sort.field": "block_num",
            "sort.order": "desc"
        }
    },
    "mappings": {
        "properties": {
            "block_num": {"type": "long"},
            "proposal_name": {"type": "keyword"},
            "requested_approvals": {"type": "object"},
            "provided_approvals": {"type": "object"},
            "executed": {"type": "boolean"}
        }
    }
};

export const tableAccounts = {
    "index_patterns": [chain + "-table-accounts-*"],
    "settings": {
        "index": {
            "codec": compression,
            "number_of_shards": shards,
            "refresh_interval": refresh,
            "number_of_replicas": replicas,
            "sort.field": "amount",
            "sort.order": "desc"
        }
    },
    "mappings": {
        "properties": {
            "block_num": {"type": "long"},
            "code": {"type": "keyword"},
            "scope": {"type": "keyword"},
            "amount": {"type": "float"},
            "symbol": {"type": "keyword"},
            "primary_key": {"type": "keyword"}
        }
    }
};

export const tableDelBand = {
    "index_patterns": [chain + "-table-delband-*"],
    "settings": {
        "index": {
            "codec": compression,
            "number_of_shards": shards,
            "refresh_interval": refresh,
            "number_of_replicas": replicas,
            "sort.field": "total_weight",
            "sort.order": "desc"
        }
    },
    "mappings": {
        "properties": {
            "block_num": {"type": "long"},
            "from": {"type": "keyword"},
            "to": {"type": "keyword"},
            "total_weight": {"type": "float"},
            "net_weight": {"type": "float"},
            "cpu_weight": {"type": "float"},
            "primary_key": {"type": "keyword"}
        }
    }
};

export const tableVoters = {
    "index_patterns": [chain + "-table-voters-*"],
    "settings": {
        "index": {
            "codec": compression,
            "number_of_shards": shards,
            "refresh_interval": refresh,
            "number_of_replicas": replicas,
            "sort.field": "last_vote_weight",
            "sort.order": "desc"
        }
    },
    "mappings": {
        "properties": {
            "block_num": {"type": "long"},
            "voter": {"type": "keyword"},
            "producers": {"type": "keyword"},
            "last_vote_weight": {"type": "double"},
            "is_proxy": {"type": "boolean"},
            "proxied_vote_weight": {"type": "double"},
            "staked": {"type": "double"},
            "proxy": {"type": "keyword"},
            "primary_key": {"type": "keyword"}
        }
    }
};
