import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(__filename),
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
