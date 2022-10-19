import cluster from "node:cluster";
import { ConfigurationModule } from "./modules/config.js";
import { hLog } from "./helpers/common_functions.js";
const hyperionWorkers = {
    ds_pool_worker: 'ds-pool',
    reader: 'state-reader',
    deserializer: 'deserializer',
    continuous_reader: 'state-reader',
    ingestor: 'indexer',
    router: 'ws-router',
    delta_updater: 'delta-updater'
};
async function launch() {
    const conf = new ConfigurationModule();
    const chain_name = conf.config.settings.chain;
    const env = {
        worker_id: process.env.worker_id,
        worker_role: process.env.worker_role
    };
    process.on('SIGINT', function () {
        hLog("caught interrupt signal. Exiting now!");
        process.exit();
    });
    if (cluster.isPrimary) {
        process.title = `${conf.proc_prefix}-${chain_name}-master`;
        const master = await import('./modules/master.js');
        new master.HyperionMaster().runMaster().catch((err) => {
            console.log(process.env['worker_role']);
            console.log(err);
        });
    }
    else {
        if (hyperionWorkers[env.worker_role] && !conf.disabledWorkers.has(env.worker_role)) {
            process.title = `${conf.proc_prefix}-${chain_name}-${env.worker_role}:${env.worker_id}`;
            const mod = (await import(`./workers/${hyperionWorkers[env.worker_role]}.js`)).default;
            const instance = new mod();
            await instance.run();
        }
    }
}
launch().catch((err) => {
    console.error(err);
});
