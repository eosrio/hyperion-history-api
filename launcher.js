const cluster = require('cluster');
const master = require('./master');
const worker = require('./worker');

(async () => {
    if (cluster.isMaster) {
        master.main().catch((err) => {
            console.log(err);
        });
    } else {
        let delay = 0;
        if (process.env['worker_role'] === 'reader') delay = process.env.READERS * 50;
        // console.log(`New worker [PID: ${process.pid} - WID: ${process.env['worker_id']}] launched, role: ${process.env['worker_role']}`);
        setTimeout(() => {
            worker.main().catch((err) => {
                console.log(err);
            });
        }, delay);
    }
})();
