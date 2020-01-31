module.exports = {
    apps: [
        {
            name: "Indexer",
            script: "./launcher.js",
            node_args: ["--trace-deprecation","--max-old-space-size=4096"],
            autorestart: false,
            kill_timeout: 3600,
            env: {
                CONFIG_JSON: 'chains/eosiotest.config.json'
            }
        },
        {
            name: 'API',
            script: "./api/api-loader.js",
            exec_mode: 'cluster',
            node_args: ["--trace-deprecation"],
            merge_logs: true,
            instances: 1,
            autorestart: true,
            exp_backoff_restart_delay: 100,
            watch: ["api"],
            env: {
                CONFIG_JSON: 'chains/eosiotest.config.json',
                PROVIDER_NAME: 'Provider Name',
                PROVIDER_URL: 'https://yourproviderwebsite',
                CHAIN: 'eos',
                CHAIN_NAME: 'EOS Mainnet',
                CHAIN_LOGO_URL: 'https://bloks.io/img/chains/eos.png',
                SERVER_PORT: '7000',
                SERVER_NAME: 'example.com',
                SERVER_ADDR: '127.0.0.1',
                ENABLE_CACHING: 'true',
                CACHE_LIFE: 30,
                ENABLE_STREAMING: false
            }
        }
    ]
};
