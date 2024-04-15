#!/bin/bash

_term() { 
  kill -TERM "$child" 2>/dev/null
  sleep 5
}

trap _term SIGTERM

echo $1
echo $2

# Used when start.sh script is not used
if [ "$1" != true ]
then
  /home/eosio/scripts/wait-for.sh rabbitmq:5672
  if [ $? -ne 0 ]
  then
    echo "failed to wait for rabbitmq"
    exit 1
  fi

  /home/eosio/scripts/wait-for.sh elasticsearch:9200
  if [ $? -ne 0 ]
  then
    echo "failed to wait for elasticsearch"
    exit 1
  fi
fi

if [ "$2" = "" ]
then
  nodeos --genesis-json /home/eosio/config/genesis.json --disable-replay-opts --data-dir /home/eosio/data --config-dir /home/eosio/config &
else
  nodeos --delete-all-blocks --snapshot /home/eosio/data/snapshots/$2 --disable-replay-opts --data-dir /home/eosio/data --config-dir /home/eosio/config &
fi

child=$! 
wait "$child"
