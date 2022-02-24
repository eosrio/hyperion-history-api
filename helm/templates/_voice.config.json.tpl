{{/* Common connections.json */}}
{{- define "hyperion.config" }}
{
  "api": {
    "enabled": {{ .Values.api }},
    "pm2_scaling": 1,
    "node_max_old_space_size": 1024,
    "chain_name": "voice",
    "server_addr": "0.0.0.0",
    "server_port": 7000,
    "server_name": "{{ .conf.serverName }}",
    "provider_name": "{{ .conf.provider_name }}",
    "provider_url": "{{ .conf.provider_url }}",
    "chain_api": "",
    "push_api": "",
    "chain_logo_url": "{{ .conf.chain_logo_url }}",
    "enable_caching": true,
    "cache_life": 1,
    "limits": {
      "get_actions": 1000,
      "get_voters": 100,
      "get_links": 1000,
      "get_deltas": 1000,
      "get_trx_actions": 200
    },
    "access_log": false,
    "chain_api_error_log": true,
    "custom_core_token": "",
    "enable_export_action": false,
    "disable_rate_limit": false,
    "rate_limit_rpm": 1000,
    "rate_limit_allow": [],
    "disable_tx_cache": false,
    "tx_cache_expiration_sec": 3600,
    "v1_chain_cache": [
      {
        "path": "get_block", 
        "ttl": 3000
        },
      {
        "path": "get_info",
         "ttl": 500
      }
    ]
  },
  "indexer": {
    "enabled":  {{ .Values.indexer }},
    "node_max_old_space_size": 4096,
{{- if .Values.abi_scan  }}    
    "start_on": 0,
{{- else}}  
    "start_on": 1,
{{- end }} 
    "stop_on": 0,
    "rewrite": false,
    "purge_queues": false,
{{- if .Values.abi_scan  }}    
     "live_reader": false,
{{- else}}    
    "live_reader": false,
{{- end }} 
    "live_only_mode": false,
{{- if .Values.abi_scan  }}    
    "abi_scan_mode": true,
{{- else}}    
    "abi_scan_mode": false,
{{- end }} 
    "fetch_block": true,
    "fetch_traces": true,
    "disable_reading": false,
    "disable_indexing": false,
    "process_deltas": true,
    "disable_delta_rm": true
  },
  "settings": {
    "preview": false,
    "chain": "voice",
    "eosio_alias": "eosio",
    "parser": "1.8",
{{- if .Values.abi_scan  }}
    "auto_stop": 100,
{{- else}}    
    "auto_stop": 0,
{{- end }}
    "index_version": "v1",
    "debug": true,
    "bp_logs": false,
    "bp_monitoring": false,
    "ipc_debug_rate": 60000,
    "allow_custom_abi": false,
    "rate_monitoring": true,
    "max_ws_payload_mb": 256,
    "ds_profiling": false,
    "auto_mode_switch": false,
    "hot_warm_policy": false,
    "custom_policy": "",
    "bypass_index_map": false,
    "index_partition_size": 10000000,
    "es_replicas": {{ .conf.es_replicas }}
  },
  "blacklists": {
    "actions": [],
    "deltas": []
  },
  "whitelists": {
    "actions": [],
    "deltas": [],
    "max_depth": 10,
    "root_only": false
  },
  "scaling": {
    "readers": 1,
    "ds_queues": 1,
    "ds_threads": 1,
    "ds_pool_size": 1,
    "indexing_queues": 1,
    "ad_idx_queues": 1,
    "dyn_idx_queues": 1,
    "max_autoscale": 4,
    "batch_size": 5000,
    "resume_trigger": 5000,
    "auto_scale_trigger": 20000,
    "block_queue_limit": 10000,
    "max_queue_limit": 100000,
    "routing_mode": "heatmap",
    "polling_interval": 10000
  },
  "features": {
    "streaming": {
      "enable": false,
      "traces": false,
      "deltas": false
    },
    "tables": {
      "proposals": true,
      "accounts": true,
      "voters": true
    },
    "index_deltas": true,
    "index_transfer_memo": false,
    "index_all_deltas": true,
    "deferred_trx": false,
    "failed_trx": false,
    "resource_limits": false,
    "resource_usage": false
  },
  "prefetch": {
    "read": 50,
    "block": 100,
    "index": 500
  },
  "plugins": {
    "explorer": {
      "enabled": true,
      "chain_logo_url": "{{ .conf.chain_logo_url }}",
      "server_name": "{{ .conf.serverName }}"
    }
  } 
}
{{- end }}
