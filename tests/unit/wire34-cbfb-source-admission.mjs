// Explicit qualification-only source/emission admission. Read-only, no fixture/controller execution.
import assert from 'node:assert/strict';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {findPackageJSON} from 'node:module';
import {createHash} from 'node:crypto';
import {inventory} from '../../scripts/qualification/indexed-schema-mongodb/assembly.mjs';
import {STATEFUL_WIRE34_CBFB_SOURCE_PROFILE,CBFB_SDK,WIRE_SDK,WIRE34_SOURCE,freeze,assertWire34Runtime,assertWire34Options,exactGitSource,assertWire34Envelope} from '../../scripts/qualification/wire34-cbfb/contract.mjs';
export {STATEFUL_WIRE34_CBFB_SOURCE_PROFILE};
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const read=path=>{const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.size<=4*1024*1024,'Bounded regular source member required');const b=readFileSync(path);assert.equal(b.length,s.size);return b;};
const raw=read(new URL('../fixtures/engineering-profiles/wire34-cbfb-linux.json',import.meta.url));
assert.equal(sha(raw),'db4c009ecc28e6a0f0348c6711fcced75f9f46068a1209975a4c6faa0644988b','Exact Wire34 consumer profile required');
export const WIRE34_CBFB_MANIFEST=freeze(JSON.parse(raw));
const expected=WIRE34_CBFB_MANIFEST;
function local(base,name){const p=join(base,'node_modules',name);assert.equal(findPackageJSON(name,pathToFileURL(join(base,'package.json'))),join(p,'package.json'),'No ancestor dependency fallback');assert(lstatSync(p).isDirectory()&&!lstatSync(p).isSymbolicLink());return p;}
function members(base,rows){assert(Array.isArray(rows)&&rows.length>0&&rows.length<=512);const seen=new Set();let total=0;base=realpathSync(base);return rows.map(row=>{assert(typeof row.path==='string'&&!isAbsolute(row.path)&&!row.path.includes('\\')&&!seen.has(row.path));seen.add(row.path);const p=resolve(base,row.path),inner=relative(base,realpathSync(p));assert(inner&&inner!=='..'&&!inner.startsWith('../')&&!inner.startsWith('..\\')&&!isAbsolute(inner));const b=read(p);total+=b.length;assert(total<=64*1024*1024);return {path:row.path,bytes:b.length,sha256:sha(b)};});}
export function observeWire34CbfbSourceOptions(input={}) {
 const {nativeMarker}=assertWire34Options(input);assert.equal(expected.schemaVersion,1);assert.equal(expected.profile,STATEFUL_WIRE34_CBFB_SOURCE_PROFILE);assert.equal(expected.qualificationOnly,true);
 let total=0;for(const row of expected.sources.files){const b=read(join(root,row.path));total+=b.length;assert.equal(b.length,row.bytes,'Source byte count '+row.path);assert.equal(sha(b),row.sha256,'Source digest '+row.path);}assert.equal(total,expected.sources.totalBytes);
 const pkg=JSON.parse(read(join(root,'package.json'))),lock=JSON.parse(read(join(root,'package-lock.json'))),nativeRoot=join(root,'packages/backend-mongodb'),nativePkg=JSON.parse(read(join(nativeRoot,'package.json'))),nativeLock=JSON.parse(read(join(nativeRoot,'package-lock.json')));
 for(const [p,name,revision] of [[pkg.dependencies,'@eosrio/hyperion-sdk',CBFB_SDK],[pkg.dependencies,'@eosrio/hyperion-wire-plugin',WIRE34_SOURCE.commit],[nativePkg.devDependencies,'@eosrio/hyperion-sdk',CBFB_SDK]])exactGitSource(p[name],name.split('/')[1],revision);
 for(const [l,name,revision] of [[lock,'@eosrio/hyperion-sdk',CBFB_SDK],[lock,'@eosrio/hyperion-wire-plugin',WIRE34_SOURCE.commit],[nativeLock,'@eosrio/hyperion-sdk',CBFB_SDK]])exactGitSource(l.packages['node_modules/'+name].resolved,name.split('/')[1],revision);
 assert.equal(pkg.dependencies.typescript,'7.0.2');assert.equal(nativePkg.devDependencies.typescript,'7.0.2');assert.equal(read(join(root,'.bun-version')).toString().trim(),'1.4.4');
 const trees={rootBuild:inventory(join(root,'build')),nativeBuild:inventory(join(nativeRoot,'dist'))},dependencies={};
 for(const [scope,base] of [['root',root],['native',nativeRoot]]) {
  const sdk=local(base,'@eosrio/hyperion-sdk');assert.equal(sha(read(join(sdk,'package.json'))),expected.sdkPackageSha256);trees[scope+'SDK']=inventory(join(sdk,'dist'));
  assert.equal(JSON.parse(read(join(local(base,'typescript'),'package.json'))).version,'7.0.2');
  for(const name of ['mongodb','bson']){const p=local(base,name);dependencies[scope+':'+name]={packageSha256:sha(read(join(p,'package.json'))),files:inventory(p)};}
 }
 assert.deepEqual(trees,expected.trees,'Whole caller/native/SDK emissions differ');assert.deepEqual(dependencies,expected.dependencies,'All four MongoDB/BSON inventories required');
 const wire=local(root,'@eosrio/hyperion-wire-plugin'),paths=['package.json','dist/protocol-provider.json','dist/protocol-node-artifact.json','dist/protocol-rust-artifact.json','dist/protocol-source-receipt.json','dist/protocol-npm-lock.json'];
 const values=paths.map(p=>read(join(wire,p))),[wp,descriptor,node,rust,sourceReceipt,prepared]=values.map(b=>JSON.parse(b));
 assert.equal(wp.name,'@eosrio/hyperion-wire-plugin');exactGitSource(wp.dependencies['@eosrio/hyperion-sdk'],'hyperion-sdk',WIRE_SDK);exactGitSource(prepared.packages[''].dependencies['@eosrio/hyperion-sdk'],'hyperion-sdk',WIRE_SDK);
 const nested=local(wire,'@eosrio/hyperion-sdk');assert.equal(sha(read(join(nested,'package.json'))),expected.wireSdkPackageSha256);assert.deepEqual(inventory(join(nested,'dist')),expected.wireSdkFiles);
 const wireObservation={...WIRE34_SOURCE,files:paths.map((path,i)=>({path,bytes:values[i].length,sha256:sha(values[i])})),node,rust,sourceReceipt,nodeMembers:members(wire,node.files),rustMembers:members(wire,rust.files)};
 assertWire34Envelope(wireObservation,expected.wire);
 for(const profile of descriptor.profiles)for(const c of profile.components){assert.equal(c.sourceRevision,WIRE34_SOURCE.commit);assert.equal(c.sha256,sha(values[c.runtime==='node'?2:3]));}
 return freeze({profile:STATEFUL_WIRE34_CBFB_SOURCE_PROFILE,nativeMarker,qualificationOnly:true,wireRevision:WIRE34_SOURCE.commit,wireTree:WIRE34_SOURCE.tree,sdkRevision:CBFB_SDK,nativeSDKRevision:CBFB_SDK,wireSdkRevision:WIRE_SDK,
  sourceFiles:expected.sources.files.length,sourceBytes:total,emissions:trees,dependencies,wire:wireObservation,runtime:{node:process.version,platform:process.platform,arch:process.arch,executable:process.execPath,sha256:sha(readFileSync(process.execPath))},runtimeAcceptance:'pending',acceptance:{physicalMongoDB:'pending',AtomicSQL:'pending',managedHTTP:'pending',WireReplay:'pending',release:'pending'}});
}
export function admitWire34CbfbSourceOptions(input={}) {
 assert.equal(process.versions.bun,undefined,'Native Node required');assert.equal(process.release.name,'node');const observed=observeWire34CbfbSourceOptions(input);
 assertWire34Runtime(observed.runtime);return observed;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){assert.deepEqual(process.argv.slice(2),['--admit-wire34-cbfb']);console.log(JSON.stringify(admitWire34CbfbSourceOptions({engineeringSourceProfile:STATEFUL_WIRE34_CBFB_SOURCE_PROFILE}),null,2));}
