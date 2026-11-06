// Qualification metadata only. No I/O, executable loading or source-authority cache.
import assert from 'node:assert/strict';
export function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export const STATEFUL_WIRE34_CBFB_SOURCE_PROFILE='stateful-all-cbfb-root-native-wire34-linux-engineering-v1';
export const WIRE34_SOURCE=Object.freeze({commit:'1e7547ff52740ecaa88d7867d3ec887a2febaa58',tree:'be879185c104e218a0f18e0af79affd2434b5509'});
export const CBFB_SDK='cbfb26694b90b52266d1e0b9b5dbf6f8389e736b';
export const WIRE_SDK='58d68c5cea81490bbb1c9a7736d633d465bab3ef';
export function assertWire34Options(input={}) {
 assert(input&&Object.getPrototypeOf(input)===Object.prototype&&!Object.getOwnPropertySymbols(input).length,'Inert explicit Wire34 options required');
 const d=Object.getOwnPropertyDescriptors(input);
 assert(Object.entries(d).every(([k,v])=>['engineeringSourceProfile','nativeMarker'].includes(k)&&v.enumerable&&Object.hasOwn(v,'value')),'Unknown/accessor Wire34 option');
 assert.equal(d.engineeringSourceProfile?.value,STATEFUL_WIRE34_CBFB_SOURCE_PROFILE,'Explicit Wire34 profile required');
 const nativeMarker=d.nativeMarker?.value??true;assert.equal(typeof nativeMarker,'boolean');return {nativeMarker};
}
export function exactGitSource(value,repository,revision) {
 assert(/^[a-z0-9-]+$/.test(repository)&&/^[a-f0-9]{40}$/.test(revision));
 assert(['git+https://github.com/eosrio/','git+ssh://git@github.com/eosrio/'].some(prefix=>value===prefix+repository+'.git#'+revision),'Unqualified exact Git repository/revision');
}
export function assertWire34Envelope(observed,expected) {
 assert.deepEqual(observed,expected,'Exact Wire34 Node/Rust source, artifacts and member bytes required');
 assert.equal(observed.commit,WIRE34_SOURCE.commit);assert.equal(observed.tree,WIRE34_SOURCE.tree);
 for(const artifact of [observed.node,observed.rust]) {
  assert.equal(artifact.sourceRevision,WIRE34_SOURCE.commit);assert.equal(artifact.sourceModified,false);assert.equal(artifact.sourceOrigin,'npm-resolved-git-archive');
 }
 assert.equal(observed.rust.kind,'source-only-engineering','Rust source receipt is not binary execution qualification');
 assert.equal(observed.node.kind,'compiled-javascript-engineering');
 assert.equal(observed.sourceReceipt.sourceRevision,WIRE34_SOURCE.commit);
 assert.equal(observed.sourceReceipt.sourceOrigin,'npm-resolved-git-archive');
 for(const [artifact,rows] of [[observed.node,observed.nodeMembers],[observed.rust,observed.rustMembers]]) {
  assert.deepEqual(rows.map(({path,sha256})=>({path,sha256})),artifact.files,'Declared artifact members must equal observed bytes');
 }
 const extra=['dist/protocol-npm-lock.json','dist/protocol-source-receipt.json','package.json','protocol-profile.json'];
 assert.deepEqual(observed.node.files.filter(row=>extra.includes(row.path)).map(row=>row.path),extra,'Exactly the existing package/receipt members accompany compiled outputs');
 assert.deepEqual(observed.sourceReceipt.outputFiles,observed.node.files.filter(row=>!extra.includes(row.path)),'Prepared source receipt must bind the whole compiled Node output tree');
 const sourceFiles=new Map(observed.sourceReceipt.sourceFiles.map(row=>[row.path,row.sha256]));
 assert.equal(sourceFiles.size,observed.sourceReceipt.sourceFiles.length);
 for(const row of observed.rustMembers)assert.equal(sourceFiles.get(row.path),row.sha256,'Packed Rust member must match original source receipt');
}
export function assertWire34Runtime(runtime) {
 assert.equal(runtime.platform,'linux');assert.equal(runtime.arch,'x64');
 const pinned={'v24.22.1':'e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb','v26.4.0':'4cfdaeec2e3689e4728b4bc98932a9147a3f98162bdc7955c03c0d7fa3b8aa94'};
 assert(Object.hasOwn(pinned,runtime.node),'Exact Wire34 Linux Node runtime required');assert.equal(runtime.sha256,pinned[runtime.node],'Exact Wire34 runtime executable required');
 return {runtimeAcceptance:'pending'};
}
