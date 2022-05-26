#!/bin/bash
set -eu
jq --arg elastic_user $ELASTIC_USER --arg elastic_pass $ELASTIC_PASS --arg elastic_host $ELASTIC_HOST \
    '.elasticsearch.user = $elastic_user | .elasticsearch.pass = $elastic_pass | .elasticsearch.host = $elastic_host | .elasticsearch.ingest_nodes = [$elastic_host]' \
    /tmp/connections.json > /opt/app/connections.json

jq  --arg server_name $SERVER_NAME --arg LAUNCHDARKLY_SDK_KEY $LAUNCHDARKLY_SDK_KEY --arg LAUNCHDARKLY_CLIENT_SIDE_ID $LAUNCHDARKLY_CLIENT_SIDE_ID \
    '.api.server_name = $server_name |.launchdarkly.sdk_key = $LAUNCHDARKLY_CLIENT_SIDE_ID | .launchdarkly.clinet_side_id = $LAUNCHDARKLY_CLIENT_SIDE_ID' /tmp/voice.config.json > /opt/app/chains/voice.config.json
./run.sh $@
