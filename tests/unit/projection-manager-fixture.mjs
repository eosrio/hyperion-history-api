// Portable-only fixture ports. No controller construction, worker or optional MongoDB client.
import {PortableStateController} from '../../build/indexer/projection/controller.js';
import {StatefulCompleteKindMongoClient} from '../../build/indexer/connections/stateful-complete-kind-client.js';

export function createProjectionManagerFixture(mongodbClient){
 const completeKind=new StatefulCompleteKindMongoClient(
  ()=>{throw new Error('Portable-only fixture must not allocate an optional complete-kind MongoDB client');},
  ()=>{throw new Error('Portable-only fixture must not construct an optional complete-kind MongoDB client');});
 return {conn:{mongodb:{}},mongodbClient,
  statefulCompleteKindMongoClient:operationTimeoutMS=>completeKind.get(operationTimeoutMS),
  closeStatefulCompleteKindMongoClient:()=>completeKind.close()};
}

// Retain the real retry-invalidation method while controlling only original drain/stop I/O.
export function createProjectionControllerFixture({drain,stop}){
 return Object.assign(Object.create(PortableStateController.prototype),{mappingRetries:new Map(),retryEpoch:{},drain,stop});
}
