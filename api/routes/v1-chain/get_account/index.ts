import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(__filename),
        'Returns an object containing various details about a specific account on the blockchain.',
        {"account_name": 'AccountName#'},
        ["account_name"]
    );
    next();
}
