import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next: (err?: Error) => void) {
    addChainApiRoute(
        fastify,
        getRouteName(import.meta.url),
        'Retrieves table scope',
        {
            "code": {
                "type": "string",
                "description": "`name` of the contract to return table data for"
            },
            "table": {
                "type": "string",
                "description": "Filter results by table"
            },
            "lower_bound": {
                "type": "string",
                "description": "Filters results to return the first element that is not less than provided value in set"
            },
            "upper_bound": {
                "type": "string",
                "description": "Filters results to return the first element that is greater than provided value in set"
            },
            "limit": {
                "type": "integer",
                "description": "Limit number of results returned."
            },
            "reverse": {
                "type": "boolean",
                "description": "Reverse the order of returned results"
            }
        },
        ["code"]
    );
    next();
}
