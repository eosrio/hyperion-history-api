#!/usr/bin/env bash
set -e

function usage {
  cat <<EOF
Usage: start-skaffold.sh -u <username>
  -u | --username         [optional] Voice employee user, example john.doe, defaults to logged in username
  -h | --help             print usage
EOF
  }

USERNAME=$(id -un | awk '{print tolower($0)}' )@voice.com

while true; do
  case $1 in
    -u | --username) USERNAME=$2@voice.com; shift 2 ;;
    -h | --help) usage; exit 0;;
    *) break;;
  esac
done

function stop_skaffold() {
  yarn clean-skaffold
}

trap stop_skaffold INT


yarn start-skaffold --username $USERNAME
