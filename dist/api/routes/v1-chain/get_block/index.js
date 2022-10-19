import { addChainApiRoute, getRouteName } from "../../../helpers/functions.js";
export default function (fastify, opts, next) {
    addChainApiRoute(fastify, getRouteName(__filename), 'Returns an object containing various details about a specific block on the blockchain.', {
        "block_num_or_id": {
            description: "Provide a `block number` or a `block id`",
            type: 'string'
        }
    }, ["block_num_or_id"]);
    next();
}
