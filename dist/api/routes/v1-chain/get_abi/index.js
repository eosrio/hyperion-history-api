import { addChainApiRoute, getRouteName } from "../../../helpers/functions.js";
export default function (fastify, opts, next) {
    addChainApiRoute(fastify, getRouteName(__filename), 'Retrieves the ABI for a contract based on its account name', { "account_name": { $ref: 'AccountName#' } }, ["account_name"]);
    next();
}
