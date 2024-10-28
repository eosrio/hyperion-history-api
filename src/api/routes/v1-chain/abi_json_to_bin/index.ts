import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(import.meta.filename),
        'Convert JSON object to binary',
        {
            "code": {$ref: 'AccountName#'},
            "action": {$ref: 'AccountName#'},
            "args": {
                type: 'object',
                additionalProperties: true
            }
        },
        ["code", "action", "args"]
    );
    next();
}
