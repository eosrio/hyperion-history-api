# Hyperion History API
Scalable Full History API Solution for EOSIO based blockchain

Made with ♥ by EOS Rio

## Dependencies

 - [Elasticsearch 6.6.0](https://www.elastic.co/downloads/elasticsearch#ga-release)
 - [RabbitMQ](https://www.rabbitmq.com/install-debian.html)
 - Redis
 - Node.js v11
 - Nodeos 1.6.1 w/ state_history_plugin
 - Nodeos 1.6.1 w/ chain_api_plugin
 - [PM2](https://pm2.io/doc/en/runtime/quick-start)
 
## Setup Instructions

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
NODEOS_HTTP: 'http://127.0.0.1:30001', // chain api endpoint
NODEOS_WS: 'ws://127.0.0.1:38080',     // state history endpoint
LIVE_READER: 'true',                   // enable continuous reading after reaching the head block
FETCH_DELTAS: 'false',                 // read table deltas
CHAIN: 'bos',                          // chain prefix for indexing
PREVIEW: 'false',                      // preview mode - prints worker map and exit
READERS: 3,                            // parallel state history readers
DESERIALIZERS: 4,                      // deserialization queues
DS_MULT: 4,                            // deserialization threads per queue
ES_INDEXERS_PER_QUEUE: 4,              // elastic indexers per queue
ES_ACT_QUEUES: 2,                      // not used
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
 
#### `/v2/history/get_actions`
 
#### `/v2/history/get_transaction`

#### `/v2/history/get_inline_actions`
 
## Performance Benchmarks

## Roadmap
