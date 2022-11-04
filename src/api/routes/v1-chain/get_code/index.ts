import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(import.meta.url),
        'Retrieves contract code',
        {
            "account_name": {$ref: 'AccountName#'},
            code_as_wasm: {type: 'integer'}
        },
        ["account_name", "code_as_wasm"]
    );
    next();
}
