import { existsSync, readFileSync, writeFileSync } from "node:fs";
export class ConfigurationModule {
    config;
    connections;
    EOSIO_ALIAS;
    filters = {
        action_blacklist: new Set(),
        action_whitelist: new Set(),
        delta_whitelist: new Set(),
        delta_blacklist: new Set()
    };
    disabledWorkers = new Set();
    proc_prefix = 'hyp';
    constructor() {
        this.loadConfigJson();
        this.loadConnectionsJson();
    }
    processConfig() {
        if (this.config.settings.process_prefix) {
            this.proc_prefix = this.config.settings.process_prefix;
        }
        if (this.config.indexer.disable_delta_rm) {
            this.disabledWorkers.add('delta_updater');
        }
        // enforce deltas only for abi scan mode
        if (this.config.indexer.abi_scan_mode) {
            this.config.indexer.fetch_traces = false;
            this.config.indexer.fetch_block = false;
        }
        this.EOSIO_ALIAS = 'eosio';
        if (this.config.settings.eosio_alias) {
            this.EOSIO_ALIAS = this.config.settings.eosio_alias;
        }
        else {
            this.config.settings.eosio_alias = 'eosio';
        }
        // append default blacklists (eosio::onblock & eosio.null)
        // this.filters.action_blacklist.add(`${this.config.settings.chain}::${this.EOSIO_ALIAS}::onblock`);
        this.filters.action_blacklist.add(`${this.config.settings.chain}::${this.EOSIO_ALIAS}.null::*`);
        // this.filters.delta_blacklist.add(`${this.config.settings.chain}::${this.EOSIO_ALIAS}::global`);
        // this.filters.delta_blacklist.add(`${this.config.settings.chain}::${this.EOSIO_ALIAS}::global2`);
        // this.filters.delta_blacklist.add(`${this.config.settings.chain}::${this.EOSIO_ALIAS}::global3`);
        // append user blacklists
        if (this.config.blacklists) {
            if (this.config.blacklists.actions) {
                this.config.blacklists.actions.forEach((a) => {
                    this.filters.action_blacklist.add(a);
                });
            }
            if (this.config.blacklists.deltas) {
                this.config.blacklists.deltas.forEach((d) => {
                    this.filters.delta_blacklist.add(d);
                });
            }
        }
        // append user whitelists
        if (this.config.whitelists) {
            if (this.config.whitelists.actions) {
                this.config.whitelists.actions.forEach((a) => {
                    this.filters.action_whitelist.add(a);
                });
            }
            if (this.config.whitelists.deltas) {
                this.config.whitelists.deltas.forEach((d) => {
                    this.filters.delta_whitelist.add(d);
                });
            }
            if (!this.config.whitelists.root_only) {
                this.config.whitelists.root_only = false;
            }
        }
    }
    loadConfigJson() {
        if (process.env.CONFIG_JSON) {
            const data = readFileSync(process.env.CONFIG_JSON).toString();
            try {
                this.config = JSON.parse(data);
                this.processConfig();
            }
            catch (e) {
                console.log(`Failed to Load configuration file ${process.env.CONFIG_JSON}`);
                console.log(e);
                process.exit(1);
            }
        }
        else {
            console.error('Configuration file not specified!');
            process.exit(1);
        }
    }
    setAbiScanMode(value) {
        const data = readFileSync(process.env.CONFIG_JSON).toString();
        const tempConfig = JSON.parse(data);
        tempConfig.indexer.abi_scan_mode = value;
        writeFileSync(process.env.CONFIG_JSON, JSON.stringify(tempConfig, null, 2));
        this.config.indexer.abi_scan_mode = value;
    }
    loadConnectionsJson() {
        const file = './connections.json';
        if (existsSync(file)) {
            const data = readFileSync(file).toString();
            try {
                this.connections = JSON.parse(data);
            }
            catch (e) {
                console.log(`Failed to Load ${file}`);
                console.log(e.message);
                process.exit(1);
            }
        }
        else {
            console.log('connections.json not found!');
            process.exit(1);
        }
    }
}
