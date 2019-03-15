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
                REWRITE: 'false',
                BATCH_SIZE: 5000,
                LIVE_READER: 'false',
                LIVE_ONLY: 'false',
                FETCH_BLOCK: 'false',
                FETCH_TRACES: 'false',
                CHAIN: 'eos',
                CREATE_INDICES: 'v1',
                PREVIEW: 'false',
                DISABLE_READING: 'false',
                READERS: 1,
                DESERIALIZERS: 1,
                DS_MULT: 1,
                ES_INDEXERS_PER_QUEUE: 1,
                ES_ACT_QUEUES: 1,
                READ_PREFETCH: 50,
                BLOCK_PREFETCH: 100,
                INDEX_PREFETCH: 500,
                ENABLE_INDEXING: 'true',
                PROC_DELTAS: 'true',
                INDEX_DELTAS: 'true',
                INDEX_ALL_DELTAS: 'false',
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
                CHAIN: 'eos'
            }
        }
    ]
};
