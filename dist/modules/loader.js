import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { hLog } from "../helpers/common_functions.js";
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
export class HyperionModuleLoader {
    cm;
    handledActions = new Map();
    handledDeltas = new Map();
    streamHandlers = [];
    chainMappings = new Map();
    extendedActions = new Set();
    extraMappings = [];
    chainID;
    conn;
    config;
    parser;
    plugins;
    constructor(cm) {
        this.cm = cm;
        this.plugins = [];
        this.conn = cm.connections;
        this.config = cm.config;
        const chain = this.config.settings.chain;
        if (!this.conn.chains[chain]) {
            console.log('Chain  ' + chain + ' not defined on connections.json!');
            process.exit(0);
        }
        this.chainID = this.conn.chains[chain].chain_id;
        this.loadActionHandlers().catch(console.log);
    }
    async loadParser() {
        const path = join(__dirname, 'parsers', this.config.settings.parser + "-parser.js");
        const mod = (await import(path)).default;
        this.parser = new mod(this.cm);
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
    async processDeltaData(delta) {
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
        }
        else {
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
        }
        else {
            const _map = new Map();
            _map.set(deltaModule.table, deltaModule.handler);
            this.handledDeltas.set(deltaModule.contract, _map);
        }
        if (deltaModule.mappings) {
            this.extraMappings.push(deltaModule.mappings);
        }
    }
    async loadActionHandlers() {
        const files = readdirSync('modules/action_data/');
        for (const plugin of files) {
            const _module = (await import(join(__dirname, 'action_data', plugin))).hyperionModule;
            if (_module.parser_version.includes(this.config.settings.parser)) {
                if (_module.chain === this.chainID || _module.chain === '*') {
                    const key = `${_module.contract}::${_module.action}`;
                    if (this.chainMappings.has(key)) {
                        if (this.chainMappings.get(key) === '*' && _module.chain === this.chainID) {
                            this.includeActionModule(_module);
                            this.chainMappings.set(key, _module.chain);
                        }
                    }
                    else {
                        this.includeActionModule(_module);
                        this.chainMappings.set(key, _module.chain);
                    }
                }
            }
        }
    }
    async init() {
        try {
            await this.loadParser();
            await this.loadPlugins();
        }
        catch (e) {
            console.log(e);
            process.exit(1);
        }
    }
    // main loader function for plugin modules
    async loadPlugins() {
        const base = join(__dirname, '..', 'plugins');
        if (!existsSync(base)) {
            return;
        }
        const repos = join(base, 'repos');
        if (!existsSync(repos)) {
            return;
        }
        const state = join(base, '.state.json');
        if (!existsSync(state)) {
            return;
        }
        let pState;
        try {
            const stateFile = JSON.parse(readFileSync(state).toString());
            pState = stateFile.plugins;
        }
        catch (e) {
            hLog('Failed to read plugin state');
            return;
        }
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
                    }
                    catch (e) {
                        hLog(`Plugin "${key}" failed to load: ${e.message}`);
                    }
                }
            }
        }
    }
    appendDynamicContracts(allowedDynamicContracts) {
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
    loadPluginActionHandlers(actionHandlers) {
        for (const handler of actionHandlers) {
            this.includeActionModule(handler);
        }
    }
    loadPluginDeltaHandlers(deltaHandlers) {
        for (const handler of deltaHandlers) {
            this.includeDeltaModule(handler);
        }
    }
    loadPluginStreamHandlers(streamHandlers) {
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
