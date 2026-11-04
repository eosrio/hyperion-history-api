// Separate exact cbfb native fixture admission. Historical SDK49 descriptors remain untouched.
import assert from 'node:assert/strict';
import {readFileSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {findPackageJSON} from 'node:module';
import {inventory} from './assembly.mjs';
import {admitCbfbAssembly,DESCRIPTOR} from './cbfb-assembly.mjs';
import {PLAN,freeze,sha} from './cbfb-native-contract.mjs';
export const NATIVE_PROFILE_PATH='scripts/qualification/indexed-schema-mongodb/cbfb-native-profile.json';
export const NATIVE_PROFILE=freeze(JSON.parse(readFileSync(new URL('./cbfb-native-profile.json',import.meta.url),'utf8')));
const root=fileURLToPath(new URL('../../../',import.meta.url));
const installed=(base,name)=>{const local=join(base,'node_modules',name),manifest=findPackageJSON(name,join(base,'package.json'));assert.equal(manifest,join(local,'package.json'),'Scoped native dependency fallback');assert(!lstatSync(local).isSymbolicLink());return local;};
export function observeNativeInputs(){
 const base=admitCbfbAssembly(),dependencies={};
 for(const [scope,location] of [['root',root],['native',join(root,'packages/backend-mongodb')]])for(const name of ['mongodb','bson']){const directory=installed(location,name),pkg=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));dependencies[scope+':'+name]={name:pkg.name,version:pkg.version,files:inventory(directory)};}
 return {profile:PLAN.profile,baseAssemblySha256:sha(JSON.stringify(DESCRIPTOR)),sourceFiles:NATIVE_PROFILE.sourceFiles.map(row=>{const path=join(root,row.path),stat=lstatSync(path);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4*1024*1024);const bytes=readFileSync(path);return {path:row.path,bytes:bytes.length,sha256:sha(bytes)};}),dependencies};
}
export function assertNativeInputs(observed){
 assert.equal(NATIVE_PROFILE.schemaVersion,1);assert.equal(NATIVE_PROFILE.qualificationOnly,true);assert.equal(NATIVE_PROFILE.profile,PLAN.profile);
 assert.equal(NATIVE_PROFILE.historical.path,'scripts/qualification/indexed-schema-mongodb/native-profile-v2.json');assert.equal(sha(readFileSync(join(root,NATIVE_PROFILE.historical.path))),NATIVE_PROFILE.historical.sha256,'Historical descriptor changed');
 assert.equal(NATIVE_PROFILE.base,PLAN.base);assert.equal(NATIVE_PROFILE.assembly,PLAN.assembly);assert.deepEqual(NATIVE_PROFILE.limits,PLAN.limits);assert.deepEqual(NATIVE_PROFILE.fixture,PLAN.fixture);
 assert.deepEqual(NATIVE_PROFILE.runtimes.map(x=>x.node),PLAN.runtimeVersions);assert.deepEqual(Object.keys(observed).sort(),['profile','baseAssemblySha256','sourceFiles','dependencies'].sort());
 assert.equal(observed.profile,PLAN.profile);assert.equal(observed.baseAssemblySha256,NATIVE_PROFILE.baseAssemblySha256);assert.deepEqual(observed.sourceFiles,NATIVE_PROFILE.sourceFiles,'Exact raw-LF fixture/source differs');assert.deepEqual(observed.dependencies,NATIVE_PROFILE.dependencies,'Whole scoped MongoDB/BSON installs differ');
 assert.equal(DESCRIPTOR.observation.pins.rootSDK,'git+https://github.com/eosrio/hyperion-sdk.git#dc20a03f2b60ba05a3369d677222a9cf0d65d299');assert.equal(DESCRIPTOR.observation.pins.nativeSDK,'git+https://github.com/eosrio/hyperion-sdk.git#'+PLAN.sdk);
 return freeze({profile:PLAN.profile,scope:'cbfb-native-engineering-inputs-only',observationSha256:sha(JSON.stringify(observed)),profileSha256:sha(JSON.stringify(NATIVE_PROFILE)),observed});
}
export function assertNativeRuntime(runtime){assert.deepEqual(Object.keys(runtime).sort(),['node','platform','arch','executableSha256'].sort());assert.equal(runtime.platform,'linux');assert.equal(runtime.arch,'x64');const expected=NATIVE_PROFILE.runtimes.find(x=>x.node===runtime.node);assert(expected,'Explicit exact Linux Node required');assert.equal(runtime.executableSha256,expected.executableSha256);return runtime;}
export function admitNativeAssembly(profile){assert.equal(profile,PLAN.profile);assert.equal(process.versions.bun,undefined);assert.equal(process.release.name,'node');const input=assertNativeInputs(observeNativeInputs()),runtime=assertNativeRuntime({node:process.version,platform:process.platform,arch:process.arch,executableSha256:sha(readFileSync(process.execPath))});return {...input,runtime,executable:resolve(process.execPath),physicalQualification:'pending-until-this-run'};}
