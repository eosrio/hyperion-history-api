import type {MongoClient} from 'mongodb';
import type {ProjectionRecoveryAdapter} from '@eosrio/hyperion-sdk/projection';
import {createMongoDbRecoveryAdapter} from '@eosrio/hyperion-backend-mongodb';
import type {ResolvedPortableStateConfiguration} from './config.js';

/** The host owns the client. Creating an adapter performs no initialization or readiness publication. */
export function createPortableStateBackend(client: MongoClient, configuration: ResolvedPortableStateConfiguration): ProjectionRecoveryAdapter {
    return createMongoDbRecoveryAdapter({client, backendId: configuration.backend.id, databaseName: configuration.backend.database});
}
