// Controlled source-v2 construction for the actual royaltytemp and royaltyattr selectors.
// Values come from an independently verified original callback-input report.
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function royaltyInputs(declaration,rows,serial){
 assert(Array.isArray(rows)&&rows.length>0&&rows.length<=128);assert(Number.isSafeInteger(serial)&&serial>0);
 const binding=declaration.projection.definition.binding;
 return rows.map((row,index)=>{assert(['royaltytemp','royaltyattr'].includes(row.table));assert(row.value&&typeof row.value==='object');
  const selector=declaration.projection.definition.selectors.find(x=>x.contract==='atomicmarket'&&x.kind==='table'&&x.name===row.table);assert(selector);
  const id=row.table==='royaltytemp'?row.value.template_id:row.value.index;assert(['string','number'].includes(typeof id));
  const data=structuredClone(row.value),raw=Buffer.from(JSON.stringify(data));assert(raw.length<=1048576);
  return {kind:'table',selector:selector.id,order:index,contract:selector.contract,name:selector.name,abiDeployment:selector.abiDeployment,abiSha256:selector.abiSha256,
   mappingRevision:binding.mappingRevision,codecRevision:binding.codecRevision,normalizerRevision:binding.normalizerRevision,rawHex:raw.toString('hex'),rawSha256:sha(raw),
   sourceEvidence:sha('controlled-royalty-rule:'+serial+':'+index),transactionId:null,identity:{kind:'contract-row',scope:'oracle',primaryKey:String(id)},
   payer:null,present:row.present!==false,deltaOrdinal:index,rowOrdinal:0,data};
 });
}
