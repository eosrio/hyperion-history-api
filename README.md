# Hyperion History API
Scalable Full History API Solution for EOSIO based blockchains

Made with ♥ by [EOS Rio](https://eosrio.io/)

## Dependencies

This setup has only been tested with Ubuntu 18.04, but should work with other OS versions too

 - [Elasticsearch 7.0.0-beta1](https://www.elastic.co/downloads/elasticsearch#preview-release)
 - [RabbitMQ](https://www.rabbitmq.com/install-debian.html)
 - [Redis](https://redis.io/topics/quickstart)
 - [Node.js v11](https://github.com/nodesource/distributions/blob/master/README.md#installation-instructions)
 - [PM2](https://pm2.io/doc/en/runtime/quick-start)
 - Nodeos 1.6.1 w/ state_history_plugin
 - Nodeos 1.6.1 w/ chain_api_plugin
 
  
## Setup Instructions

Install, configure and test all dependencies above before continuing

#### 1. Clone & Install packages
```bash
git clone https://github.com/eosrio/Hyperion-History-API.git
cd Hyperion-History-API
npm install
```

#### 2. Edit configs
`nano ecosystem.config.js`

Reference
```
AMQP_HOST: '127.0.0.1:5672'            // RabbitMQ host:port
AMQP_USER: '',                         // RabbitMQ user
AMQP_PASS: '',                         // RabbitMQ password
ES_HOST: '127.0.0.1:9200',             // elasticsearch http endpoint
NODEOS_HTTP: 'http://127.0.0.1:8888',  // chain api endpoint
NODEOS_WS: 'ws://127.0.0.1:8080',      // state history endpoint
LIVE_READER: 'true',                   // enable continuous reading after reaching the head block
FETCH_DELTAS: 'false',                 // read table deltas
CHAIN: 'eos',                          // chain prefix for indexing
START_ON: 1,                           // start indexing on block (0=disable)
STOP_ON: 10000000,                     // stop indexing on block  (0=disable)
PREVIEW: 'false',                      // preview mode - prints worker map and exit
READERS: 3,                            // parallel state history readers
DESERIALIZERS: 4,                      // deserialization queues
DS_MULT: 4,                            // deserialization threads per queue
ES_INDEXERS_PER_QUEUE: 4,              // elastic indexers per queue
ES_ACT_QUEUES: 2,                      // multiplier for action indexing queues
READ_PREFETCH: 50,                     // Stage 1 prefecth
BLOCK_PREFETCH: 5,                     // Stage 2 prefecth
INDEX_PREFETCH: 500,                   // Stage 3 prefetch
FLUSH_INDICES: 'false'                 // CAUTION: Delete all elastic indices
```
 
 #### 3. Starting
 
 ```
 pm2 start
 pm2 logs
 ```
 
 
## API Reference

[full documentation](https://eosrio.github.io/Hyperion-History-API/)
 
#### `/v2/history/get_actions`
 
#### `/v2/history/get_transaction`

#### `/v2/history/get_inline_actions`
 
### Performance Benchmarks

### Roadmap
