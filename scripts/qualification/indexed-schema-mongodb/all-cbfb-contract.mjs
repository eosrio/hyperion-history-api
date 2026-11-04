// Exact explicit source/header successor over the actual frozen mixed C1 checkout.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {freeze,sha,restoreSdk49Routing as restoreHistoricalSdk49Routing} from './current-cbfb-contract.mjs';
export {freeze,sha};
export {HISTORICAL_SDK49_SOURCE} from './current-cbfb-contract.mjs';
export const HISTORICAL_MIXED_SOURCE='c1b98a52a872b6c070ada32243c8286607e86883';
export const ALL_CBFB_PROFILE='stateful-all-cbfb-root-native-wire69-linux-engineering-v1';
export const ROUTING=freeze(JSON.parse(readFileSync(new URL('./all-cbfb-routing.json',import.meta.url))));
export function restoreMixedRouting(path,source){
 const row=ROUTING.files.find(row=>row.path===path);if(!row)return source;assert.equal(sha(source),row.currentSha256,'All-CBFB routing source differs: '+path);
 let selected=row.historicalSource;assert.equal(sha(selected),row.historicalSha256);for(const change of row.changes){assert.equal(selected.split(change.historical).length-1,change.count);selected=selected.split(change.historical).join(change.current);}assert.equal(selected,source,'Changes exceed declared source/header edits: '+path);return row.historicalSource;
}
export function restoreSdk49Routing(path,source){return restoreHistoricalSdk49Routing(path,restoreMixedRouting(path,source));}
