import {HyperionAction} from "./hyperion-action.js";

export interface HyperionActionTransform {
    chain: string;
    contract: string;
    action: string;
    defineQueryPrefix: string;
    parser_version: string[];
    handler: (action: HyperionAction) => void
    mappings?: any
}
