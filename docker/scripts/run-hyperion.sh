#!/bin/bash

_term() { 
  kill -TERM "$child" 2>/dev/null
  pm2 stop "$app_name"
}

trap _term SIGTERM

echo $1
echo $2

# Used when start.sh script is not used
if [ "$1" != true ]
then
  /home/hyperion/scripts/wait-for.sh eosio-node:8080
  if [ $? -ne 0 ]
  then
    echo "failed to wait for eosio-node"
    exit 1
  fi
fi

pm2 start --only $2 --update-env
pm2 logs --raw &

app_name=$2

child=$! 
wait "$child"
