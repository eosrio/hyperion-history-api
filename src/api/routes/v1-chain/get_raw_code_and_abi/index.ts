import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(import.meta.filename),
        'Retrieves raw code and ABI for a contract based on account name',
        {
            "account_name": {$ref: 'AccountName#'}
        },
        ["account_name"]
    );
    next();
}
