// Read-only Git custody, separate from source/emission admission and workload acceptance.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
const source=git(['rev-parse','HEAD']).trim(),tree=git(['rev-parse','HEAD^{tree}']).trim();
assert.match(source,/^[a-f0-9]{40}$/);assert.match(tree,/^[a-f0-9]{40}$/);
if(process.env.GITHUB_ACTIONS==='true')assert.equal(source,process.env.GITHUB_SHA,'Actual workflow checkout required');
const manifest=JSON.parse(readFileSync(new URL('../../../tests/fixtures/engineering-profiles/wire34-cbfb-linux.json',import.meta.url)));
const paths=[...manifest.sources.files.map(row=>row.path),...manifest.sources.excludedToAvoidHashCycles].sort();
assert(new Set(paths).size===paths.length&&paths.length>300&&paths.length<4096);
for(const path of paths)assert(/^(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+$/.test(path)&&!path.split('/').some(part=>part==='.'||part==='..'));
const tracked=new Set(git(['ls-files','-z']).split('\0').filter(Boolean));
for(const path of paths)assert(tracked.has(path),'Untracked cohort source: '+path);
assert.equal(git(['status','--porcelain=v1','--untracked-files=all']),'','Clean isolated checkout required');
console.log(JSON.stringify({schemaVersion:1,qualificationOnly:true,source,tree,files:paths.length,trackedAndClean:true,workloadAcceptance:'pending'}));
