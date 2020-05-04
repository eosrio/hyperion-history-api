#!/bin/sh

timeout=90

usage() {
  exitcode="$1"

  echo "Usage:$cmdname host:port [OPTIONS]"
  echo ""
  echo "Options"
  echo "  -t, --timeout number    Timeout in seconds, zero for no timeout"
  echo "  -c, --cmd COMMAND ARGS  Execute command with args after waiting"

  exit "$exitcode"
}

wait_for() {
  for i in `seq $timeout` ; do
    nc -z "$host" "$port" > /dev/null 2>&1

    result=$?
    if [ $result -eq 0 ] ; then
      if [ $# -gt 0 ] ; then
        exec "$@"
      fi
      exit 0
    fi
    sleep 1
  done
  echo "Operation timed out" >&2
  exit 1
}

while [ $# -gt 0 ]
do
  key="$1"

  case $key in
    *:*)
    host=$(printf "%s\n" "$1"| cut -d : -f 1)
    port=$(printf "%s\n" "$1"| cut -d : -f 2)
    shift
    ;;
    -t|--timeout)
    timeout="$2"
    if [ "$timeout" = "" ]; then break; fi
    shift 2
    ;;
    -c|--cmd)
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

if [ "$host" = "" -o "$port" = "" ]; then
  echo "Error: you need to provide host and port"
  usage 2
fi

wait_for "$@"
