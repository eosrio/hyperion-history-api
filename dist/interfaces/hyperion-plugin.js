export class HyperionPlugin {
    internalPluginName = '';
    indexerPlugin;
    apiPlugin;
    actionHandlers = [];
    deltaHandlers = [];
    streamHandlers = [];
    dynamicContracts = [];
    hasApiRoutes = false;
    baseConfig;
    chainName = '';
    constructor(config) {
        if (config) {
            this.baseConfig = config;
        }
    }
    // abstract processActionData(input: any): Promise<any>;
    initOnce() {
        // called only once
    }
    initHandlerMap() {
        return {};
    }
}
