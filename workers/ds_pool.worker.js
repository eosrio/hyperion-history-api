const {checkDebugger} = require("../helpers/functions");
const AbiEos = require('../addons/node-abieos/abieos.node');

class DeserializationWorker {

    abi;
    onReady;

    constructor(onReady) {
        this.onReady = onReady;
    }

    initializeShipAbi(data) {
        console.log(`state history abi ready on ds_worker ${process.env.local_id}`);
        this.abi = JSON.parse(data);
        this.onReady();
    }

    deleteCache(contract) {
        // delete cache contract on abieos context
        const status = AbiEos['delete_contract'](contract);
        if (!status) {
            console.log('Contract not found on cache!');
        }
    }

    onIpcMessage(msg) {
        switch (msg.event) {
            case 'initialize_abi': {
                this.initializeShipAbi(msg.data);
                // abi = JSON.parse(msg.data);
                // abieos['load_abi']("0", msg.data);
                // const initialTypes = Serialize.createInitialTypes();
                // types = Serialize.getTypesFromAbi(initialTypes, abi);
                // abi.tables.map(table => tables.set(table.name, table.type));
                // initConsumer();
                break;
            }
            case 'remove_contract': {
                console.log(`[${process.env.local_id}] Delete contract: ${msg.contract}`);
                this.deleteCache(msg.contract);
            }
        }
    }
}

module.exports = {
    run: async () => {
        checkDebugger();
        console.log(`Standalone deserializer launched with id: ${process.env.local_id}`);
        const dsWorker = new DeserializationWorker(() => {
            process.send({
                event: 'ds_ready',
                id: process.env.local_id
            });
        });
        process.on("message", (msg) => {
            dsWorker.onIpcMessage(msg);
        });
    }
};
