#!/bin/bash

/root/scripts/wait-for.sh rabbitmq:5672 
/root/scripts/wait-for.sh elasticsearch:9200

pm2 start --only $1 --update-env
pm2 logs --raw
