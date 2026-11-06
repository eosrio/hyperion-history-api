import type {MongoClient} from 'mongodb';
import {createMongoDbOperatorListSourceV1, type MongoDbOperatorListReaderV1} from '@eosrio/hyperion-backend-mongodb/operator-lists';
import {negotiateOperatorListsV1, readOperatorListsV1, type OperatorListResultV1} from '@eosrio/hyperion-sdk/operator-lists';
export function configured(client: MongoClient) {
    return createMongoDbOperatorListSourceV1({client, databaseName: 'operator_lists', collectionPrefix: 'configured',
        binding: {chainId: 'a'.repeat(64), backendId: 'mongo', source: 'schemas', generation: 'configuration-v1'},
        limits: {names: 8, items: 4096, bytes: 1048576, attempts: 128}, publicationLimits: {names: 256, items: 100000, bytes: 33554432, attempts: 8192},
        cache: {names: 256, items: 100000, bytes: 33554432}, pageSize: 64, batchDocuments: 64, operationTimeoutMS: 5000, snapshotTimeoutMS: 10000});
}
export async function portable(source: ReturnType<typeof configured>, reader: MongoDbOperatorListReaderV1): Promise<OperatorListResultV1> {
    const selected = negotiateOperatorListsV1({names: 2, items: 32, bytes: 4096, attempts: 16}, source.capabilities, reader.capabilities);
    return readOperatorListsV1(selected, reader, ['schemas', 'missing'], source.binding.source, source.binding.generation, reader.assertCurrent);
}
