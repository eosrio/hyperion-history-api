// Explicit SDK49 source admission; no database, child, service or lifecycle operations.
import assert from 'node:assert/strict';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {findPackageJSON} from 'node:module';
import {admitIndexedAssembly,ASSEMBLY,inventory} from '../../scripts/qualification/indexed-schema-mongodb/assembly.mjs';
import {sha} from '../../scripts/qualification/operator-list-mongodb/contract.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const expectedRaw=readFileSync(new URL('../fixtures/engineering-profiles/sdk49-indexed-linux.json',import.meta.url));
assert.equal(sha(expectedRaw),'a7e0f2f6e119d70d8120e2041d5314299c96f0bc4b55ee5c10b4597b9c4b44f3','Exact SDK49 manifest required');
const expected=JSON.parse(expectedRaw);
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
// Declarative metadata only; native/runtime admission still performs the independent observation below.
export const SDK49_SOURCE_MANIFEST=freeze(expected);
export const STATEFUL_SDK49_SOURCE_PROFILE='stateful-sdk49-indexed-2da-linux-engineering-v1';
const exact=(value,pin,label)=>assert.deepEqual(value,pin,'Unqualified SDK49 '+label);
const read=path=>{const stat=lstatSync(path);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4*1024*1024);const data=readFileSync(path);assert.equal(data.length,stat.size);return data;};
const json=path=>JSON.parse(read(path));
function local(base,name){const directory=join(base,'node_modules',name);exact(findPackageJSON(name,pathToFileURL(join(base,'package.json'))),join(directory,'package.json'),'local '+name);assert(lstatSync(directory).isDirectory()&&!lstatSync(directory).isSymbolicLink());return directory;}
function members(directory,manifest){
 assert(Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=512);const seen=new Set();let total=0;directory=realpathSync(directory);
 for(const row of manifest.files){assert(typeof row.path==='string'&&!isAbsolute(row.path)&&!row.path.includes('\\')&&!seen.has(row.path));seen.add(row.path);
  const candidate=resolve(directory,row.path),actual=realpathSync(candidate),inner=relative(directory,actual);assert(inner&&inner!=='..'&&!inner.startsWith('../')&&!inner.startsWith('..\\')&&!isAbsolute(inner));
  assert(!lstatSync(candidate).isSymbolicLink());const data=read(actual);total+=data.length;assert(total<=64*1024*1024);exact(sha(data),row.sha256,'Wire member');}
}
export function assertSdk49Options(input={}){
 assert(input&&Object.getPrototypeOf(input)===Object.prototype&&!Object.getOwnPropertySymbols(input).length);const properties=Object.getOwnPropertyDescriptors(input);
 assert(Object.entries(properties).every(([key,value])=>['nativeMarker','engineeringSourceProfile'].includes(key)&&value.enumerable&&Object.hasOwn(value,'value')));
 const nativeMarker=properties.nativeMarker?.value??true;assert.equal(typeof nativeMarker,'boolean');exact(properties.engineeringSourceProfile?.value,STATEFUL_SDK49_SOURCE_PROFILE,'profile');return {nativeMarker};
}
// Inert observation checker is not an admission grant; the real caller captures every byte independently.
export function assertSdk49Dependencies(observed){exact(observed,expected.dependencies,'scoped MongoDB/BSON packages');}
export function assertSdk49Runtime(runtime){
 exact(runtime.platform,'linux','runtime platform');exact(runtime.arch,'x64','runtime architecture');assert.match(runtime.sha256,/^[a-f0-9]{64}$/);
 const pinned={'v24.22.1':'e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb',
  'v26.4.0':'4cfdaeec2e3689e4728b4bc98932a9147a3f98162bdc7955c03c0d7fa3b8aa94'};
 const candidate=runtime.node==='v26.13.0';if(!candidate){assert(Object.hasOwn(pinned,runtime.node),'Unqualified SDK49 runtime version');exact(runtime.sha256,pinned[runtime.node],'runtime executable');}
 return {engineeringRuntimeCandidate:candidate,runtimeAcceptance:'pending'};
}
// This source/byte observation alone never grants native/runtime admission.
export function observeSdk49SourceOptions(input={}){
 const {nativeMarker}=assertSdk49Options(input);exact(expected.profile,STATEFUL_SDK49_SOURCE_PROFILE,'manifest profile');assert.equal(expected.schemaVersion,1);assert.equal(expected.qualificationOnly,true);
 assert(Array.isArray(expected.routeSources)&&expected.routeSources.length>0);
 for(const row of expected.routeSources){const data=read(join(root,row.path));exact(data.length,row.bytes,'routing source bytes '+row.path);exact(sha(data),row.sha256,'routing source '+row.path);}
 const assembly=admitIndexedAssembly(ASSEMBLY.profile);exact(assembly.assemblySha256,expected.baseAssemblySha256,'base assembly');
 for(const base of [root,join(root,'packages/backend-mongodb')]){
  const data=read(join(local(base,'@eosrio/hyperion-sdk'),'package.json'));
  exact(data.length,expected.sdkPackage.bytes,'installed SDK package bytes');exact(sha(data),expected.sdkPackage.sha256,'installed SDK package');
 }
 for(const base of [root,join(root,'packages/backend-mongodb')])
  exact(json(join(local(base,'typescript'),'package.json')).version,'7.0.2','installed TypeScript compiler');
 const dependencies={};for(const [scope,base] of [['root',root],['native',join(root,'packages/backend-mongodb')]])for(const name of ['mongodb','bson']){
  const dir=local(base,name),pkg=json(join(dir,'package.json'));dependencies[scope+':'+name]={name:pkg.name,version:pkg.version,files:inventory(dir)};
 }assertSdk49Dependencies(dependencies);
 const wireRoot=realpathSync(resolve(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))),'..'));
 const paths=['package.json','dist/protocol-provider.json','dist/protocol-node-artifact.json','dist/protocol-rust-artifact.json','dist/protocol-npm-lock.json'];
 const values=paths.map(path=>read(join(wireRoot,path))),[pkg,descriptor,node,rust,prepared]=values.map(value=>JSON.parse(value));
 for(const [i,key] of ['packageSha256','descriptorSha256','nodeSha256','rustSha256','npmLockSha256'].entries())exact(sha(values[i]),expected.wire[key],'Wire '+key);
 exact(pkg.name,'@eosrio/hyperion-wire-plugin','Wire package');for(const artifact of [node,rust]){exact(artifact.sourceRevision,expected.wire.commit,'Wire source');exact(artifact.sourceModified,false,'Wire modification');members(wireRoot,artifact);}
 const pin='git+https://github.com/eosrio/hyperion-sdk.git#'+expected.wireSDK;exact(pkg.dependencies['@eosrio/hyperion-sdk'],pin,'Wire SDK');exact(prepared.packages[''].dependencies['@eosrio/hyperion-sdk'],pin,'Wire prepared SDK');
 const wireSdk=local(wireRoot,'@eosrio/hyperion-sdk');exact(sha(read(join(wireSdk,'package.json'))),expected.wireSDKPackageSha256,'Wire SDK package');
 const pairs=inventory(join(wireSdk,'dist')).map(row=>[row.path,row.sha256]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0),wireSdkFiles={files:pairs.length,sha256:sha(JSON.stringify(pairs)),format:'sorted-path-sha256-pairs-v1'};
 exact(wireSdkFiles,expected.wireSDKFiles,'Wire SDK emissions');
 return freeze({profile:STATEFUL_SDK49_SOURCE_PROFILE,nativeMarker,qualificationOnly:true,wireRevision:expected.wire.commit,wireTree:expected.wire.tree,
  descriptorSha256:expected.wire.descriptorSha256,nodeSha256:expected.wire.nodeSha256,rustSha256:expected.wire.rustSha256,
  sdkRevision:'dc20a03f2b60ba05a3369d677222a9cf0d65d299',nativeSDKRevision:'dc20a03f2b60ba05a3369d677222a9cf0d65d299',wireSdkRevision:expected.wireSDK,
  assemblyProfile:ASSEMBLY.profile,assemblySha256:assembly.assemblySha256,observation:assembly.observation,dependencies,wireSdkFiles,
  runtime:assembly.runtime,runtimeAcceptance:'pending',acceptance:{physicalMongoDB:'pending',managedHTTP:'pending',release:'pending'}});
}
export function admitSdk49SourceOptions(input={}){
 assert.equal(process.versions.bun,undefined,'Native Node runtime required');assert.equal(process.release.name,'node');
 const observation=observeSdk49SourceOptions(input),runtime=assertSdk49Runtime(observation.runtime);
 return Object.freeze({...observation,...runtime});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 assert.deepEqual(process.argv.slice(2),['--admit-sdk49']);console.log(JSON.stringify(admitSdk49SourceOptions({engineeringSourceProfile:STATEFUL_SDK49_SOURCE_PROFILE}),null,2));
}
