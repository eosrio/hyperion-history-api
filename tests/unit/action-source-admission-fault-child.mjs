/** Constructed guard-only fixture. This is not a production worker or a native replay. */
import {readActionSourceCrashControl, deliberatelyExitActionSource} from '../../scripts/qualification/action-source-admission-fault.mjs';
const control = readActionSourceCrashControl(process.argv[2], {observerDirectory: process.env.ES198_OBSERVER_DIR,
    chain: process.env.CHAIN_NAME, configFile: process.env.CONFIG_JSON});
const result = deliberatelyExitActionSource(control, 'before-fragment', {schemaVersion: 1, pid: process.pid, parentPid: process.ppid,
    role: 'ds_pool_worker', workerId: 'guard-fixture', chain: control.chain, source: {chainId: control.sourceChainId},
    roots: ['1'], fragmentId: null, fixtureLevel: 'constructed-guard-only'});
console.log(JSON.stringify({oneShotSkipped: result === false}));
