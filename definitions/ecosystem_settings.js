// max js heap in MB for each indexer subprocess
const idx_js_heap = 4096;

// max js heap in MB for each api process
const api_js_heap = 1024;

function interpreterArgs(heap) {
  const arr = ['--max-old-space-size=' + heap, '--trace-deprecation', '--trace-warnings'];
  if (process.env.INSPECT) {
    arr.push('--inspect');
  }
  return arr;
}

function addIndexer(chainName) {
  return {
    script: './launcher.js',
    name: chainName + '-indexer',
    namespace: chainName,
    interpreter: 'node',
    interpreter_args: interpreterArgs(idx_js_heap),
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
    node_args: interpreterArgs(api_js_heap),
    exec_mode: 'cluster',
    merge_logs: true,
    instances: threads,
    autorestart: true,
    exp_backoff_restart_delay: 100,
    watch: false,
    env: {
      CONFIG_JSON: 'chains/' + chainName + '.config.json',
    },
  };
}

module.exports = {addIndexer, addApiServer};
