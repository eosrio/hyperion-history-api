import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {indexedEngineeringFacadeV1} from './stateful-indexed-engineering-internal.js';
import type {MongoDbStatefulIndexedAdapterV1} from './stateful-indexed-v1.js';
import {requireState} from './stateful-contract.js';

export const MONGODB_ROYALTY_ENGINEERING_PROFILE_V1='indexed-royalty-sdk-cbfb-native-cf514-engineering-v1' as const;
/** Separate qualification-only authority; historical SDK49 selector remains unchanged. */
export function selectMongoDbRoyaltyEngineeringAssemblyV1(adapter:MongoDbStatefulIndexedAdapterV1,
 profile:typeof MONGODB_ROYALTY_ENGINEERING_PROFILE_V1):MongoDbStatefulIndexedAdapterV1 {
 requireState(profile===MONGODB_ROYALTY_ENGINEERING_PROFILE_V1,'Explicit royalty engineering assembly required');
 const root=fileURLToPath(new URL('../',import.meta.url)),manifest=JSON.parse(readFileSync(join(root,'ROYALTY-ENGINEERING.json'),'utf8'));
 requireState(manifest.schemaVersion===1&&manifest.profile===profile&&manifest.qualificationOnly===true
  &&manifest.sourceBase==='cf514f1b1b8ed6d7d2d75af2d50bc128bca29eec'&&manifest.sdkRevision==='cbfb26694b90b52266d1e0b9b5dbf6f8389e736b'
  &&manifest.nativeMongoDB==='pending'&&manifest.AtomicSQL==='pending'&&manifest.managedHTTP==='pending','Royalty engineering declaration differs');
 return indexedEngineeringFacadeV1(adapter);
}
