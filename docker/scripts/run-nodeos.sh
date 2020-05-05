#!/bin/bash

_term() { 
  kill -TERM "$child" 2>/dev/null
  sleep 5
}

trap _term SIGTERM

if [ "$1" = "" ]
then
  nodeos --genesis-json /root/eosio/config/genesis.json --disable-replay-opts --data-dir /root/eosio/data --config-dir /root/eosio/config &
else
  nodeos --delete-all-blocks --snapshot /root/eosio/data/snapshots/$1 --disable-replay-opts --data-dir /root/eosio/data --config-dir /root/eosio/config &
fi

child=$! 
wait "$child"
