import { existsSync, readFileSync, writeFileSync } from "fs";
import { HyperionConnections } from "../../interfaces/hyperionConnections.js";
import { HyperionConfig } from "../../interfaces/hyperionConfig.js";
import { getConfigPath, hLog } from "../helpers/common_functions.js";

export interface Filters {
    action_blacklist: Set<string>;
    action_whitelist: Set<string>;
    delta_whitelist: Set<string>;
    delta_blacklist: Set<string>;
}

export class ConfigurationModule {

    public config!: HyperionConfig;
    public connections!: HyperionConnections;
    public EOSIO_ALIAS!: string;

    public filters: Filters = {
        action_blacklist: new Set(),
        action_whitelist: new Set(),
        delta_whitelist: new Set(),
        delta_blacklist: new Set()
    };

    public disabledWorkers = new Set();
    public proc_prefix = 'hyp';

    constructor() {
        this.loadConfigJson();
        this.loadConnectionsJson();
    }

    processConfig() {

        if (!this.config) {
            return;
        }

        if (this.config.settings.process_prefix) {
            this.proc_prefix = this.config.settings.process_prefix;
        }

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

        const normalizeEntryFormat = (entry: string): string => {
            if (entry.includes('::')) {
                const parts = entry.split('::');
                if (parts.length === 3) {
                    return `${parts[1]}::${parts[2]}`;
                }
            }
            return entry;
        }

        // append default blacklists (eosio::onblock & eosio.null)
        // this.filters.action_blacklist.add(`${this.config.settings.chain}::${this.EOSIO_ALIAS}::onblock`);
        this.filters.action_blacklist.add(`${this.EOSIO_ALIAS}.null::*`);

        // append user blacklists
        if (this.config.blacklists) {
            if (this.config.blacklists.actions) {
                this.config.blacklists.actions.forEach((a) => {
                    this.filters.action_blacklist.add(normalizeEntryFormat(a));
                });
            }
            if (this.config.blacklists.deltas) {
                this.config.blacklists.deltas.forEach((d) => {
                    this.filters.delta_blacklist.add(normalizeEntryFormat(d));
                });
            }
        }

        // append user whitelists
        if (this.config.whitelists) {
            if (this.config.whitelists.actions) {
                this.config.whitelists.actions.forEach((a) => {
                    this.filters.action_whitelist.add(normalizeEntryFormat(a));
                });
            }
            if (this.config.whitelists.deltas) {
                this.config.whitelists.deltas.forEach((d) => {
                    this.filters.delta_whitelist.add(normalizeEntryFormat(d));
                });
            }

            if (!this.config.whitelists.root_only) {
                this.config.whitelists.root_only = false;
            }
        }
    }

    loadConfigJson() {
        const configFile = getConfigPath();
        if (configFile) {
            const data = readFileSync(configFile).toString();
            try {
                this.config = JSON.parse(data);
                this.processConfig();
            } catch (e) {
                console.log(`Failed to Load configuration file ${configFile}`);
                console.log(e);
                process.exit(1);
            }
        } else {
            console.error('Configuration file not specified!');
            process.exit(1);
        }
    }

    setAbiScanMode(value: boolean) {
        const configFile = getConfigPath();
        if (configFile && this.config) {
            const data = readFileSync(configFile).toString();
            const tempConfig: HyperionConfig = JSON.parse(data);
            tempConfig.indexer.abi_scan_mode = value;
            writeFileSync(configFile, JSON.stringify(tempConfig, null, 2));
            this.config.indexer.abi_scan_mode = value;
        }
    }

    loadConnectionsJson() {
        const file = './config/connections.json';
        if (existsSync(file)) {
            const data = readFileSync(file).toString();
            try {
                this.connections = JSON.parse(data);
            } catch (e: any) {
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
