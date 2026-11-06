/** Explicit genuine f450 artifact compatibility control; no source-plugin substitute or serving authority. */
import assert from 'node:assert/strict';import {readFileSync,lstatSync} from 'node:fs';import {createHash} from 'node:crypto';
import {join,resolve,relative} from 'node:path';import {pathToFileURL} from 'node:url';
import {STATEFUL_SOURCE_CAPABILITIES_V2} from '../../build/indexer/projection/stateful-source.js';
const [installed,inventory,tarball]=process.argv.slice(2);assert(installed&&inventory&&tarball,'Pass actual f450 installed package, inventory and tarball');
const sha=b=>createHash('sha256').update(b).digest('hex');
const raw=readFileSync(inventory);assert.equal(raw.length,19063);assert.equal(sha(raw),'aa03f943e4198ae1e412bd0867e77f3a7e24d08cbdddfda2143b2b1e3f9edae3');
const tar=readFileSync(tarball);assert.equal(tar.length,112355);assert.equal(sha(tar),'2bba836c45573c0323322d7334206871a14ce18c469fd52a8b15f1cd16b7e273');
const manifest=JSON.parse(raw);assert.equal(manifest.files.length,89);
for(const pin of manifest.files){const path=resolve(installed,pin.path),rel=relative(resolve(installed),path);
  assert(rel&&!rel.startsWith('..')&&!rel.includes(':'));assert(lstatSync(path).isFile()&&!lstatSync(path).isSymbolicLink());
  const bytes=readFileSync(path);assert.equal(bytes.length,pin.bytes,pin.path);assert.equal(sha(bytes),pin.sha256,pin.path);}
const {createAtomicStatefulPlugin}=await import(pathToFileURL(join(installed,'dist/index.js')).href);
const value={depth:32,nodes:10000,fields:64,arrayElements:100,stringBytes:65536,recordBytes:262144,integerFields:8,pathSegments:16};
const limits={value,envelope:{...value,depth:48,nodes:100000,arrayElements:2000,stringBytes:2097152,recordBytes:4194304},selectors:128,recordKinds:19,
  inputOccurrences:64,inputBytes:262144,keyBytes:128,readKeys:8,readAttempts:32,mutations:16,candidateBytes:4194304,responseRecords:32,responseBytes:4194304};
const plugin=createAtomicStatefulPlugin({limits}),binding=Object.freeze({chainId:'1'.repeat(64),backendId:'controlled-context-only',generation:'context',mappingRevision:'2'.repeat(64),
  hookArtifact:'3'.repeat(64),hookRevision:'4'.repeat(64),codecRevision:'5'.repeat(64),normalizerRevision:'6'.repeat(64)});
const legacy=plugin.getStatefulProjectionsV2(Object.freeze({binding}));
const additive=plugin.getStatefulProjectionsV2(Object.freeze({binding,sourceCapabilities:STATEFUL_SOURCE_CAPABILITIES_V2}));
assert.deepEqual(additive,legacy);assert.equal(additive.projections[0].definition.records.length,19);
assert.equal(Object.hasOwn(additive.projections[0],'requiredSourceCapabilities'),false);assert.equal(Object.isFrozen(STATEFUL_SOURCE_CAPABILITIES_V2),true);
console.log(JSON.stringify({oldProducer:'f4508d039edaa17512bcc8fa3b2418bacce7ab72',baseMerge:'31d7b16f43f755f672be651789b16361a06812a9',
  tree:'ca1cfabc7aeec3f00de8caf087fd045a77bb6038',tarballSha256:sha(tar),installedFiles:89,legacy19GetterUnchanged:true,actualHostCapabilityList:true,
  services:false,sourceAuthority:false,servingAuthority:false,physical:false}));
