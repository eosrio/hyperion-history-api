#!/usr/bin/env bash

mkdir -p esdata01
mkdir -p esdata02
mkdir -p rabbitmq

docker-compose up -d

echo "Going to show log in 3s"
echo "To close logs: ctrl + c"
echo "To close down: docker-compose down"

sleep 3
docker-compose logs -f
