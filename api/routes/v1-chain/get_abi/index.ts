import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(__filename),
        'Retrieves the ABI for a contract based on its account name',
        {"account_name": 'AccountName#'},
        ["account_name"]
    );
    next();
}
