import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(__filename),
        'Retrieves the scheduled transaction',
        {
            "lower_bound": {
                "type": "string",
                "description": "Date/time string in the format YYYY-MM-DDTHH:MM:SS.sss",
                "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}.[0-9]{3}$",
                "title": "DateTimeSeconds"
            },
            "limit": {
                "description": "The maximum number of transactions to return",
                "type": "integer"
            },
            "json": {
                "description": "true/false whether the packed transaction is converted to json",
                "type": "boolean"
            }
        }
    );
    next();
}
