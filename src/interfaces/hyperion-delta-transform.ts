import {HyperionAction} from "./hyperion-action.js";

export interface HyperionDeltaTransform {
    chain: string;
    contract: string;
    table: string;
    defineQueryPrefix: string;
    parser_version: string[];
    handler: (action: HyperionAction) => void
    mappings?: any
}
