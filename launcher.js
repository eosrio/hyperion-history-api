const cluster = require('cluster');
const master = require('./master');
const Workers = require('./workers/index');
const {onError} = require('./helpers/functions');

(async () => {
    if (cluster.isMaster) {
        process.title = `hyperion-master-${process.env.CHAIN}`;
        master.main().catch(onError);
    } else {
        process.title = `hyperion-${process.env['worker_role']}-${process.env.CHAIN}`;
        let delay = 0;
        // Make sure readers are launched later
        // TODO: use IPC to trigger
        if (process.env['worker_role'] === 'reader') {
            delay = process.env.DESERIALIZERS * 200;
        }
        setTimeout(() => {
            switch (process.env['worker_role']) {
                case 'reader': {
                    Workers.stateReader.run().catch(onError);
                    break;
                }
                case 'deserializer': {
                    Workers.deserializer.run().catch(onError);
                    break;
                }
                case 'continuous_reader': {
                    Workers.stateReader.run().catch(onError);
                    break;
                }
                case 'ingestor': {
                    Workers.indexer.run().catch(onError);
                    break;
                }
                case 'router': {
                    Workers.wsRouter.run().catch(onError);
                    break;
                }
            }
        }, delay);
    }
})();
