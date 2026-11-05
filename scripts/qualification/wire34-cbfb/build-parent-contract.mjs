// Pure migration custody. This does not admit a runtime, controller or workload.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const sha=value=>createHash('sha256').update(value).digest('hex');
export const BUILD_PARENT_ROUTES=JSON.parse(readFileSync(new URL('./build-parent-routing.json',import.meta.url)));
export function restoreBuildParentRoute(path,source){
 const row=BUILD_PARENT_ROUTES.routes.find(row=>row.path===path);if(!row)return source;
 assert.equal(sha(source),row.currentSha256,'Wire34 Build route differs: '+path);
 let current=row.historicalSource;assert.equal(sha(current),row.historicalSha256);
 for(const change of row.changes){assert.equal(current.split(change.historical).length-1,change.count);current=change.firstOnly?current.replace(change.historical,change.current):current.replaceAll(change.historical,change.current);}
 assert.equal(source,current,'Changes exceed explicit profile/entrypoint routing: '+path);return row.historicalSource;
}
export function assertBuildParentSuccessor(row,original,current){
 let restored=current;for(const [before,after]of [...row.changes].reverse()){assert(restored.includes(after));restored=restored.replaceAll(after,before);}
 assert.equal(restored,original,'Original cases, assertions, bounds and deadlines must remain exact: '+row.to);
}
// Restore only declared additive Wire34 routes, before older frozen restoration predicates run.
export function restoreWire34HistoricalRoute(path,source){
 let value=restoreBuildParentRoute(path,source);
 const prior=JSON.parse(readFileSync(new URL('./routing.json',import.meta.url))).files[path];
 if(prior){for(const chunk of prior.remove){assert.equal(value.split(chunk).length,2);value=value.replace(chunk,'');}
  for(const [current,historical]of prior.replace){assert.equal(value.split(current).length,2);value=value.replace(current,historical);}
  assert.equal(sha(value),prior.baseSha256,'Wire34 predecessor route differs: '+path);}
 return value;
}
