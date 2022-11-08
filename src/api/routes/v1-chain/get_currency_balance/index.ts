import {FastifyInstance} from "fastify";
import {addChainApiRoute, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next: (err?: Error) => void) {
    addChainApiRoute(
        fastify,
        getRouteName(import.meta.url),
        'Retrieves the current balance',
        {
            "code": {$ref: 'AccountName#'},
            "account": {$ref: 'AccountName#'},
            "symbol": {$ref: 'Symbol#'}
        },
        ["code", "account", "symbol"]
    );
    next();
}
