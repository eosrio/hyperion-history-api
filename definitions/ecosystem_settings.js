function addIndexer(chainName) {
  return {
    script: './launcher.js',
    name: chainName + '-indexer',
    namespace: chainName,
    interpreter: 'node',
    interpreter_args: ['--max-old-space-size=4096', '--trace-deprecation'],
    autorestart: false,
    kill_timeout: 3600,
    watch: false,
    time: true,
    env: {
      CONFIG_JSON: 'chains/' + chainName + '.config.json',
      TRACE_LOGS: 'false',
    },
  };
}

function addApiServer(chainName, threads) {
  return {
    script: './api/server.js',
    name: chainName + '-api',
    namespace: chainName,
    node_args: ['--trace-deprecation'],
    exec_mode: 'cluster',
    merge_logs: true,
    instances: threads,
    autorestart: true,
    exp_backoff_restart_delay: 100,
    watch: false,
    time: true,
    env: {
      CONFIG_JSON: 'chains/' + chainName + '.config.json',
    },
  };
}

module.exports = {addIndexer, addApiServer};
