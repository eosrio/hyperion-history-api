module.exports = {
    apps: [
        {
            name: "Indexer",
            script: "./launcher.js",
            node_args: ["--max-old-space-size=6000"],
            autorestart: false,
            kill_timeout: 240000,
            env: {
                AMQP_HOST: '',
                AMQP_USER: 'input',
                AMQP_PASS: 'password',
                ES_HOST: '',
                NODEOS_HTTP: '',
                NODEOS_WS: '',
                START_ON: 0,
                STOP_ON: 0,
                BATCH_SIZE: 1500,
                LIVE_READER: 'false',
                LIVE_ONLY: 'false',
                FETCH_BLOCK: 'true',
                FETCH_TRACES: 'true',
                FETCH_DELTAS: 'false',
                CHAIN: 'eos',
                PREVIEW: 'false',
                READERS: 2,
                DESERIALIZERS: 8,
                DS_MULT: 3,
                ES_INDEXERS_PER_QUEUE: 4,
                ES_ACT_QUEUES: 2,
                READ_PREFETCH: 10,
                BLOCK_PREFETCH: 100,
                INDEX_PREFETCH: 500,
                FLUSH_INDICES: 'false',
                ENABLE_INDEXING: 'true',
                ABI_CACHE_MODE: 'false'
            },
        }
    ]
};
