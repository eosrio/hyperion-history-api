# Getting Started

## Installation

### Dependencies

This setup has only been tested with Ubuntu 18.04, but should work with other OS versions too

 - [Elasticsearch 7.4.X](https://www.elastic.co/downloads/elasticsearch)
 - [RabbitMQ](https://www.rabbitmq.com/install-debian.html)
 - [Redis](https://redis.io/topics/quickstart)
 - [Node.js v13](https://github.com/nodesource/distributions/blob/master/README.md#installation-instructions)
 - [PM2](http://pm2.keymetrics.io/docs/usage/quick-start/)
 - Nodeos 1.8+ w/ state_history_plugin and chain_api_plugin

!!! note  
    The indexer requires redis, pm2 and node.js to be on the same machine. Other dependencies might be installed on other machines, preferably over a very high speed and low latency network. Indexing speed will vary greatly depending on this configuration.

#### Elasticsearch Installation

!!! info
    Follow the detailed installation instructions on the official [elasticsearch documentation](https://www.elastic.co/guide/en/elasticsearch/reference/current/deb.html)

##### 1. Edit `/etc/elasticsearch/elasticsearch.yml`

```
cluster.name: myCluster
bootstrap.memory_lock: true
```

!!! warning  
    Setting `bootstrap.memory_lock: true` will use all your RAM on startup. This is optional.
    This also might cause the JVM or shell session to exit if it tries to allocate more memory than is available!
    
After starting Elasticsearch, you can see whether this setting was applied successfully by checking the value of mlockall in the output from this request:

````
GET _nodes?filter_path=**.mlockall
```` 

##### 2. Edit `/etc/elasticsearch/jvm.options`

```
# Set your heap size, avoid allocating more than 31GB, even if you have enought RAM.
# Test on your specific machine by changing -Xmx32g in the following command:
# java -Xmx32g -XX:+UseCompressedOops -XX:+PrintFlagsFinal Oops | grep Oops
-Xms16g
-Xmx16g
```

##### 3. Allow memlock
run `sudo systemctl edit elasticsearch` and add the following lines

```
[Service]
LimitMEMLOCK=infinity
```

##### 4. Start elasticsearch and check the logs (verify if the memory lock was successful)

```bash
sudo service elasticsearch start
sudo less /var/log/elasticsearch/myCluster.log
sudo systemctl enable elasticsearch
```

##### 5. Test the REST API

`curl http://localhost:9200`

```json
{
  "name" : "ip-172-31-5-121",
  "cluster_name" : "hyperion",
  "cluster_uuid" : "....",
  "version" : {
    "number" : "7.1.0",
    "build_flavor" : "default",
    "build_type" : "deb",
    "build_hash" : "606a173",
    "build_date" : "2019-05-16T00:43:15.323135Z",
    "build_snapshot" : false,
    "lucene_version" : "8.0.0",
    "minimum_wire_compatibility_version" : "6.8.0",
    "minimum_index_compatibility_version" : "6.0.0-beta1"
  },
  "tagline" : "You Know, for Search"
}
```

The Default user and password is:
```
user: elastic
password: changeme
```

You can change the password via the API, like this:
```
curl -X POST "localhost:9200/_security/user/elastic/_password?pretty" -H 'Content-Type: application/json' -d'
{
  "password" : "new_password"
}'
```

#### RabbitMQ Installation

!!! info
    Follow the detailed installation instructions on the official [RabbitMQ documentation](https://www.rabbitmq.com/install-debian.html#installation-methods)

##### 1. Enable the WebUI

```bash
sudo rabbitmq-plugins enable rabbitmq_management
```

##### 2. Add vhost
```bash
sudo rabbitmqctl add_vhost /hyperion
```

##### 2. Create a user and password
```bash
sudo rabbitmqctl add_user {my_user} {my_password}
```
##### 3. Set the user as administrator
```bash
sudo rabbitmqctl set_user_tags {my_user} administrator
```

##### 4. Set the user permissions to the vhost
```bash
sudo rabbitmqctl set_permissions -p /hyperion {my_user} ".*" ".*" ".*"
```

##### 5. Check access to the WebUI

[http://localhost:15672](http://localhost:15672)

#### Redis Installation

##### 1. Install
```bash
sudo apt install redis-server
```

##### 2. Edit `/etc/redis/redis.conf`

!!! note
    By default, redis binds to the localhost address. You need to edit
    the config file if you want to listen to other network.

##### 3. Change supervised to `systemd`
```bash
sudo systemctl restart redis.service
```

#### NodeJS

##### 1. Install the nodejs source
```bash
curl -sL https://deb.nodesource.com/setup_13.x | sudo -E bash -
```

##### 2. Install
```bash
sudo apt-get install -y nodejs
```

#### PM2

##### 1. Install
```bash
sudo npm install pm2@latest -g
```

##### 2. Run
```bash
sudo pm2 startup
```

#### Kibana Installation
!!! info
    Follow the detailed installation instructions on the [official documentation](https://www.elastic.co/downloads/kibana)


#### nodeos config.ini
```
state-history-dir = "state-history"
trace-history = true
chain-state-history = true
state-history-endpoint = 127.0.0.1:8080
plugin = eosio::state_history_plugin
```

#### Hyperion

##### 1. Clone & Install packages
```bash
git clone https://github.com/eosrio/Hyperion-History-API.git
cd Hyperion-History-API
npm install
```

##### 2. Edit configs
```
cp example-ecosystem.config.js ecosystem.config.js
nano ecosystem.config.js

# Enter connection details here (chain name must match on the ecosystem file)
cp example-connections.json connections.json
nano connections.json
```

connections.json Reference
```json
{
   "amqp":{
      "host":"127.0.0.1:5672",
      "api":"127.0.0.1:15672",
      "user":"my_user",
      "pass":"my_password",
      "vhost":"hyperion"
   },
   "elasticsearch":{
      "host":"127.0.0.1:9200",
      "ingest_nodes":[
         "127.0.0.1:9200"
      ],
      "user":"",
      "pass":""
   },
   "redis":{
      "host":"127.0.0.1",
      "port":"6379"
   },
   "chains":{
      "eos":{
         "name":"EOS Mainnet",
         "chain_id":"aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906",
         "http":"http://127.0.0.1:8888",
         "ship":"ws://127.0.0.1:8080",
         "WS_ROUTER_PORT":7001
      }
   }
}
```
For more details, refer to the [connections section](connections.md)

ecosystem.config.js Reference
```javascript
module.exports = {
    apps: [
        addIndexer('eos'),
        addApiServer('eos', 1)
    ]
};
```
For more details, refer to the [ecosystem section](ecosystem.md)

### Setup

Explicar as configurações iniciais.

Modificar os example.ecosystems...etc

### Start and Stop

We provide scripts to make simple the process of start and stop you Hyperion Indexer or API instance.
But, you can also do it manually if you prefer. This section will cover both ways.

#### Using run / stop script

You can use `run` script to start the Indexer or the API.
```
./run.sh chain-indexer

./run.sh chain-api
```
Examples:
Start indexing EOS mainnet
```
./run.sh eos-indexer
```
Start EOS API
```
./run.sh eos-api
```
Remember that the chain name was previously defined on the [Hyperion section](#hyperion).

The `stop` script follows the same pattern of the `run` script:
```
./stop.sh chain-indexer

./stop.sh chain-api
```

Example:
Stop the EOS mainnet indexer
```
./stop.sh eos-indexer
```
!!! note  
    Stop script wont stop Hyperion Indexer immediately, it will first flush the queues.
    This operation could take some time.
    If you want to stop immediately, you need to run the "Force stop command"

#### Commands

Start indexing
```
pm2 start --only chain-indexer --update-env
pm2 logs chain-indexer
```

Stop reading and wait for queues to flush
```
pm2 trigger chain-indexer stop
```

Force stop
```
pm2 stop chain-indexer
```

Starting the API node
```
pm2 start --only chain-api --update-env
pm2 logs chain-api
```

### API Reference

API Reference: [API section](api.md)

Example: [OpenAPI Docs](https://eos.hyperion.eosrio.io/v2/docs)
