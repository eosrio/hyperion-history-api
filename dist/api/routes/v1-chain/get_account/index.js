import { addChainApiRoute, getRouteName } from "../../../helpers/functions.js";
export default function (fastify, opts, next) {
    addChainApiRoute(fastify, getRouteName(__filename), 'Returns an object containing various details about a specific account on the blockchain.', {
        "account_name": { $ref: 'AccountName#' }
    }, ["account_name"]);
    next();
}
