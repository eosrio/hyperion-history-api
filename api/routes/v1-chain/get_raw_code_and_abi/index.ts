import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(__filename),
        'Retrieves raw code and ABI for a contract based on account name',
        {
            "account_name": {$ref: 'AccountName#'}
        },
        ["account_name"]
    );
    next();
}
