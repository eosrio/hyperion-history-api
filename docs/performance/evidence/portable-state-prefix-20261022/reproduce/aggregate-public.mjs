import assert from 'node:assert/strict';
import {lstat, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {aggregateFrames} from './aggregate-frames.mjs';
import {sha256, writeFreshAnalysis} from './analyze.v2.mjs';

const [analysisPath, analysisSha, dependencyPath, dependencySha, outputPath] = process.argv.slice(2);
assert.equal(process.argv.length, 7, 'usage: node aggregate-public.mjs ANALYSIS SHA DEPENDENCY_RECEIPT SHA FRESH_OUTPUT');
async function pinned(path, expected, maximum) {
  assert.match(expected, /^[a-f0-9]{64}$/);
  const name=resolve(path),before=await lstat(name);assert.ok(before.isFile()&&!before.isSymbolicLink()&&before.size>0&&before.size<=maximum);
  const bytes=await readFile(name),after=await lstat(name);
  assert.equal(bytes.length,before.size);assert.equal(before.size,after.size);assert.equal(before.mtimeMs,after.mtimeMs);
  assert.equal(sha256(bytes),expected);return JSON.parse(bytes);
}
const analysis=await pinned(analysisPath,analysisSha,64*1024*1024),receipt=await pinned(dependencyPath,dependencySha,1024*1024);
assert.equal(analysis.dataKind,'actual-capture');assert.equal(analysis.cpuCaptureEnabled,true);
assert.equal(analysis.analyzerSha256,'0d629321e420212158142230b38e5d4cf409e1935a1885733ac2be9349f5165b');
assert.equal(analysis.capturePins.gitHead,receipt.head);assert.equal(receipt.sdkProjectionCopiesByteIdentical,true);
const sdk=receipt.members.filter(row=>row.path.endsWith('/dist/projection.js'));
assert.equal(sdk.length,2);assert.equal(sdk[0].sha256,sdk[1].sha256);
const paths=new Set(sdk.map(row=>row.path)),key='@eosrio/hyperion-sdk/dist/projection.js#sha256:'+sdk[0].sha256;
const repository=analysis.processes.find(row=>row.role==='projection').captureStart.repository;
function pathOf(frame) {
  const path=frame.url.startsWith('file:')?decodeURIComponent(new URL(frame.url).pathname):frame.url;
  return path.startsWith(repository+'/')?path.slice(repository.length+1):path;
}
const processes=analysis.processes.map(row=>({pid:row.pid,role:row.role,
  modules:aggregateFrames(row.profile,frame=>paths.has(pathOf(frame))?key:pathOf(frame)||'<blank-url>:'+frame.functionName),
  functions:aggregateFrames(row.profile,(frame,node)=>paths.has(pathOf(frame))?
    JSON.stringify([key,frame.functionName,frame.lineNumber,frame.columnNumber]):node.functionId)}));
const result={schemaVersion:1,dataKind:'actual-public-aggregation',sourceAnalysisSha256:analysisSha,dependencyReceiptSha256:dependencySha,
  captureCommit:analysis.capturePins.gitHead,dependencyReceipt:receipt,
  aliasRule:'Only the receipt-pinned byte-identical SDK copies share source SHA/name/line/column keys. Inclusive buckets union once per sampled stack; self buckets remain exclusive. Dependency receipt is after-capture provenance.',processes};
console.log(JSON.stringify({status:'aggregated',processes:processes.length,output:await writeFreshAnalysis(result,outputPath)}));
