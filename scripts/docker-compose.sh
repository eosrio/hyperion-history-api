docker-compose up --no-start
docker-compose start elasticsearch kibana rabbitmq redis
docker-compose start eosio-node


until curl -s -f -o /dev/null "http://elastic:password@localhost:9200/"
do
  sleep 5
done

docker-compose start hyperion-api hyperion-indexer