import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(__filename),
        'Retrieves currency stats',
        {
            "code": {
                description: 'contract name',
                type: 'string',
                minLength: 1,
                maxLength: 12
            },
            "symbol": {
                description: 'token symbol',
                type: 'string',
            }
        },
        ["code", "symbol"]
    );
    next();
}
