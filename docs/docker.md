# Hyperion Docker

## Dependencies
- `docker` and `docker-compose`

## INSTALL
1. Edit connections.json file and change http://host.docker.internal:8888 and ws://host.docker.internal:8080
for the nodeos address
2. Change passwords in docker-compose.yml file
3. Run `docker-compose up`

## Usage
### Kibana
Access [http://localhost:5601/](http://localhost:5601/)

### RabbitMQ
Access [http://127.0.0.1:15672/](http://127.0.0.1:15672/)

### Hyperion API

Access [http://127.0.0.1:7000/v2/history/get_actions](http://127.0.0.1:7000/v2/history/get_actions)

or

```
curl http://127.0.0.1:7000/v2/history/get_actions
```

## Troubleshooting
If you're having problems accesing Kibana or using elasticsearch api, you could disable the xpack security
on the docker-compose.yml setting it to false:

```
xpack.security.enabled=false
```

#Não incentivar a usar docker em produção, só para desenvolvedor usar e fazer testes no ambiente local
