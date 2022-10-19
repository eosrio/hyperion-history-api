import { addChainApiRoute, getRouteName } from "../../../helpers/functions.js";
export default function (fastify, opts, next) {
    addChainApiRoute(fastify, getRouteName(__filename), 'Retrieves currency stats', {
        "code": { $ref: 'AccountName#' },
        "symbol": {
            description: 'token symbol',
            type: 'string',
        }
    }, ["code", "symbol"]);
    next();
}
