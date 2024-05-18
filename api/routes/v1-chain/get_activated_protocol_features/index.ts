import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(__filename),
        'Retrieves the activated protocol features for producer node',
        {
            "lower_bound": {
                "type": "integer",
                "description": "Lower bound"
            },
            "upper_bound": {
                "type": "integer",
                "description": "Upper bound"
            },
            "limit": {
                "type": "integer",
                "description": "The limit, default is 10"
            },
            "search_by_block_num": {
                "type": "boolean",
                "description": "Flag to indicate it is has to search by block number"
            },
            "reverse": {
                "type": "boolean",
                "description": "Flag to indicate it has to search in reverse"
            }
        }
    );
    next();
}
