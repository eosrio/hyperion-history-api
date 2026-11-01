// Bounded read-only source inspection. Never evaluate a discovered module or a lifecycle entrypoint.
import assert from 'node:assert/strict';
import {readFileSync,lstatSync} from 'node:fs';
import {isAbsolute,posix,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';

export function sourceReferences(ts,source){
 assert(typeof source==='string'&&source.length<=1024*1024,'Source inspection exceeds finite input bound');
 assert.equal(ts.SyntaxKind.EndOfFile,1,'Unsupported scanner EOF API');assert.equal(typeof ts.SyntaxKind.StringLiteral,'number');
 const scanner=ts.createScanner(true,ts.LanguageVariant.Standard,source);assert.equal(scanner.getText(),source,'Unsupported scanner text API');
 const tokens=[];let done=false,end=-1;
 for(let steps=0;steps<=source.length*2+1;steps++){
  const kind=scanner.scan();if(kind===ts.SyntaxKind.EndOfFile){done=true;break;}
  assert(scanner.getTokenEnd()>end&&scanner.getTokenEnd()<=source.length,'Scanner must advance within input');end=scanner.getTokenEnd();
  tokens.push({text:scanner.getTokenText(),value:kind===ts.SyntaxKind.StringLiteral?scanner.getTokenValue():undefined});
 }assert(done,'Source scanner exceeded finite token bound');
 const references=[];for(let i=0;i<tokens.length;i++){
  const at=n=>tokens[i+n]?.text,literal=n=>tokens[i+n]?.value;
  if((at(0)==='from'||at(0)==='import')&&literal(1)!==undefined)references.push({kind:'module',specifier:literal(1)});
  if(['import','require'].includes(at(0))&&at(1)==='('&&literal(2)!==undefined&&at(3)===')')references.push({kind:'module',specifier:literal(2)});
  if(at(0)==='new'&&at(1)==='URL'&&at(2)==='('&&literal(3)!==undefined&&tokens.slice(i+4,i+11).map(x=>x.text).join('')===',import.meta.url)')references.push({kind:'data',specifier:literal(3)});
 }return references;
}

export function observeSourceClosure({root,ts,seeds,boundaries,selfPaths,manifestPath,manifestRouteCount}){
 assert(Number.isSafeInteger(manifestRouteCount)&&manifestRouteCount>0&&manifestRouteCount<=64,'Explicit finite selected manifest route count required');
 const files=new Map(),edges=[],external=new Set(),queue=seeds.map(path=>({path,module:/\.[cm]?js$/.test(path)}));let total=0;
 const portable=path=>{assert(typeof path==='string'&&/^(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+$/.test(path)&&path.split('/').every(x=>x!=='.'&&x!=='..'),'Invalid closure path');return path;};
 const read=path=>{portable(path);const absolute=resolve(root,path),inner=relative(resolve(root),absolute);assert(inner&&!isAbsolute(inner)&&!inner.startsWith('..'));
  const stat=lstatSync(absolute);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4*1024*1024,'Closure requires a bounded regular file: '+path);const bytes=readFileSync(absolute);assert.equal(bytes.length,stat.size);return bytes;};
 const add=(from,specifier,module)=>{if(!specifier.startsWith('.')){if(module)external.add(specifier);return;}
  const path=posix.normalize(posix.join(posix.dirname(from),specifier));
  if(!module&&path==='.'){edges.push({from,path,kind:'directory'});return;}
  portable(path);if(selfPaths.includes(path)){edges.push({from,path,kind:module?'module':'data'});return;}
  if(!module&&lstatSync(resolve(root,path)).isDirectory()){assert(!lstatSync(resolve(root,path)).isSymbolicLink());edges.push({from,path,kind:'directory'});return;}
  edges.push({from,path,kind:module?'module':'data'});
  if(!selfPaths.includes(path)&&!boundaries.has(path))queue.push({path,module});};
 for(let index=0;index<queue.length;index++){
  assert(index<2048&&files.size<512,'Closure exceeds finite file/edge bound');const item=queue[index];portable(item.path);
  if(selfPaths.includes(item.path)||boundaries.has(item.path))continue;
  const prior=files.get(item.path);if(prior&&(!item.module||prior.module))continue;
  const bytes=read(item.path);if(!prior){total+=bytes.length;assert(total<=32*1024*1024,'Closure exceeds finite byte bound');}
  files.set(item.path,{path:item.path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),module:item.module||prior?.module===true});
  if(item.module)for(const reference of sourceReferences(ts,bytes.toString('utf8'))){
   // Directory URLs select a workspace; concrete source/data members are expanded independently.
   if(reference.kind==='data'&&reference.specifier.endsWith('/'))continue;
   add(item.path,reference.specifier,reference.kind==='module');
  }
  if(item.path===manifestPath){const manifest=JSON.parse(bytes);assert(Array.isArray(manifest.routeSources)&&manifest.routeSources.length===manifestRouteCount,'Exact selected manifest route count required');
   for(const row of manifest.routeSources){portable(row.path);const data=read(row.path);assert.equal(data.length,row.bytes);assert.equal(createHash('sha256').update(data).digest('hex'),row.sha256);
    edges.push({from:item.path,path:row.path,kind:'declared-route'});queue.push({path:row.path,module:/\.[cm]?js$/.test(row.path)});}
  }
 }
 return {files:[...files.values()].sort((a,b)=>a.path.localeCompare(b.path,'en')),edges:edges.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en')),external:[...external].sort(),totalBytes:total};
}

export function assertSourceClosure(closure,profile){
 const declared=new Map(profile.sourceFiles.map(row=>[row.path,row]));assert.equal(declared.size,profile.sourceFiles.length);
 for(const {module,...row}of closure.files)assert.deepEqual(declared.get(row.path),row,'Missing or changed transitive source/data pin: '+row.path);
 const actual={files:closure.files.length,edges:closure.edges.length,sha256:createHash('sha256').update(JSON.stringify(closure)).digest('hex')};
 assert.deepEqual(actual,profile.sourceClosure.observation,'Static module/data closure changed; re-enumerate the complete graph');return actual;
}
