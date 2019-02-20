module.exports = {
    apps: [
        {
            name: "HyperionIndexer",
            script: "./launcher.js",
            node_args: ["--max-old-space-size=8192"],
            autorestart: false,
            env: {
                AMQP_HOST: '127.0.0.1:5672',
                AMQP_USER: '',
                AMQP_PASS: '',
                ES_HOST: '127.0.0.1:9200',
                NODEOS_HTTP: 'http://127.0.0.1:8888',
                NODEOS_WS: 'ws://127.0.0.1:8080',
                START_ON: 38000000,
                STOP_ON:  50000000,
                BATCH_SIZE: 1500,
                LIVE_READER: 'false',
                FETCH_BLOCK: 'false',
                FETCH_TRACES: 'false',
                FETCH_DELTAS: 'true',
                CHAIN: 'eos',
                PREVIEW: 'false',
                READERS: 8,
                DESERIALIZERS: 10,
                DS_MULT: 2,
                ES_INDEXERS_PER_QUEUE: 1,
                ES_ACT_QUEUES: 1,
                READ_PREFETCH: 200,
                BLOCK_PREFETCH: 25,
                INDEX_PREFETCH: 100,
                FLUSH_INDICES: 'false',
                ENABLE_INDEXING: 'false',
                ABI_CACHE_MODE: 'true'
            },
        }
    ]
};
