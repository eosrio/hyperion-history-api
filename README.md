# Hyperion History API
Scalable Full History API Solution for EOSIO based blockchains

Made with ♥ by [EOS Rio](https://eosrio.io/)

### Introducing an storage-optimized action format for EOSIO

The original *history_plugin* bundled with eosio, that provided the v1 api, stored inline action traces nested inside their root actions. This led to an excessive amount of data being stored and also transferred whenever a user requested the action history for a given account. Also inline actions are used as a "event" mechanism to notify parties on a transaction. Based on those Hyperion implements some changes

1. actions are stored in a flattened format
2. a parent field is added to the inline actions to point to the parent global sequence
3. if the inline action data is identical to the parent it is considered a notification and thus removed from the database
4. no blocks or transaction data is stored, all information can be reconstructed from actions

With those changes the API format focus on delivering faster search times, lower bandwidth overhead and easier usability for UI/UX developers. 

#### Action Data Structure (work in progress)

 - `@timestamp` - block time
 - `global_sequence` - unique action global_sequence, used as index id
 - `parent` - points to the parent action (in the case of an inline action) or equal to 0 if root level
 - `block_num` - block number where the action was processed
 - `trx_id` - transaction id
 - `producer` - block producer
 - `act`
    - `account` - contract account
    - `name` - contract method name
    - `authorization` - array of signers
        - `actor` - signing actor
        - `permission` - signing permission
    - `data` - action data input object
 - `account_ram_deltas` - array of ram deltas and payers
    - `account`
    - `delta`
 - `notified` - array of accounts that were notified (via inline action events)

## Dependencies

This setup has only been tested with Ubuntu 18.04, but should work with other OS versions too

 - [Elasticsearch 7.4.X](https://www.elastic.co/downloads/elasticsearch)
 - [RabbitMQ](https://www.rabbitmq.com/install-debian.html)
 - [Redis](https://redis.io/topics/quickstart)
 - [Node.js v12](https://github.com/nodesource/distributions/blob/master/README.md#installation-instructions)
 - [PM2](http://pm2.keymetrics.io/docs/usage/quick-start/)
 - Nodeos 1.8.4 w/ state_history_plugin and chain_api_plugin
  
  > The indexer requires redis, pm2 and node.js to be on the same machine. Other dependencies might be installed on other machines, preferably over a very high speed and low latency network. Indexing speed will vary greatly depending on this configuration.
  
## Setup Instructions

Install, configure and test all dependencies above before continuing

Read the step-by-step instructions here - [INSTALL.md](https://github.com/eosrio/Hyperion-History-API/blob/master/INSTALL.md)

#### 1. Clone & Install packages
```bash
git clone https://github.com/eosrio/Hyperion-History-API.git
cd Hyperion-History-API
npm install
```

#### 2. Edit configs
```
cp example-ecosystem.config.js ecosystem.config.js
nano ecosystem.config.js

# Enter connection details here (chain name must match on the ecosystem file)
cp example-connections.json connections.json
nano connections.json
```

connections.json Reference
```
{
  "amqp": {
    "host": "127.0.0.1:5672", // RabbitMQ Server
    "api": "127.0.0.1:15672", // RabbitMQ API Endpoint
    "user": "username",
    "pass": "password",
    "vhost": "hyperion" // RabbitMQ vhost
  },
  "elasticsearch": {
    "host": "127.0.0.1:9200", // Elasticsearch HTTP API Endpoint
    "user": "elastic",
    "pass": "password"
  },
  "redis": {
    "host": "127.0.0.1",
    "port": "6379"
  },
  "chains": {
    "eos": { // Chain name (must match on the ecosystem file)
      "http": "http://127.0.0.1:8888", // Nodeos Chain API Endpoint
      "ship": "ws://127.0.0.1:8080" // Nodeos State History Endpoint
    },
    "other_chain": {...}
  }
}
```

ecosystem.config.js Reference
```
CHAIN: 'eos',                          // chain prefix for indexing
ABI_CACHE_MODE: 'false',               // only cache historical ABIs to redis
DEBUG: 'false',                        // debug mode - display extra logs for debugging
LIVE_READER: 'true',                   // enable continuous reading after reaching the head block
FETCH_DELTAS: 'false',                 // read table deltas
CREATE_INDICES: 'v1',                  // index suffix to be created, set to false to use existing aliases
START_ON: 0,                           // start indexing on block (0=disable)
STOP_ON: 0,                            // stop indexing on block  (0=disable)
AUTO_STOP: 0,                          // automatically stop Indexer after X seconds if no more blocks are being processed (0=disable)
REWRITE: 'false',                      // force rewrite the target replay range
PURGE_QUEUES: 'false',                 // clear rabbitmq queues before starting the indexer
BATCH_SIZE: 2000,                      // parallel reader batch size in blocks
QUEUE_THRESH: 8000,                    // queue size limit on rabbitmq
LIVE_ONLY: 'false',                    // only reads realtime data serially
FETCH_BLOCK: 'true',                   // Request full blocks from the state history plugin
FETCH_TRACES: 'true',                  // Request traces from the state history plugin
PREVIEW: 'false',                      // preview mode - prints worker map and exit
DISABLE_READING: 'false',              // completely disable block reading, for lagged queue processing
READERS: 3,                            // parallel state history readers
DESERIALIZERS: 4,                      // deserialization queues
DS_MULT: 4,                            // deserialization threads per queue
ES_IDX_QUEUES: 4,              // elastic indexers per queue
ES_AD_IDX_QUEUES: 2,                      // multiplier for action indexing queues
READ_PREFETCH: 50,                     // Stage 1 prefecth size
BLOCK_PREFETCH: 5,                     // Stage 2 prefecth size
INDEX_PREFETCH: 500,                   // Stage 3 prefetch size
ENABLE_INDEXING: 'true',               // enable elasticsearch indexing
INDEX_DELTAS: 'true',                  // index common table deltas (see delta on definitions/mappings)
INDEX_ALL_DELTAS: 'false'              // index all table deltas (WARNING)
```
 
 #### 3. Starting
 
 ```
 pm2 start --only Indexer --update-env
 pm2 logs Indexer
 ```
 
 #### 4. Stopping
 
 Stop reading and wait for queues to flush
 ```
 pm2 trigger Indexer stop
 ```
 
 Force stop
 ```
 pm2 stop Indexer
 ```
 
 #### 5. Starting the API node
 
 ```
 pm2 start --only API --update-env
 pm2 logs API
 ```
 
## API Reference

Documentation is automatically generated by Swagger/OpenAPI.

Example: [OpenAPI Docs](https://eos.hyperion.eosrio.io/v2/docs)

### Roadmap

- Table deltas storage & queries (in progress)
- Real-time streaming support (in progress)
- Plugin system (in progress)
- Control GUI
