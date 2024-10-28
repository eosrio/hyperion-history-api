import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(import.meta.filename),
        'Returns an object containing rows from the specified table.',
        {
            "code": {$ref: 'AccountName#'},
            "action": {$ref: 'AccountName#'},
            "binargs": {"type": "string"}
        },
        ["code", "action", "binargs"]
    );
    next();
}
