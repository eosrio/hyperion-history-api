import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    addChainApiRoute(
        fastify,
        getRouteName(import.meta.filename),
        'Returns an object containing various details about a specific account on the blockchain.',
        {
            "account_name": {$ref: 'AccountName#'}
        },
        ["account_name"]
    );
    next();
}
