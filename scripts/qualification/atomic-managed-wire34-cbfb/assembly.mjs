// Exact observed all-CBFB source, package and emission inventories. No executable qualification.
import assert from 'node:assert/strict';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {findPackageJSON} from 'node:module';
import * as ts from 'typescript/unstable/ast';
import {observeWire34CbfbAssembly,admitWire34CbfbAssembly,readWire34SourceCensus} from '../indexed-schema-mongodb/wire34-cbfb-assembly.mjs';
import {inventory} from '../indexed-schema-mongodb/assembly.mjs';
import {assertSdk49Runtime} from '../../../tests/unit/sdk49-indexed-source-admission.mjs';
import {observeSourceClosure} from '../indexed-schema-mongodb/native-source-closure.mjs';
import {PROFILE,PLAN,sha} from './contract.mjs';
export const root=fileURLToPath(new URL('../../../',import.meta.url));
export const PROFILE_PATH='scripts/qualification/atomic-managed-wire34-cbfb/profile.json';
const read=path=>readFileSync(path),json=path=>JSON.parse(read(path));
const local=(base,name)=>{const path=join(base,'node_modules',name);assert.equal(findPackageJSON(name,join(base,'package.json')),join(path,'package.json'));assert(lstatSync(path).isDirectory()&&!lstatSync(path).isSymbolicLink());return path;};
export function observeManagedAssembly(atomicRoot){
 atomicRoot=realpathSync(atomicRoot);const git=args=>execFileSync('git',args,{cwd:atomicRoot,encoding:'utf8',windowsHide:true}).trim();
 assert.equal(git(['rev-parse','HEAD']),PLAN.atomic.commit);assert.equal(git(['rev-parse','HEAD^{tree}']),PLAN.atomic.tree);
 const api=observeWire34CbfbAssembly();api.profile=PROFILE;
 const packages={};for(const [scope,base]of [['root',root],['native',join(root,'packages/backend-mongodb')]]){
  const lock=json(join(base,'package-lock.json')),pin=lock.packages['node_modules/@eosrio/hyperion-sdk'].resolved;
  assert.equal(pin,'git+https://github.com/eosrio/hyperion-sdk.git#'+PLAN.sdk[scope]);
  const sdk=local(base,'@eosrio/hyperion-sdk');packages[scope+':sdk']={packageSha256:sha(read(join(sdk,'package.json'))),dist:inventory(join(sdk,'dist'))};
  for(const name of ['mongodb','bson']){const location=local(base,name);packages[scope+':'+name]={package:json(join(location,'package.json')).version,files:inventory(location)};}
  assert.equal(json(join(local(base,'typescript'),'package.json')).version,'7.0.2');
 }
 const wire=realpathSync(resolve(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))),'..'));
 packages.wire={package:sha(read(join(wire,'package.json'))),dist:inventory(join(wire,'dist')),sdk:inventory(join(local(wire,'@eosrio/hyperion-sdk'),'dist'))};
 const atomicSdk=local(atomicRoot,'@eosrio/hyperion-sdk');packages['atomic:sdk']={packageSha256:sha(read(join(atomicSdk,'package.json'))),dist:inventory(join(atomicSdk,'dist'))};
 assert.equal(json(join(atomicRoot,'package-lock.json')).packages['node_modules/@eosrio/hyperion-sdk'].resolved,'git+https://github.com/eosrio/hyperion-sdk.git#'+PLAN.sdk.root);
 const atomic={commit:PLAN.atomic.commit,tree:PLAN.atomic.tree,package:sha(read(join(atomicRoot,'package.json'))),lock:sha(read(join(atomicRoot,'package-lock.json'))),dist:inventory(join(atomicRoot,'dist')),
  sources:Object.fromEntries(['src','harness','fixtures','tests/fixtures','scripts/qualification/owned-schema-mongodb','scripts/qualification/royalty-template-mongodb'].map(path=>[path,inventory(join(atomicRoot,path))]))};
 const harness=inventory(join(root,'scripts/qualification/atomic-managed-wire34-cbfb')).filter(row=>row.path!=='profile.json'),controls=['.github/workflows/atomic-managed-wire34-cbfb.yml','tests/native/atomic-managed-wire34-cbfb-sdk-boundary.test.mjs','tests/native/atomic-managed-wire34-cbfb-host-publication.test.mjs','tests/native/atomic-managed-wire34-cbfb-result-observer.test.mjs','tests/native/atomic-managed-wire34-cbfb-contract.test.mjs','tests/native/atomic-managed-wire34-cbfb-teardown.test.mjs','tests/native/atomic-managed-wire34-cbfb-migration.test.mjs','tests/native/wire34-parent-integration.test.mjs'].map(path=>{const bytes=read(join(root,path));return{path,bytes:bytes.length,sha256:sha(bytes)};});
 const boundaries=new Set(api.sources.map(row=>row.path));for(const [key,prefix]of Object.entries({rootBuild:'build',nativeBuild:'packages/backend-mongodb/dist',rootSDK:'node_modules/@eosrio/hyperion-sdk/dist',nativeSDK:'packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist'}))for(const row of api.trees[key])boundaries.add(prefix+'/'+row.path);
 const closure=observeSourceClosure({root,ts,boundaries,seeds:harness.filter(row=>row.path.endsWith('.mjs')).map(row=>'scripts/qualification/atomic-managed-wire34-cbfb/'+row.path),selfPaths:[PROFILE_PATH,'tests/fixtures/engineering-profiles/wire34-cbfb-linux.json','tests/unit/wire34-cbfb-source-admission.mjs'],manifestPath:PROFILE_PATH,manifestRouteCount:1});
 return {profile:PROFILE,api,packages,atomic,harness,controls,closure};
}
export function assertManagedAssembly(observation){const expected=json(join(root,PROFILE_PATH));assert.equal(expected.profile,PROFILE);assert.deepEqual(expected.plan,PLAN);assert.deepEqual(observation,expected.observation,'Exact all-CBFB managed assembly differs');return observation;}
export function admitManagedAssembly(atomicRoot){
 assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.versions.bun,undefined);
 const wireSource=admitWire34CbfbAssembly(),sourceCensus=readWire34SourceCensus();
 assert.equal(wireSource.wireSource.wireRevision,'1e7547ff52740ecaa88d7867d3ec887a2febaa58');
 const observation=assertManagedAssembly(observeManagedAssembly(atomicRoot)),runtime={node:process.version,platform:process.platform,arch:process.arch,executable:process.execPath,sha256:sha(read(process.execPath))};
 assert(['v24.22.1','v26.4.0'].includes(runtime.node));assertSdk49Runtime(runtime);return {profile:PROFILE,observationSha256:sha(JSON.stringify(observation)),runtime,observation,wireSource:wireSource.wireSource,sourceCensus};
}
