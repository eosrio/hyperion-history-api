// Exact source/emission observation only. No DB, socket, controller, child or process-lifecycle operations.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {findPackageJSON} from 'node:module';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
export const PROFILE='indexed-schema-sdk49-native2bf-engineering-v1';
export const ASSEMBLY=JSON.parse(readFileSync(new URL('./assembly.json',import.meta.url),'utf8'));
const root=fileURLToPath(new URL('../../../',import.meta.url)),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function inventory(directory){const rows=[];let total=0;
 const visit=path=>{const stat=lstatSync(path);assert(!stat.isSymbolicLink(),'Indexed assembly refuses symlinks');
 if(stat.isDirectory()){for(const name of readdirSync(path).sort())visit(join(path,name));}else{assert(stat.isFile());total+=stat.size;assert(rows.length<4096&&total<=128*1024*1024);
 const bytes=readFileSync(path);assert.equal(bytes.length,stat.size);rows.push({path:relative(directory,path).replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)});}};
 visit(directory);return rows;
}
export function indexedSdkDirectory(base){
 // Observe each explicit npm installation without requiring or executing the import-only SDK.
 const local=join(resolve(base),'node_modules','@eosrio','hyperion-sdk');
 assert.equal(findPackageJSON('@eosrio/hyperion-sdk',pathToFileURL(join(resolve(base),'package.json'))),join(local,'package.json'),
  'Indexed SDK must belong to the selected root/native npm installation; ancestor fallback is refused');
 const directory=lstatSync(local),manifest=lstatSync(join(local,'package.json'));
 assert(directory.isDirectory()&&!directory.isSymbolicLink()&&manifest.isFile()&&!manifest.isSymbolicLink());
 const metadata=JSON.parse(readFileSync(join(local,'package.json'),'utf8'));
 assert.equal(metadata.name,'@eosrio/hyperion-sdk');assert.equal(metadata.type,'module');
 assert.equal(metadata.exports?.['.']?.import,'./dist/index.js');return local;
}
export function assertIndexedAssemblyObservation(observed){
 assert.equal(ASSEMBLY.schemaVersion,1);assert.equal(ASSEMBLY.profile,PROFILE);assert.equal(ASSEMBLY.qualificationOnly,true);
 assert.deepEqual(Object.keys(observed).sort(),['profile','pins','sources','trees'].sort());assert.equal(observed.profile,PROFILE);
 assert.deepEqual(observed.pins,ASSEMBLY.pins,'Explicit SDK49/native2bf pins differ');
 assert.deepEqual(observed.sources,ASSEMBLY.sources,'Raw Git-LF indexed source bytes differ; no normalization is admitted');
 assert.deepEqual(observed.trees,ASSEMBLY.trees,'Whole indexed emission inventories differ');
 return {profile:PROFILE,scope:'exact-engineering-assembly-only',nativeMongoDB:'pending',AtomicSQL:'pending',managedHTTP:'pending',
  assemblySha256:sha(Buffer.from(JSON.stringify(ASSEMBLY))),observationSha256:sha(Buffer.from(JSON.stringify(observed)))};
}
export function observeIndexedAssembly(){
 const pkg=path=>JSON.parse(readFileSync(path,'utf8')),nativeRoot=join(root,'packages/backend-mongodb'),rootPkg=pkg(join(root,'package.json')),nativePkg=pkg(join(nativeRoot,'package.json'));
 const sources=ASSEMBLY.sources.map(row=>{const path=join(root,row.path),stat=lstatSync(path);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4*1024*1024);
 const bytes=readFileSync(path);return {path:row.path,bytes:bytes.length,sha256:sha(bytes)};});
 return {profile:PROFILE,pins:{rootSDK:rootPkg.dependencies['@eosrio/hyperion-sdk'],nativeSDK:nativePkg.devDependencies['@eosrio/hyperion-sdk'],
  Wire:rootPkg.dependencies['@eosrio/hyperion-wire-plugin'],rootCompiler:rootPkg.dependencies.typescript,nativeCompiler:nativePkg.devDependencies.typescript,
  driver:rootPkg.dependencies.mongodb,nativeDriver:nativePkg.dependencies.mongodb,bun:readFileSync(join(root,'.bun-version'),'utf8').trim()},sources,
  trees:{rootBuild:inventory(join(root,'build')),nativeBuild:inventory(join(nativeRoot,'dist')),rootSDK:inventory(join(indexedSdkDirectory(root),'dist')),nativeSDK:inventory(join(indexedSdkDirectory(nativeRoot),'dist'))}};
}
export function admitIndexedAssembly(profile){assert.equal(profile,PROFILE,'Explicit new indexed assembly selection required');
 assert.equal(process.versions.bun,undefined);assert([24,26].includes(Number(process.versions.node.split('.')[0])));
 const observation=observeIndexedAssembly(),receipt=assertIndexedAssemblyObservation(observation);
 return {...receipt,runtime:{node:process.version,platform:process.platform,arch:process.arch,executable:process.execPath,sha256:sha(readFileSync(process.execPath))},observation};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){assert.deepEqual(process.argv.slice(2),['--profile',PROFILE]);console.log(JSON.stringify(admitIndexedAssembly(PROFILE),null,2));}
