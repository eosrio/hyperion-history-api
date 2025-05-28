import cluster from "cluster";
import { ConfigurationModule } from "./modules/config.js";
import { HyperionWorker } from "./workers/hyperionWorker.js";
import { hLog } from "./helpers/common_functions.js";

import 'dotenv/config';

interface WorkerEnv {
	worker_role: string;
	worker_id: string;
}

const hyperionWorkers = {
	ds_pool_worker: 'ds-pool',
	reader: 'state-reader',
	deserializer: 'deserializer',
	continuous_reader: 'state-reader',
	repair_reader: 'state-reader',
	ingestor: 'indexer',
	router: 'ws-router',
	delta_updater: 'delta-updater'
};

async function launch() {
	const conf = new ConfigurationModule();

	if (!conf.config) {
		hLog("Configuration not found! Exiting now!");
		process.exit();
	}

	const chain_name = conf.config.settings.chain;
	process.on('SIGINT', function () {
		hLog("caught interrupt signal. Exiting now!");
		process.exit();
	});

	if (cluster.isPrimary) {

		process.title = `${conf.proc_prefix}-${chain_name}-master`;
		const master = await import('./modules/master.js');
		const instance = new master.HyperionMaster();
		try {
			await instance.runMaster();
		} catch (err) {
			console.error("Error running master:", err);
		}

	} else {

		const env: WorkerEnv = {
			worker_id: process.env.worker_id ?? "",
			worker_role: process.env.worker_role ?? ""
		};

		if (hyperionWorkers[env.worker_role] && !conf.disabledWorkers.has(env.worker_role)) {
			process.title = `${conf.proc_prefix}-${chain_name}-${env.worker_role}:${env.worker_id}`;
			const mod = (await import(`./workers/${hyperionWorkers[env.worker_role]}.js`)).default;
			const instance = new mod() as HyperionWorker;
			try {
				await instance.run();
			} catch (error) {
				console.error(`Error running worker ${env.worker_role} (${env.worker_id}):`, error);
			}

		}
	}
}

launch().catch((err) => {
	console.error(err);
});
