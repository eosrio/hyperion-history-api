#!/usr/bin/env bash

if [[ ! `pm2 --help` ]]; then
  echo "install pm2"
  npm i -g pm2
fi

pm2 delete Indexer
pm2 delete API

rm -f ~/.pm2/logs/Indexer-*
rm -f ~/.pm2/logs/API-*
rm -f ~/.pm2/dump*

pm2 update

pm2 start
