#!/usr/bin/env bash

if [ $# -eq 0 ]; then
  echo 'Please inform the app name. ex: "./stop.sh indexer"'
  exit 1
fi

pm2 trigger "$@" stop
