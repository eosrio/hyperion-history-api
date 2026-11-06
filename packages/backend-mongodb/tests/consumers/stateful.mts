import {createMongoDbStatefulAdapter,type MongoDbStatefulAdapterOptions} from '@eosrio/hyperion-backend-mongodb/stateful';
import type {StatefulAdapter,StatefulDeclaration} from '@eosrio/hyperion-sdk/projection-stateful';
import type {MongoClient} from 'mongodb';
export async function configured(client:MongoClient,declaration:StatefulDeclaration):Promise<StatefulAdapter>{
    const options={client,declaration,databaseName:'packed_state',backendId:declaration.definition.binding.backendId,collectionPrefix:'packed',
        receiptRetention:4,rollbackRetentionBlocks:8,rollbackRetentionBytes:4194304,rollbackMaxBlockBytes:1048576,
        operationTimeoutMS:1000,transactionTimeoutMS:2000} satisfies MongoDbStatefulAdapterOptions;
    if(false){
        // @ts-expect-error No implicit operation/deadline/resource profile may be selected.
        createMongoDbStatefulAdapter({client,declaration});
    }
    return createMongoDbStatefulAdapter(options);
}
