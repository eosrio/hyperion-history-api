import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(__filename),
        'Returns an object containing rows from the specified table.',
        {
            "code": {$ref: 'AccountName#'},
            "action": {$ref: 'AccountName#'},
            "binargs": {
                "type": "string",
                "pattern": "^(0x)(([0-9a-f][0-9a-f])+)?$",
                "title": "Hex"
            }
        },
        ["code", "action", "binargs"]
    );
    next();
}
