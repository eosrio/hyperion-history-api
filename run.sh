#!/usr/bin/env bash

if [ $# -eq 0 ]; then
  echo 'Please inform the app name. ex: "./run.sh indexer"'
  exit 1
fi

pm2 start --only "$@" --update-env
pm2 logs --raw "$@"
