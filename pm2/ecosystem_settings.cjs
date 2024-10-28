function interpreterArgs(heap, traceDeprecation, traceWarnings) {
    const arr = [];
    if (traceDeprecation) {
        arr.push('--trace-deprecation');
    }
    if (traceWarnings) {
        arr.push('--trace-warnings');
    }
    if (heap) {
        arr.push('--max-old-space-size=' + heap);
    } else {
        arr.push('--max-old-space-size=2048');
    }
    if (process.env.INSPECT) {
        arr.push('--inspect');
    }
    return arr;
}

function addIndexer(chainName, heap, traceDeprecation, traceWarnings) {
    return {
        script: './build/indexer/launcher.js',
        name: chainName + '-indexer',
        namespace: chainName,
        interpreter: 'node',
        interpreter_args: interpreterArgs(heap, traceDeprecation, traceWarnings),
        autorestart: false,
        kill_timeout: 3600,
        watch: false,
        time: true,
        env: {
            CONFIG_JSON: 'config/chains/' + chainName + '.config.json',
            TRACE_LOGS: 'false',
        },
    };
}

function addApiServer(chainName, threads, heap, traceDeprecation, traceWarnings) {
    return {
        script: './build/api/server.js',
        name: chainName + '-api',
        namespace: chainName,
        node_args: interpreterArgs(heap, traceDeprecation, traceWarnings),
        exec_mode: 'cluster',
        merge_logs: true,
        instances: threads,
        autorestart: true,
        exp_backoff_restart_delay: 100,
        watch: false,
        time: true,
        env: {
            CONFIG_JSON: 'config/chains/' + chainName + '.config.json',
        },
    };
}

module.exports = {addIndexer, addApiServer};
