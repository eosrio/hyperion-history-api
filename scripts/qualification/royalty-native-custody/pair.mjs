// Pure semantic pairing from independently decoded Mongo driver-event BSON records.
// Input original HTTP must come from a separately authenticated PG artifact.
import assert from 'node:assert/strict';
const times=['updated_at_block','updated_at_time','created_at_block','created_at_time'];
const columns={templates:['market_contract','collection_name','template_id','recipients',...times],attributes:['market_contract','collection_name','rule_id','source','field','value','weight','recipients','lookup_hash',...times]};
export function templateCases(responses){assert(Array.isArray(responses));const selected=responses.filter(row=>row.route==='templates'&&row.method!=='HEAD'&&row.status===200);assert.deepEqual(selected.map(row=>row.name),['template-all','template-one','template-two','template-ten','template-eleven','template-weak','template-body-query']);return selected;}
export function pairRoyaltyRows({route,decodedRecords,originalHttp,managedHttp}){
 assert(Object.hasOwn(columns,route));assert(Array.isArray(decodedRecords));assert.equal(originalHttp.status,200);assert.equal(managedHttp.status,200);
 const original=JSON.parse(originalHttp.rawText);assert.equal(original.success,true);assert.equal(managedHttp.body.success,true);
 const rows=decodedRecords.map(record=>{assert.equal(record.recordVersion,1);assert.equal(record.market_contract,'atomicmarket');assert.equal(record.collection_name,'oracle');
  assert.deepEqual(Object.keys(record).sort(),['recordVersion',...columns[route]].sort());
  return Object.fromEntries(columns[route].map(k=>[k,k==='source'?Number(record[k]):record[k]]));});
 assert.deepEqual(rows,original.data,'native BSON records differ from original PostgreSQL HTTP');
 assert.deepEqual(rows,managedHttp.body.data,'native BSON records differ from actual managed HTTP');
 return {route,rows,source:'independently-decoded-driver-event-bson-v1',fullParity:false};
}
