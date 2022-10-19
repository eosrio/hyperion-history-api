import { addChainApiRoute, getRouteName } from "../../../helpers/functions.js";
export default function (fastify, opts, next) {
    addChainApiRoute(fastify, getRouteName(__filename), 'Retrieves the current balance', {
        "code": { $ref: 'AccountName#' },
        "account": { $ref: 'AccountName#' },
        "symbol": { $ref: 'Symbol#' }
    }, ["code", "account", "symbol"]);
    next();
}
