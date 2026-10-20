import type {MongoClient} from 'mongodb';
import type {ProjectionAdapter} from '@eosrio/hyperion-sdk/projection';
import {createMongoDbProjectionAdapter} from '@eosrio/hyperion-backend-mongodb';
import type {ResolvedPortableStateConfiguration} from './config.js';

/** The host owns the client. Creating an adapter performs no initialization or readiness publication. */
export function createPortableStateBackend(client: MongoClient, configuration: ResolvedPortableStateConfiguration): ProjectionAdapter {
    return createMongoDbProjectionAdapter({client, backendId: configuration.backend.id, databaseName: configuration.backend.database});
}
