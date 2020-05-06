#!/bin/bash

usage() {
  exitcode="$1"

  echo "Usage:$cmdname --chain string --chain-name string [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --chain-id string  chain id"

  exit "$exitcode"
}

chain_id="6cbecff836a9fa60da53bf97a0a180103b2e76041d4414693d11bf39e2341547"

while [ $# -gt 0 ]
do
  key="$1"

  case $key in
    --chain)
    chain="$2"
    shift
    shift
    ;;
    --chain-name)
    chain_name="$2"
    shift
    shift
    ;;
    --chain-id)
    chain_id="$2"
    shift
    shift
    ;;
    -h|--help)
    usage 0
    ;;
    *)
    echo "Unknown argument: $1"
    usage 1
    ;;
  esac
done

if [ "$chain" = "" ] || [ "$chain_name" = "" ]
then
  usage 1
fi

# prepare docer-compose.yml file
file=docker-compose.yml
if [ -f $file ]
then
  rm $file
fi

cp template-docker-compose.yml $file

sed -i "s/CHAIN/$chain/" $file

# prepare connection.json file
file=hyperion/config/connections.json
if [ -f $file ]
then
  rm $file
fi

cp ../example-connections.json $file

sed -i "s/127.0.0.1:5672/rabbitmq:5672/" $file
sed -i "s/127.0.0.1:15672/rabbitmq:15672/" $file

sed -i "s/127.0.0.1:9200/elasticsearch:9200/" $file

sed -i 's/"host": "127.0.0.1"/"host": "redis"/' $file

sed -i "s/eos/$chain/" $file
sed -i "s/EOS Mainnet/$chain_name/" $file
sed -i "s/aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906/$chain_id/" $file
sed -i "s/127.0.0.1:8888/eosio-node:8888/" $file
sed -i "s/127.0.0.1:8080/eosio-node:8080/" $file
sed -i "s/127.0.0.1/hyperion-api/" $file

# prepare connection.json file
file=hyperion/config/ecosystem.config.js
if [ -f $file ]
then
  rm $file
fi

cp ../example-ecosystem.config.js $file

sed -i "s/eos/$chain/" $file

# prepare connection.json file
file=hyperion/config/chains/$chain.config.json
if [ -f $file ]
then
  rm $file
fi

cp ../chains/example.config.json $file

sed -i "s/EXAMPLE Chain/$chain_name/" $file
sed -i "s/127.0.0.1/hyperion-api/g" $file
sed -i "s/\"chain\": \"eos\"/\"chain\": \"$chain\"/" $file
sed -i 's/"start_on": 0/"start_on": 1/' $file
sed -i 's/"live_reader": false/"live_reader": true/' $file
sed -i 's/"abi_scan_mode": true/"abi_scan_mode": false/' $file
