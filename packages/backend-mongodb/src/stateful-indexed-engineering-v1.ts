import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {indexedEngineeringFacadeV1} from './stateful-indexed-engineering-internal.js';
import type {MongoDbStatefulIndexedAdapterV1} from './stateful-indexed-v1.js';
import {requireState} from './stateful-contract.js';

export const MONGODB_INDEXED_ENGINEERING_PROFILE_V1='indexed-schema-sdk49-native2bf-engineering-v1' as const;
/** Explicit engineering opt-in only. No production default or SQL equivalence. */
export function selectMongoDbIndexedEngineeringAssemblyV1(adapter:MongoDbStatefulIndexedAdapterV1,
    profile:typeof MONGODB_INDEXED_ENGINEERING_PROFILE_V1):MongoDbStatefulIndexedAdapterV1 {
    requireState(profile===MONGODB_INDEXED_ENGINEERING_PROFILE_V1,'Explicit indexed engineering assembly required');
    const root=fileURLToPath(new URL('../',import.meta.url)),manifest=JSON.parse(readFileSync(join(root,'INDEXED-ENGINEERING.json'),'utf8'));
    requireState(manifest.schemaVersion===1&&manifest.profile===profile&&manifest.qualificationOnly===true
        &&manifest.sourceBase==='2bf8afdc073c12f750441008513abd5f4b3140d2'
        &&manifest.sdkRevision==='dc20a03f2b60ba05a3369d677222a9cf0d65d299'
        &&manifest.nativeMongoDB==='pending'&&manifest.AtomicSQL==='pending'&&manifest.managedHTTP==='pending','Indexed engineering assembly declaration differs');
    return indexedEngineeringFacadeV1(adapter);
}
