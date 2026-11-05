import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {indexedEngineeringFacadeV1} from './stateful-indexed-engineering-internal.js';
import type {MongoDbStatefulIndexedAdapterV1} from './stateful-indexed-v1.js';
import {requireState} from './stateful-contract.js';

export const MONGODB_LINEAR_HISTORY_ENGINEERING_PROFILE_V1='indexed-linear-history-sdk-cbfb-native-1825-engineering-v1' as const;
const sdkPin='git+https://github.com/eosrio/hyperion-sdk.git#cbfb26694b90b52266d1e0b9b5dbf6f8389e736b';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function inventory(root:string) {
 const files:{path:string;bytes:number;sha256:string}[]=[];let total=0;
 const visit=(directory:string)=>{for(const name of readdirSync(directory).sort()){
  const path=join(directory,name),stat=lstatSync(path);requireState(!stat.isSymbolicLink(),'Engineering assembly refuses symlinks');
  if(stat.isDirectory())visit(path);else{requireState(stat.isFile()&&files.length<1024&&(total+=stat.size)<=64*1024*1024,'Engineering assembly file bound');
   const bytes=readFileSync(path);requireState(bytes.length===stat.size,'Engineering assembly changed while reading');
   files.push({path:relative(root,path).replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)});
  }
 }};visit(root);return files;
}
/** Separate exact-byte, qualification-only authority; historical SDK49 selector remains unchanged. */
export function selectMongoDbLinearHistoryEngineeringAssemblyV1(adapter:MongoDbStatefulIndexedAdapterV1,
 profile:typeof MONGODB_LINEAR_HISTORY_ENGINEERING_PROFILE_V1):MongoDbStatefulIndexedAdapterV1 {
 requireState(profile===MONGODB_LINEAR_HISTORY_ENGINEERING_PROFILE_V1,'Explicit linear history engineering assembly required');
 const root=fileURLToPath(new URL('../',import.meta.url)),manifest=JSON.parse(readFileSync(join(root,'LINEAR-HISTORY-ENGINEERING.json'),'utf8'));
 requireState(manifest.schemaVersion===1&&manifest.profile===profile&&manifest.qualificationOnly===true
  &&manifest.sourceBase==='1825f951b5153805009bde52bea80ec798f6bfa8'&&manifest.sdkRevision==='cbfb26694b90b52266d1e0b9b5dbf6f8389e736b'
  &&manifest.nativeMongoDB==='pending'&&manifest.AtomicSQL==='pending'&&manifest.managedHTTP==='pending','Linear history engineering declaration differs');
 const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
 requireState(pkg.devDependencies['@eosrio/hyperion-sdk']===sdkPin&&pkg.dependencies.mongodb==='7.2.0','Linear history engineering source pins differ');
 requireState(JSON.stringify(inventory(join(root,'dist')))===JSON.stringify(manifest.nativeDist),'Linear history engineering native emissions differ');
 const sdkRoot=dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-sdk'))));
 requireState(JSON.stringify(inventory(join(sdkRoot,'dist')))===JSON.stringify(manifest.sdkDist),'Linear history engineering SDK emissions differ');
 return indexedEngineeringFacadeV1(adapter);
}
