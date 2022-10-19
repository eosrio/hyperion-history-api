import { addChainApiRoute, getRouteName } from "../../../helpers/functions.js";
export default function (fastify, opts, next) {
    addChainApiRoute(fastify, getRouteName(__filename), 'Retrieves producers list', {
        "limit": {
            "type": "string",
            "description": "total number of producers to retrieve"
        },
        "lower_bound": {
            "type": "string",
            "description": "In conjunction with limit can be used to paginate through the results. For example, limit=10 and lower_bound=10 would be page 2"
        },
        "json": {
            "type": "boolean",
            "description": "return result in JSON format"
        }
    });
    next();
}
