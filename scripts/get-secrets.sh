#!/bin/bash

set -eu

jq --arg elastic_user $elastic_user --arg  elastic_pass $elastic_pass --arg elastic_host $elastic_host \
    '.elasticsearch.user = $elastic_user | .elasticsearch.pass =  $elastic_pass | .elasticsearch.host = $elastic_host | .elasticsearch.ingest_nodes = [$elastic_host] '  \
    /tmp/connections.json > /hyperion-history-api/connections.json

jq --arg  server_name $server_name \
    '.api.server_name = $server_name'  /temp/voice.config.json> chains/example.config.json

./run.sh $@
