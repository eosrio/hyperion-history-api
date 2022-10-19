import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(__filename),
        'Retrieves the block header state',
        {
            "block_num_or_id": {
                "type": "string",
                "description": "Provide a block_number or a block_id"
            }
        },
        ["block_num_or_id"]
    );
    next();
}
