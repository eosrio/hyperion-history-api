// CI-only source identity check. Git is read-only; no fixture/controller is imported.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
assert.equal(process.env.GITHUB_ACTIONS,'true');const source=process.env.GITHUB_SHA;assert.match(source??'',/^[a-f0-9]{40}$/);
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
const head=git(['rev-parse','HEAD']).trim(),tree=git(['rev-parse','HEAD^{tree}']).trim();assert.equal(head,source,'Checkout must equal genuine GitHub source');assert.match(tree,/^[a-f0-9]{40}$/);
const manifest=JSON.parse(readFileSync(new URL('../../../tests/fixtures/engineering-profiles/sdk49-indexed-linux.json',import.meta.url)));
const assembly=JSON.parse(readFileSync(new URL('./assembly.json',import.meta.url)));
const files=[...new Set([...manifest.routeSources.map(row=>row.path),...assembly.sources.map(row=>row.path),
 'tests/unit/sdk49-indexed-source-admission.mjs','tests/fixtures/engineering-profiles/sdk49-indexed-linux.json',
 'scripts/qualification/indexed-schema-mongodb/sdk49-ci-source-check.mjs'])].sort();
assert(files.length>300&&files.length<1024);for(const file of files)assert(/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(file)&&!file.split('/').some(part=>part==='.'||part==='..'));
git(['ls-files','--error-unmatch','--',...files]);assert.equal(git(['status','--porcelain=v1','--untracked-files=all','--',...files]),'','Reviewed source must be tracked and clean');
console.log(JSON.stringify({schemaVersion:1,source,tree,trackedAndClean:true,files:files.length,workflowSha:process.env.GITHUB_WORKFLOW_SHA??null,
 runId:process.env.GITHUB_RUN_ID??null,runAttempt:process.env.GITHUB_RUN_ATTEMPT??null,job:process.env.GITHUB_JOB??null}));
