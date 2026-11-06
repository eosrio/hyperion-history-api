// Read-only Git checkout identity. It records the commit and requires a clean tree.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
const source=git(['rev-parse','HEAD']).trim(),tree=git(['rev-parse','HEAD^{tree}']).trim();
assert.match(source,/^[a-f0-9]{40}$/);assert.match(tree,/^[a-f0-9]{40}$/);
if(process.env.GITHUB_ACTIONS==='true')assert.equal(source,process.env.GITHUB_SHA,'Actual workflow checkout required');
const tracked=new Set(git(['ls-files','-z']).split('\0').filter(Boolean));
assert.equal(git(['status','--porcelain=v1','--untracked-files=all']),'','Clean isolated checkout required');
console.log(JSON.stringify({schemaVersion:1,qualificationOnly:true,source,tree,files:tracked.length,trackedAndClean:true,runId:process.env.GITHUB_RUN_ID??null,runAttempt:process.env.GITHUB_RUN_ATTEMPT??null,job:process.env.GITHUB_JOB??null,workloadAcceptance:'pending'}));
