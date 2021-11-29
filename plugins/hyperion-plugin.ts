import {FastifyInstance} from "fastify";
import {HyperionAction} from "../interfaces/hyperion-action";
import {HyperionDelta} from "../interfaces/hyperion-delta";


interface HyperionActionHandler {
    action: string;
    contract: string;
    mappings?: any;
    handler: (action: HyperionAction) => Promise<void>;
}

interface HyperionDeltaHandler {
    table: string;
    contract: string;
    mappings?: any;
    handler: (delta: HyperionDelta) => Promise<void>;
}

interface HyperionStreamEvent {

}

export interface HyperionStreamHandler {
    event: string;
    code?: string;
    account?: string;
    name?: string;
    table?: string;
    handler: (streamEvent: any) => Promise<void>;
}

export abstract class HyperionPlugin {
    internalPluginName: string = '';
    indexerPlugin: boolean;
    apiPlugin: boolean;
    actionHandlers: HyperionActionHandler[] = [];
    deltaHandlers: HyperionDeltaHandler[] = [];
    streamHandlers: HyperionStreamHandler[] = [];
    dynamicContracts: string[] = [];
    hasApiRoutes: boolean = false;
    baseConfig: any;
    chainName: string = '';

    protected constructor(config?: any) {
        if (config) {
            this.baseConfig = config;
        }
    }

    abstract addRoutes(server: FastifyInstance): void;

    // abstract processActionData(input: any): Promise<any>;
    initOnce() {
        // called only once
    }

    initHandlerMap(): any {
        return {};
    }
}
