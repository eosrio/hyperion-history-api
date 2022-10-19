import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(__filename),
        'Retrieves contract code',
        {
            "account_name": {$ref: 'AccountName#'},
            "code_as_wasm": {
                "type": "integer",
                "default": 1,
                "description": "This must be 1 (true)"
            }
        },
        ["account_name", "code_as_wasm"]
    );
    next();
}
