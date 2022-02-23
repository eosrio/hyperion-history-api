
{{/* Common connections.json */}}
{{- define "hyperion.connection" }}
{
    "amqp": {
      "host": "{{ .Values.amqp.service }}.{{ .Namespace  }}.svc.cluster.local:5672",
      "api": "{{ .Values.amqp.service }}.{{ .Namespace  }}.svc.cluster.local:15672",
      "protocol": "http",
      "user": "{{ .Values.amqp.user }}",
      "pass": "{{ .Values.amqp.pass }}",
      "vhost": "{{ .Values.amqp.vhost }}",
      "frameMax": "0x10000"
    },
    "elasticsearch": {
      "protocol": "{{ .Values.elasticsearch.protocol }}",
      "host": "{{ .Values.elasticsearch.host }}",
      "ingest_nodes": [
          "{{ .Values.elasticsearch.ingest_nodes }}"
      ],
      "user": "{{ .Values.elasticsearch.user }}",
      "pass": "{{ .Values.elasticsearch.pass }}"
    },
    "redis": {
{{- if .Values.redis.branch  }}    
      "host": "{{ .Values.redis.host }}.{{ .Namespace  }}.svc.cluster.local",
      {{- else}}  
      "host": "{{ .Values.redis.host }}",
{{- end }} 
      "port": "{{ .Values.redis.port }}"
    },
    "chains": {
      "voice": {
        "name": "voice",
        "chain_id": "{{ .Values.chains.chain_id }}",
        "http": "{{ .Values.chains.http }}",
        "ship": "{{ .Values.chains.ship }}",
        "WS_ROUTER_PORT": 7001,
        "WS_ROUTER_HOST": "127.0.0.1"
      }
    }
  }
{{- end }}
