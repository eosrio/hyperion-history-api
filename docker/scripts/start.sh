#!/bin/bash

usage() {
  exitcode="$1"

  echo "Usage:$cmdname [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  -s, --snapshot string  file path of chain snapshot"

  exit "$exitcode"
}

wait_for_container() {
  container_ip=`sudo docker inspect --format='{{json .NetworkSettings.Networks.docker_hyperion.IPAddress}}' $1`

  ./scripts/wait-for.sh "${container_ip//\"}:$2"
}

while [ $# -gt 0 ]
do
  key="$1"

  case $key in
    -s|--snapshot)
    snapshot="$2"
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

# Create docker containers
sudo docker-compose up --no-start

# Starting redis container
sudo docker-compose start redis

# Starting rabbitmq container
sudo docker-compose start rabbitmq

# Starting elasticsearch container
wait_for_container rabbitmq 5672

if [ $? -ne 0 ]
then
  echo "failed to wait for rabbitmq"
  exit 1
fi

sudo docker-compose start elasticsearch

# Starting kibana container
wait_for_container elasticsearch 9200

if [ $? -ne 0 ]
then
  echo "failed to wait for elasticsearch"
  exit 1
fi

sudo docker-compose start kibana

# Starting eosio-node container
wait_for_container kibana 5601
sudo docker-compose start eosio-node

# Starting hyperion containers
wait_for_container eosio-node 8888
sudo docker-compose start hyperion-indexer
sudo docker-compose start hyperion-api
