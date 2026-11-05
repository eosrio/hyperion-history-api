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
const omitted=manifest.sources.nonExecutionTrackedPaths;assert(Array.isArray(omitted));
for(const row of omitted){assert(typeof row.reason==='string'&&row.reason.length>10&&row.reason.length<256);
 assert(['passive-document','historical-evidence','historical-archive','retained-archive-independent-gate'].includes(row.category));
 assert((row.path.startsWith('docs/')&&!/\.(?:py|mjs|cjs|js|ts|sh|ps1|rs|java|yml|toml|lock)$/.test(row.path)&&!row.path.endsWith('/.gitattributes'))
  ||(row.category==='retained-archive-independent-gate'&&row.path==='tests/fixtures/portable-state-worker/source-1-1480-20261020.tar.gz'),'Executable/config inputs cannot be omitted');}
const paths=[...manifest.sources.files.map(row=>row.path),...manifest.sources.excludedToAvoidHashCycles,...omitted.map(row=>row.path)].sort();
assert(new Set(paths).size===paths.length&&paths.length>300&&paths.length<4096);
for(const path of paths)assert(/^(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+$/.test(path)&&!path.split('/').some(part=>part==='.'||part==='..'));
assert.deepEqual(paths,manifest.sources.trackedPaths,'Every tracked path must have one explicit source/cycle/passive classification');
const tracked=new Set(git(['ls-files','-z']).split('\0').filter(Boolean));
assert.deepEqual([...tracked].sort(),paths,'Exact complete Git tracked-path inventory required; extra/missing paths refused');
assert.equal(git(['status','--porcelain=v1','--untracked-files=all']),'','Clean isolated checkout required');
console.log(JSON.stringify({schemaVersion:1,qualificationOnly:true,source,tree,files:paths.length,hashedFiles:manifest.sources.files.length,passivePaths:omitted.length,trackedAndClean:true,runId:process.env.GITHUB_RUN_ID??null,runAttempt:process.env.GITHUB_RUN_ATTEMPT??null,job:process.env.GITHUB_JOB??null,workloadAcceptance:'pending'}));
