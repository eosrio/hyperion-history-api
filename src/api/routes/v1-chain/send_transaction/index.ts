import {FastifyInstance} from "fastify";
import {addApiRoute, chainApiHandler, getRouteName} from "../../../helpers/functions.js";

export default function (fastify: FastifyInstance, opts: any, next) {
    addApiRoute(
        fastify,
        'POST',
        getRouteName(import.meta.filename),
        chainApiHandler,
        {
            description: "This method expects a transaction in JSON format and will attempt to apply it to the blockchain.",
            summary: "This method expects a transaction in JSON format and will attempt to apply it to the blockchain.",
            tags: ['chain'],
            body: {
                type: ['object', 'string'],
                properties: {
                    signatures: {
                        "type": "array",
                        "description": "array of signatures required to authorize transaction",
                        "items": {$ref: 'Signature#'}
                    },
                    compression: {
                        "type": "boolean",
                        "description": "Compression used, usually false"
                    },
                    packed_context_free_data: {
                        "type": "string",
                        "description": "json to hex"
                    },
                    packed_trx: {
                        "type": "string",
                        "description": "Transaction object json to hex"
                    }
                }
            }
        }
    );
    next();
}
