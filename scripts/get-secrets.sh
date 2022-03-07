#!/bin/bash

set -eu

jq --arg elastic_user $ELASTIC_USER --arg  elastic_pass $ELASTIC_PASS --arg elastic_host $ELASTIC_HOST \
    '.elasticsearch.user = $elastic_user | .elasticsearch.pass =  $elastic_pass | .elasticsearch.host = $elastic_host | .elasticsearch.ingest_nodes = [$elastic_host] '  \
    /tmp/connections.json > /hyperion-history-api/connections.json

jq --arg  server_name $SERVER_NAME \
    '.api.server_name = $server_name'  /temp/voice.config.json> chains/example.config.json

./run.sh $@
