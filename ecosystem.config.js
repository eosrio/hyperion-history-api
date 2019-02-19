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
                START_ON: 0,
                STOP_ON: 0,
                LIVE_READER: 'true',
                FETCH_DELTAS: 'false',
                CHAIN: 'eos',
                PREVIEW: 'false',
                READERS: 3,
                DESERIALIZERS: 6,
                DS_MULT: 6,
                ES_INDEXERS_PER_QUEUE: 2,
                ES_ACT_QUEUES: 2,
                READ_PREFETCH: 50,
                BLOCK_PREFETCH: 5,
                INDEX_PREFETCH: 500,
                FLUSH_INDICES: 'false'
            },
        }
    ]
};
