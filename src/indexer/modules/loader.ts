import {ConfigurationModule} from "./config.js";
import path, {join} from "path";
import {existsSync, readdirSync, readFileSync} from "fs";
import {HyperionConnections} from "../../interfaces/hyperionConnections.js";
import {HyperionConfig} from "../../interfaces/hyperionConfig.js";
import {BaseParser} from "./parsers/base-parser.js";
import {hLog} from "../helpers/common_functions.js";
import {HyperionPlugin, HyperionStreamHandler} from "../../plugins/hyperion-plugin.js";

export class HyperionModuleLoader {

    private handledActions = new Map();
    private handledDeltas = new Map();
    private streamHandlers: HyperionStreamHandler[] = [];

    chainMappings = new Map();
    extendedActions: Set<string> = new Set();
    extraMappings: any[] = [];
    chainID;
    private conn: HyperionConnections;
    private config: HyperionConfig;
    public parser?: BaseParser;
    public plugins: HyperionPlugin[];

    constructor(private cm: ConfigurationModule) {
        this.plugins = [];
        this.conn = cm.connections;
        this.config = cm.config;
        if (!this.conn.chains[this.config.settings.chain]) {
            console.log('Chain  ' + this.config.settings.chain + ' not defined on connections.json!');
            process.exit(0);
        }
        this.chainID = this.conn.chains[this.config.settings.chain].chain_id;
        this.loadActionHandlers();
    }

    async loadParser() {
        const path = join(import.meta.dirname, 'parsers', this.config.settings.parser + "-parser.js");
        const mod = (await import(path)).default;
        this.parser = new mod(this.cm) as BaseParser;
    }

    processActionData(action) {
        const wildcard = this.handledActions.get('*');
        if (wildcard && wildcard.has(action.act.name)) {
            wildcard.get(action.act.name)(action);
        }
        if (this.handledActions && this.handledActions.has(action.act.account)) {
            const _c = this.handledActions.get(action.act.account);
            if (_c.has(action.act.name)) {
                _c.get(action.act.name)(action);
            }
        }
    }

    async processDeltaData(delta): Promise<void> {
        if (this.handledDeltas.has(delta.code)) {
            const _c = this.handledDeltas.get(delta.code);
            if (_c.has(delta.table)) {
                await _c.get(delta.table)(delta);
            }
        }
    }


    includeActionModule(_module) {
        if (this.handledActions.has(_module.contract)) {
            const existing = this.handledActions.get(_module.contract);
            existing.set(_module.action, _module.handler);
        } else {
            const _map = new Map();
            _map.set(_module.action, _module.handler);
            this.handledActions.set(_module.contract, _map);
        }
        if (_module.mappings) {
            this.extraMappings.push(_module.mappings);
        }
        if (_module.defineQueryPrefix) {
            this.extendedActions.add(_module.defineQueryPrefix);
        }
    }

    includeDeltaModule(deltaModule) {
        if (this.handledDeltas.has(deltaModule.contract)) {
            const existing = this.handledDeltas.get(deltaModule.contract);
            existing.set(deltaModule.table, deltaModule.handler);
        } else {
            const _map = new Map();
            _map.set(deltaModule.table, deltaModule.handler);
            this.handledDeltas.set(deltaModule.contract, _map);
        }
        if (deltaModule.mappings) {
            this.extraMappings.push(deltaModule.mappings);
        }
    }

    loadActionHandlers() {
        const actionDataPath = path.join(import.meta.dirname, 'action_data');
        const files = readdirSync(actionDataPath);
        for (const plugin of files.filter(f => f.endsWith('.js'))) {
            import(join(actionDataPath, plugin)).then(value => {
                const _module = value.hyperionModule;
                if (_module.parser_version.includes(this.config.settings.parser)) {
                    if (_module.chain === this.chainID || _module.chain === '*') {
                        const key = `${_module.contract}::${_module.action}`;
                        if (this.chainMappings.has(key)) {
                            if (this.chainMappings.get(key) === '*' && _module.chain === this.chainID) {
                                this.includeActionModule(_module);
                                this.chainMappings.set(key, _module.chain);
                            }
                        } else {
                            this.includeActionModule(_module);
                            this.chainMappings.set(key, _module.chain);
                        }
                    }
                }
            }).catch(reason => {
                console.log(`Error loading action module: ${reason}`);
            });
        }
    }

    async init() {
        try {
            await this.loadParser();
            await this.loadPlugins();
        } catch (e) {
            console.log(e);
            process.exit(1);
        }
    }

    // main loader function for plugin modules
    private async loadPlugins() {
        const base = join(import.meta.dirname, '../../', 'plugins');
        if (!existsSync(base)) {
            // console.error('Plugin folder not found');
            return;
        }
        const repos = join(base, 'repos');
        if (!existsSync(repos)) {
            // console.error('Plugin repo folder not found at ' + repos);
            return;
        }
        const state = join(base, '.state.json');
        if (!existsSync(state)) {
            // console.error('Plugin state file not found');
            return;
        }


        let pState;
        try {
            const stateFile = JSON.parse(readFileSync(state).toString());
            pState = stateFile.plugins;
        } catch (e) {
            hLog('Failed to read plugin state');
            return;
        }

        console.log(JSON.stringify(pState, null, 2));

        for (const key in this.config.plugins) {
            if (this.config.plugins.hasOwnProperty(key)) {
                if (pState[key] && pState[key].enabled && this.config.plugins[key].enabled) {
                    try {
                        const pMod = (await import(join(repos, key))).default;
                        const pl = new pMod(this.config.plugins[key]);
                        if (pl.actionHandlers) {
                            this.loadPluginActionHandlers(pl.actionHandlers);
                        }
                        if (pl.deltaHandlers) {
                            this.loadPluginDeltaHandlers(pl.deltaHandlers);
                        }
                        if (pl.streamHandlers) {
                            this.loadPluginStreamHandlers(pl.streamHandlers);
                        }
                        this.plugins.push(pl);
                    } catch (e: any) {
                        hLog(`Plugin "${key}" failed to load: ${e.message}`);
                    }
                }
            }
        }
    }

    appendDynamicContracts(allowedDynamicContracts: Set<string>) {
        for (const plugin of this.plugins) {
            if (plugin.dynamicContracts) {
                if (plugin.dynamicContracts.length > 0) {
                    plugin.dynamicContracts.forEach(value => {
                        allowedDynamicContracts.add(value);
                    });
                }
            }
        }
    }


    private loadPluginActionHandlers(actionHandlers: any) {
        for (const handler of actionHandlers) {
            this.includeActionModule(handler);
        }
    }

    private loadPluginDeltaHandlers(deltaHandlers: any) {
        for (const handler of deltaHandlers) {
            this.includeDeltaModule(handler);
        }
    }

    private loadPluginStreamHandlers(streamHandlers: any) {
        for (const handler of streamHandlers) {
            this.includeStreamModule(handler);
        }
    }

    includeStreamModule(_module) {
        this.streamHandlers.push(_module);
    }

    processStreamEvent(msg) {
        if (this.streamHandlers.length > 0) {
            this.streamHandlers.forEach(sth => {
                sth.handler(msg).catch(reason => {
                    hLog(`Stream processing failed:`, reason);
                });
            });
        }
    }
}
