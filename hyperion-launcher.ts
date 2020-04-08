import * as cluster from "cluster";
import {ConfigurationModule} from "./modules/config";
import {HyperionWorker} from "./workers/hyperionWorker";
import {hLog, messageAllWorkers} from "./helpers/common_functions";
import * as pm2io from "@pm2/io";
import * as v8 from "v8";

interface WorkerEnv {
    worker_role: string;
    worker_id: string;
}

const hyperionWorkers = {
    ds_pool_worker: 'ds-pool',
    reader: 'state-reader',
    deserializer: 'deserializer',
    continuous_reader: 'state-reader',
    ingestor: 'indexer',
    router: 'ws-router'
};

export async function launch() {
    const conf = new ConfigurationModule();
    const chain_name = conf.config.settings.chain;
    const env: WorkerEnv = {
        worker_id: process.env.worker_id,
        worker_role: process.env.worker_role
    };

    process.on('SIGINT', function () {
        hLog("caught interrupt signal. Exiting now!");
        process.exit();
    });

    if (cluster.isMaster) {
        process.title = `hyp-${chain_name}-master`;
        const master = await import('./modules/master');
        new master.HyperionMaster().runMaster().catch((err) => {
            console.log(process.env['worker_role']);
            console.log(err);
        });
    } else {
        if (hyperionWorkers[env.worker_role]) {
            process.title = `hyp-${chain_name}-${env.worker_role}:${env.worker_id}`;
            const mod = (await import(`./workers/${hyperionWorkers[env.worker_role]}`)).default;
            const instance = new mod() as HyperionWorker;
            await instance.run();
        } else {
            console.log(`FATAL: Unlisted Worker: ${env.worker_role}`);
        }
    }
}
