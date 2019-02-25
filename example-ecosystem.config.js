module.exports = {
    apps: [
        {
            name: "Indexer",
            script: "./launcher.js",
            node_args: ["--max-old-space-size=8192"],
            autorestart: false,
            kill_timeout: 800000,
            env: {
                AMQP_HOST: '127.0.0.1:5672',
                AMQP_USER: 'input',
                AMQP_PASS: '',
                ES_HOST: '172.16.1.12:9200',
                NODEOS_HTTP: 'http://127.0.0.1:8888',
                NODEOS_WS: 'ws://127.0.0.1:8080',
                START_ON:  1,
                STOP_ON:   44124572,
                REWRITE: 'true',
                BATCH_SIZE: 1500,
                LIVE_READER: 'false',
                LIVE_ONLY: 'false',
                FETCH_BLOCK: 'true',
                FETCH_TRACES: 'true',
                FETCH_DELTAS: 'false',
                CHAIN: 'eos',
                PREVIEW: 'false',
                DISABLE_READING: 'false',
                READERS: 8,
                DESERIALIZERS: 4,
                DS_MULT: 10,
                ES_INDEXERS_PER_QUEUE: 6,
                ES_ACT_QUEUES: 6,
                READ_PREFETCH: 100,
                BLOCK_PREFETCH: 200,
                INDEX_PREFETCH: 500,
                FLUSH_INDICES: 'false',
                ENABLE_INDEXING: 'true',
                ABI_CACHE_MODE: 'false'
            },
        }
    ]
};
