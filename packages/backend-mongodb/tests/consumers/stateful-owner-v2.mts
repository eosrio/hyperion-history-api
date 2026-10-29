import {createMongoDbStatefulOwnerAdapterV2, type MongoDbStatefulOwnerAdapterOptionsV2} from '@eosrio/hyperion-backend-mongodb/stateful-owner-v2';
import type {StatefulOwnerAdapterV2, StatefulOwnerDeclarationV2, StatefulOwnerLeaseV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import type {MongoClient} from 'mongodb';
export async function configuredOwner(client:MongoClient,declaration:StatefulOwnerDeclarationV2):Promise<StatefulOwnerAdapterV2>{
    const options={client,declaration,databaseName:'packed_state_v2',backendId:declaration.projection.definition.binding.backendId,collectionPrefix:'packed',
        receiptRetention:4,rollbackRetentionBlocks:8,rollbackRetentionBytes:4194304,rollbackMaxBlockBytes:1048576,
        operationTimeoutMS:1000,transactionTimeoutMS:2000} satisfies MongoDbStatefulOwnerAdapterOptionsV2;
    if(false){
        // @ts-expect-error v2 has no implicit native profile
        createMongoDbStatefulOwnerAdapterV2({client,declaration});
        // @ts-expect-error owner leases cannot be fabricated from a DTO
        const lease:StatefulOwnerLeaseV2={};void lease;
    }
    return createMongoDbStatefulOwnerAdapterV2(options);
}
