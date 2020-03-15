#!/bin/bash
curl -Ssf "http://$1/$2-action-*/_search?size=$3&sort=block_num:desc" | jq '.hits.hits[]._source | [.["@timestamp"
],.block_num,.act.account,.act.name] | @tsv' -r
