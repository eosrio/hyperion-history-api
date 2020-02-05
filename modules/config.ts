import {existsSync, readFileSync} from "fs";
import {HyperionConnections} from "../interfaces/hyperionConnections";
import {HyperionConfig} from "../interfaces/hyperionConfig";

export class ConfigurationModule {

    public config: HyperionConfig;
    public connections: HyperionConnections;
    EOSIO_ALIAS: string;

    constructor() {
        this.loadConfigJson();
        this.loadConnectionsJson();
    }

    processConfig() {
        // enforce deltas only for abi scan mode
        if (this.config.indexer.abi_scan_mode) {
            this.config.indexer.fetch_traces = false;
            this.config.indexer.fetch_block = false;
        }

        this.EOSIO_ALIAS = 'eosio';
        if (this.config.settings.eosio_alias) {
            this.EOSIO_ALIAS = this.config.settings.eosio_alias;
        } else {
            this.config.settings.eosio_alias = 'eosio';
        }
    }

    loadConfigJson() {
        if (process.env.CONFIG_JSON) {
            const data = readFileSync(process.env.CONFIG_JSON).toString();
            try {
                this.config = JSON.parse(data);
                this.processConfig();
            } catch (e) {
                console.log(`Failed to Load configuration file ${process.env.CONFIG_JSON}`);
                console.log(e.message);
                process.exit(1);
            }
        } else {
            console.error('Configuration file not specified!');
            process.exit(1);
        }
    }

    loadConnectionsJson() {
        const file = './connections.json';
        if (existsSync(file)) {
            const data = readFileSync(file).toString();
            try {
                this.connections = JSON.parse(data);
            } catch (e) {
                console.log(`Failed to Load ${file}`);
                console.log(e.message);
                process.exit(1);
            }
        } else {
            console.log('connections.json not found!');
            process.exit(1);
        }
    }
}
