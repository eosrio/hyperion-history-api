// Pure current-source routing contract. No native process or fixture lifecycle.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const CURRENT_CBFB_PROFILE='stateful-sdk49-root-cbfb-native-wire69-linux-engineering-v1';
export const HISTORICAL_SDK49_SOURCE='e19fc9afc391512ec3ad620a387c41d80982e3d3';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const ROUTING=freeze(JSON.parse(readFileSync(new URL('./current-cbfb-routing.json',import.meta.url))));
// Every rewrite is exact and reversible. This preserves the original historical
// workload bodies, assertions, case sets and deadlines under the explicit new header.
export function restoreSdk49Routing(path,source){
 const row=ROUTING.files.find(row=>row.path===path);if(!row)return source;
 assert.equal(sha(source),row.currentSha256,'Current routing source differs: '+path);
 let selected=row.historicalSource;
 assert.equal(sha(selected),row.historicalSha256,'Historical workload body differs: '+path);
 for(const change of row.changes){
  assert.equal(selected.split(change.historical).length-1,change.count,'Historical routing occurrence differs: '+path);
  selected=selected.split(change.historical).join(change.current);
 }
 assert.equal(selected,source,'Changes exceed the explicit routing edits: '+path);return row.historicalSource;
}
