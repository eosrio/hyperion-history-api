jq --arg elastic_user $elastic_user --arg  elastic_pass $elastic_pass '.elasticsearch.user = $elastic_user | .elasticsearch.pass =  $elastic_pass ' /tmp/connections.json > /hyperion-history-api/connections.json

./run.sh $@
