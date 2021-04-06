"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HyperionPlugin = void 0;
class HyperionPlugin {
    constructor(config) {
        this.actionHandlers = [];
        this.deltaHandlers = [];
        this.dynamicContracts = [];
        this.hasApiRoutes = false;
        this.chainName = '';
        if (config) {
            this.baseConfig = config;
        }
    }
}
exports.HyperionPlugin = HyperionPlugin;
//# sourceMappingURL=hyperion-plugin.js.map