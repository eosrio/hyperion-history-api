import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next: (err?: Error) => void) {
    addChainApiRoute(
        fastify,
        getRouteName(import.meta.url),
        'Retrieves currency stats',
        {
            "code": {$ref: 'AccountName#'},
            "symbol": {
                description: 'token symbol',
                type: 'string',
            }
        },
        ["code", "symbol"]
    );
    next();
}
