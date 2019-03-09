module.exports = {
    apps: [
        {
            name: "Indexer",
            script: "./launcher.js",
            node_args: ["--max-old-space-size=8192"],
            autorestart: false,
            kill_timeout: 3600,
            env: {
                AMQP_HOST: '127.0.0.1:5672',
                AMQP_USER: 'input',
                AMQP_PASS: '',
                ES_HOST: '127.0.0.1:9200',
                NODEOS_HTTP: 'http://127.0.0.1:8888',
                NODEOS_WS: 'ws://127.0.0.1:8080',
                START_ON: 0,
                STOP_ON: 0,
                REWRITE: 'true',
                BATCH_SIZE: 1000,
                LIVE_READER: 'true',
                LIVE_ONLY: 'false',
                FETCH_BLOCK: 'true',
                FETCH_TRACES: 'true',
                FETCH_DELTAS: 'false',
                CHAIN: 'mainnet',
                PREVIEW: 'true',
                DISABLE_READING: 'false',
                READERS: 1,
                DESERIALIZERS: 1,
                DS_MULT: 1,
                ES_INDEXERS_PER_QUEUE: 1,
                ES_ACT_QUEUES: 1,
                READ_PREFETCH: 10,
                BLOCK_PREFETCH: 20,
                INDEX_PREFETCH: 200,
                FLUSH_INDICES: 'false',
                ENABLE_INDEXING: 'true',
                ABI_CACHE_MODE: 'false'
            }
        },
        {
            name: 'API',
            script: "./api/api-loader.js",
            exec_mode: 'cluster',
            merge_logs: true,
            instances: 4,
            autorestart: true,
            exp_backoff_restart_delay: 100,
            watch: ["api"],
            env: {
                SERVER_PORT: '7000',
                SERVER_NAME: 'example.com',
                SERVER_ADDR: '127.0.0.1',
                NODEOS_HTTP: 'http://127.0.0.1:8888',
                ES_HOST: '127.0.0.1:9200',
                CHAIN: 'mainnet'
            }
        }
    ]
};
