#!/usr/bin/env bash
if [ $# -eq 0 ]; then
  echo 'Please inform the app name. ex: "./run.sh indexer"'
  exit 1
fi
echo -e "\n-->> Starting $1..."
(
  set -x
  pm2 start pm2/ecosystem.config.cjs --only "$@" --update-env --silent
)
echo -e "\n-->> Saving pm2 state..."
(
  set -x
  pm2 save
)
echo -e "\n-->> Reading $1 logs..."
(
  set -x
  pm2 logs --raw --lines 10 "$@"
)
