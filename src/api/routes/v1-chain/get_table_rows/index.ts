import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(import.meta.filename),
        'Returns an object containing rows from the specified table.',
        {
            "code": {
                "type": "string",
                "description": "The name of the smart contract that controls the provided table"
            },
            "table": {
                "type": "string",
                "description": "The name of the table to query"
            },
            "scope": {
                "type": "string",
                "description": "The account to which this data belongs"
            },
            "index_position": {
                "type": "string",
                "description": "Position of the index used, accepted parameters `primary`, `secondary`, `tertiary`, `fourth`, `fifth`, `sixth`, `seventh`, `eighth`, `ninth` , `tenth`"
            },
            "key_type": {
                "type": "string",
                "description": "Type of key specified by index_position (for example - `uint64_t` or `name`)"
            },
            "encode_type": {
                "type": "string"
            },
            "upper_bound": {
                "type": "string"
            },
            "lower_bound": {
                "type": "string"
            }
        },
        ["code", "table", "scope"]
    );
    next();
}
