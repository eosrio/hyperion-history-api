// Manager fixture ports. No controller construction, worker or optional MongoDB client.
import {StatefulCompleteKindMongoClient} from '../../build/indexer/connections/stateful-complete-kind-client.js';

export function createProjectionManagerFixture(mongodbClient){
 const completeKind=new StatefulCompleteKindMongoClient(
  ()=>{throw new Error('Manager fixture must not allocate an optional complete-kind MongoDB client');},
  ()=>{throw new Error('Manager fixture must not construct an optional complete-kind MongoDB client');});
 return {conn:{mongodb:{}},mongodbClient,
  statefulCompleteKindMongoClient:operationTimeoutMS=>completeKind.get(operationTimeoutMS),
  closeStatefulCompleteKindMongoClient:()=>completeKind.close()};
}
