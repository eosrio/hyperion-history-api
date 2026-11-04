// Portable-only worker fixture port. The real lazy pool never creates a MongoDB client here.
import {StatefulCompleteKindMongoClient} from '../../build/indexer/connections/stateful-complete-kind-client.js';

export function createProjectionManagerFixture(mongodbClient){
 const completeKind=new StatefulCompleteKindMongoClient(
  ()=>{throw new Error('Portable-only fixture must not allocate an optional complete-kind MongoDB client');},
  ()=>{throw new Error('Portable-only fixture must not construct an optional complete-kind MongoDB client');});
 return {conn:{mongodb:{}},mongodbClient,
  statefulCompleteKindMongoClient:operationTimeoutMS=>completeKind.get(operationTimeoutMS),
  closeStatefulCompleteKindMongoClient:()=>completeKind.close()};
}
