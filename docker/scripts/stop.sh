#!/bin/bash

usage() {
  exitcode="$1"

  echo "Usage:$cmdname [OPTIONS] [SERVICES]"
  echo ""
  echo "Options:"
  echo "  -d, --down  stop all services and remove its containers"

  exit "$exitcode"
}

servies=()

while [ $# -gt 0 ]
do
  key="$1"

  case $key in
    -d|--down)
    down=true
    shift
    ;;
    -h|--help)
    usage 0
    ;;
    *)
    services+=($1)
    shift
    ;;
  esac
done

if [ $down ]
then
  docker-compose down
elif [ ${#services[@]} -eq 0 ]
then
  docker-compose stop
else
  for i in "${services[@]}"
  do
    docker-compose stop $i
  done
fi
