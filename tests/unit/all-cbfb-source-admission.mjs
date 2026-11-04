// Exact all-CBFB root/native source/byte admission. No DB, child or lifecycle operations.
import assert from 'node:assert/strict';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {findPackageJSON} from 'node:module';
import {DESCRIPTOR,observeAllCbfbAssembly,assertAllCbfbAssembly} from '../../scripts/qualification/indexed-schema-mongodb/all-cbfb-assembly.mjs';
import {inventory} from '../../scripts/qualification/indexed-schema-mongodb/assembly.mjs';
import {SDK49_SOURCE_MANIFEST,assertSdk49Runtime} from './sdk49-indexed-source-admission.mjs';
import {ALL_CBFB_PROFILE,freeze,sha} from '../../scripts/qualification/indexed-schema-mongodb/all-cbfb-contract.mjs';
export const STATEFUL_ALL_CBFB_SOURCE_PROFILE=ALL_CBFB_PROFILE;
const root=fileURLToPath(new URL('../../',import.meta.url));
const expectedRaw=readFileSync(new URL('../fixtures/engineering-profiles/all-cbfb-linux.json',import.meta.url));
assert.equal(sha(expectedRaw),'69bfdf514564d6547e2bad1330dd3454b6b7c8acb162dafd1123a250a0124d8c','Exact all-CBFB manifest required');
export const ALL_CBFB_MANIFEST=freeze(JSON.parse(expectedRaw));
const expected=ALL_CBFB_MANIFEST,exact=(value,pin,label)=>assert.deepEqual(value,pin,'Unqualified all-CBFB '+label);
const read=path=>{const stat=lstatSync(path);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4*1024*1024);const bytes=readFileSync(path);assert.equal(bytes.length,stat.size);return bytes;};
const json=path=>JSON.parse(read(path));
function local(base,name){const directory=join(base,'node_modules',name);exact(findPackageJSON(name,pathToFileURL(join(base,'package.json'))),join(directory,'package.json'),'local '+name);assert(lstatSync(directory).isDirectory()&&!lstatSync(directory).isSymbolicLink());return directory;}
function members(directory,manifest){
 assert(Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=512);const seen=new Set();let total=0;directory=realpathSync(directory);
 for(const row of manifest.files){assert(typeof row.path==='string'&&!isAbsolute(row.path)&&!row.path.includes('\\')&&!seen.has(row.path));seen.add(row.path);
  const candidate=resolve(directory,row.path),actual=realpathSync(candidate),inner=relative(directory,actual);assert(inner&&inner!=='..'&&!inner.startsWith('../')&&!inner.startsWith('..\\')&&!isAbsolute(inner));
  assert(!lstatSync(candidate).isSymbolicLink());const bytes=read(actual);total+=bytes.length;assert(total<=64*1024*1024);exact(sha(bytes),row.sha256,'Wire member');}
}
export function assertAllCbfbOptions(input={}){
 assert(input&&Object.getPrototypeOf(input)===Object.prototype&&!Object.getOwnPropertySymbols(input).length);const properties=Object.getOwnPropertyDescriptors(input);
 assert(Object.entries(properties).every(([key,value])=>['nativeMarker','engineeringSourceProfile'].includes(key)&&value.enumerable&&Object.hasOwn(value,'value')));
 const nativeMarker=properties.nativeMarker?.value??true;assert.equal(typeof nativeMarker,'boolean');exact(properties.engineeringSourceProfile?.value,ALL_CBFB_PROFILE,'profile');return {nativeMarker};
}
export function assertAllCbfbDependencies(observed){
 exact(sha(JSON.stringify(SDK49_SOURCE_MANIFEST.dependencies)),expected.dependenciesSha256,'dependency baseline');
 exact(observed,SDK49_SOURCE_MANIFEST.dependencies,'scoped MongoDB/BSON packages');
}
// Source observation is portable and grants no native/runtime acceptance.
export function observeAllCbfbSourceOptions(input={}){
 const {nativeMarker}=assertAllCbfbOptions(input);exact(expected.profile,ALL_CBFB_PROFILE,'manifest profile');assert.equal(expected.schemaVersion,1);assert.equal(expected.qualificationOnly,true);
 for(const row of expected.routeSources){const bytes=read(join(root,row.path));exact(bytes.length,row.bytes,'routing source bytes '+row.path);exact(sha(bytes),row.sha256,'routing source '+row.path);}
 const observation=observeAllCbfbAssembly(),assembly=assertAllCbfbAssembly(observation);exact(sha(JSON.stringify(DESCRIPTOR)),expected.baseAssemblySha256,'base assembly');
 for(const [scope,base] of [['root',root],['native',join(root,'packages/backend-mongodb')]]){
  const bytes=read(join(local(base,'@eosrio/hyperion-sdk'),'package.json')),pin=expected.sdkPackages[scope];
  exact(bytes.length,pin.bytes,'installed '+scope+' SDK package bytes');exact(sha(bytes),pin.sha256,'installed '+scope+' SDK package');
  exact(json(join(local(base,'typescript'),'package.json')).version,'7.0.2','installed TypeScript compiler');
 }
 const dependencies={};for(const [scope,base] of [['root',root],['native',join(root,'packages/backend-mongodb')]])for(const name of ['mongodb','bson']){
  const directory=local(base,name),pkg=json(join(directory,'package.json'));dependencies[scope+':'+name]={name:pkg.name,version:pkg.version,files:inventory(directory)};
 }assertAllCbfbDependencies(dependencies);
 const wireRoot=realpathSync(resolve(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))),'..'));
 const paths=['package.json','dist/protocol-provider.json','dist/protocol-node-artifact.json','dist/protocol-rust-artifact.json','dist/protocol-npm-lock.json'];
 const values=paths.map(path=>read(join(wireRoot,path))),[pkg,descriptor,node,rust,prepared]=values.map(value=>JSON.parse(value));
 for(const [i,key] of ['packageSha256','descriptorSha256','nodeSha256','rustSha256','npmLockSha256'].entries())exact(sha(values[i]),expected.wire[key],'Wire '+key);
 exact(pkg.name,'@eosrio/hyperion-wire-plugin','Wire package');for(const artifact of [node,rust]){exact(artifact.sourceRevision,expected.wire.commit,'Wire source');exact(artifact.sourceModified,false,'Wire modification');members(wireRoot,artifact);}
 const pin='git+https://github.com/eosrio/hyperion-sdk.git#'+expected.wireSDK;exact(pkg.dependencies['@eosrio/hyperion-sdk'],pin,'Wire SDK');exact(prepared.packages[''].dependencies['@eosrio/hyperion-sdk'],pin,'Wire prepared SDK');
 const wireSdk=local(wireRoot,'@eosrio/hyperion-sdk');exact(sha(read(join(wireSdk,'package.json'))),expected.wireSDKPackageSha256,'Wire SDK package');
 const pairs=inventory(join(wireSdk,'dist')).map(row=>[row.path,row.sha256]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0),wireSdkFiles={files:pairs.length,sha256:sha(JSON.stringify(pairs)),format:'sorted-path-sha256-pairs-v1'};
 exact(wireSdkFiles,expected.wireSDKFiles,'Wire SDK emissions');
 return freeze({profile:ALL_CBFB_PROFILE,nativeMarker,qualificationOnly:true,wireRevision:expected.wire.commit,wireTree:expected.wire.tree,
  descriptorSha256:expected.wire.descriptorSha256,nodeSha256:expected.wire.nodeSha256,rustSha256:expected.wire.rustSha256,
  sdkRevision:expected.sdkPackages.root.revision,nativeSDKRevision:expected.sdkPackages.native.revision,wireSdkRevision:expected.wireSDK,
  assemblyProfile:assembly.profile,assemblySha256:expected.baseAssemblySha256,observation,dependencies,wireSdkFiles,
  runtime:{node:process.version,platform:process.platform,arch:process.arch,executable:process.execPath,sha256:sha(readFileSync(process.execPath))},
  runtimeAcceptance:'pending',acceptance:{physicalMongoDB:'pending',AtomicSQL:'pending',managedHTTP:'pending',WireReplay:'pending',release:'pending'}});
}
export function admitAllCbfbSourceOptions(input={}){
 assert.equal(process.versions.bun,undefined,'Native Node runtime required');assert.equal(process.release.name,'node');
 const observation=observeAllCbfbSourceOptions(input),runtime=assertSdk49Runtime(observation.runtime);return freeze({...observation,...runtime});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){assert.deepEqual(process.argv.slice(2),['--admit-all-cbfb']);console.log(JSON.stringify(admitAllCbfbSourceOptions({engineeringSourceProfile:ALL_CBFB_PROFILE}),null,2));}
