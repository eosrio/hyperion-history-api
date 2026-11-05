import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {STATEFUL_COMBINED_REPLAY_SOURCE_PROFILE,STATEFUL_COMBINED_REPLAY_CALLER_SOURCE} from './stateful-engineering-source-admission.mjs';
const read=path=>readFileSync(new URL('../../'+path,import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const profile=JSON.parse(read('docs/qualification/wire-combined-replay-source-profile.json'));

test('composed runtime input inventory binds actual source bytes independently of emission admission',()=>{
 assert.equal(profile.status,'SOURCE_ASSEMBLY_ONLY_NOT_QUALIFIED');
 assert.equal(profile.profile,STATEFUL_COMBINED_REPLAY_SOURCE_PROFILE);
 assert.equal(profile.runtimeCommit,STATEFUL_COMBINED_REPLAY_CALLER_SOURCE.commit);
 assert.equal(profile.callerEmissions.files,STATEFUL_COMBINED_REPLAY_CALLER_SOURCE.files);
 assert.equal(profile.callerEmissions.sha256,STATEFUL_COMBINED_REPLAY_CALLER_SOURCE.sha256);
 const seen=new Set();assert.equal(profile.runtimeInputFiles.length,308);
 for(const [path,sha256] of profile.runtimeInputFiles){
  assert(!seen.has(path));seen.add(path);
  assert(!path.includes('..')&&!path.includes('\\')&&!path.startsWith('/'));
  assert.equal(hash(read(path)),sha256,'composed input '+path);
 }
 assert.equal(hash(JSON.stringify(profile.runtimeInputFiles)),profile.runtimeInputSha256);
});

test('composed candidate retains original replay limits and open engine acceptance',()=>{
 assert.deepEqual(profile.constraints.blockRange,[1,1480]);
 for(const [key,value] of Object.entries({fullReplaySeconds:900,phaseSeconds:60,cleanupSeconds:90,buildSeconds:300,managedSeconds:180}))
  assert.equal(profile.constraints[key],value);
 assert.equal(profile.constraints.changesToBudgets,false);
 assert.equal(profile.constraints.acceptance.linuxBuild,'pending');
 assert.equal(profile.constraints.acceptance.fullReplay,'pending');
 assert.equal(profile.constraints.acceptance.historicalEngineRecovery,'pending');
});
