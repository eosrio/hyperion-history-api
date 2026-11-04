// HAPI#366 / Atomic#68,#65: controlled source, actual host/SDK/native ports.
// The admitting Linux controller owns resources and pins the Atomic package/oracles.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as owner from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';

const hex=n=>n.toString(16).padStart(64,'0');
const sha=value=>createHash('sha256').update(value).digest('hex');
const copy=structuredClone;

export function managedSourceInputs(declaration,events,serial) {
    const binding=declaration.projection.definition.binding;
    return events.map((event,index)=>{
        const kind=event.kind==='row'?'table':'action',name=event.kind==='row'?event.table:event.name;
        const selector=declaration.projection.definition.selectors.find(s=>s.contract==='atomicassets'&&s.kind===kind&&s.name===name);
        assert(selector,'Actual registry declaration must contain the original fixture selector');
        const raw=Buffer.from(JSON.stringify(event.value));
        return {kind,selector:selector.id,order:index,contract:selector.contract,name,abiDeployment:selector.abiDeployment,abiSha256:selector.abiSha256,
            mappingRevision:binding.mappingRevision,codecRevision:binding.codecRevision,normalizerRevision:binding.normalizerRevision,
            rawHex:raw.toString('hex'),rawSha256:sha(raw),sourceEvidence:sha('controlled-managed:'+serial+':'+index),data:copy(event.value),
            ...(kind==='table'?{transactionId:null,identity:{kind:'contract-row',scope:event.scope,primaryKey:'0'},payer:null,present:event.present,deltaOrdinal:index,rowOrdinal:0}:
                {transactionId:event.transactionId,actionOrdinal:index+1,receiver:selector.contract,receiptOrdinal:index+1,sequence:null})};
    });
}

export function managedRoyaltyTemplateInputs(declaration,ids,serial) {
    const binding=declaration.projection.definition.binding,
        selector=declaration.projection.definition.selectors.find(s=>s.contract==='atomicmarket'&&s.kind==='table'&&s.name==='royaltytemp');assert(selector);
    return ids.map((template_id,index)=>{const data={template_id,recipients:[]},raw=Buffer.from(JSON.stringify(data));return{kind:'table',selector:selector.id,order:index,
        contract:selector.contract,name:selector.name,abiDeployment:selector.abiDeployment,abiSha256:selector.abiSha256,mappingRevision:binding.mappingRevision,
        codecRevision:binding.codecRevision,normalizerRevision:binding.normalizerRevision,rawHex:raw.toString('hex'),rawSha256:sha(raw),sourceEvidence:sha('managed-royalty:'+serial+':'+index),
        transactionId:null,identity:{kind:'contract-row',scope:'oracle',primaryKey:template_id},payer:null,present:true,deltaOrdinal:index,rowOrdinal:0,data};});
}

/** The same eight state snapshots and ten royalty successes use the installed
 * plugin's actual routes through installStatefulApiHostV2. No scripted answers
 * or alternate query host are installed by this driver.
 */
export async function runManagedAtomicDifferential({host,atomicRoot,queryResults,guard,publishSource,onPhase,persist,retireCoverage,onReadEvent}) {
    for(const fn of [guard,publishSource,onPhase,persist,retireCoverage,onReadEvent])assert.equal(typeof fn,'function');
    assert(Array.isArray(queryResults));
    const load=path=>import(pathToFileURL(join(atomicRoot,path)));
    const [{input,initial,mint,transfer,action,row},{stageAssetTransition},aaOracle,amOracle,{royaltyTemplateRows}]=await Promise.all([
        load('tests/fixtures/asset-domain-cases.mjs'),load('dist/atomicassets/internal/schema-counts.js'),
        load('scripts/qualification/owned-schema-mongodb/oracle.mjs'),load('scripts/qualification/royalty-template-mongodb/oracle.mjs'),
        load('dist/atomicmarket/internal/royalty-rules.js')]);
    aaOracle.loadOriginalOracle();amOracle.originalSnapshot();
    let serial=100;
    const claim=async projection=>{
        const entry=host.registry.entries.get(projection);assert(entry);
        const identity={id:'managed-atomic-qualification',generation:projection==='atomicassets'?'aa-one':'am-one'};
        const lease=await entry.adapter.acquireOwner({expected:null,nextOwner:identity},guard);
        return {entry,identity,lease,custody:new Map(),lastCandidate:undefined};
    };
    const custody=state=>({async load(digest,source){return state.custody.get(digest+':'+source)??null;},async retain(candidate){
        const key=candidate.declarationDigest+':'+candidate.source.digest,prior=state.custody.get(key);
        if(prior)assert.equal(prior.digest,candidate.digest);else{persist({event:'managed-candidate',candidate});state.custody.set(key,copy(candidate));}
        state.lastCandidate=candidate;
    }});
    const apply=async(state,inputs,reduce,sourceTimeMs)=>{
        guard();const {entry}=state,declaration=entry.declaration,previous=(await entry.adapter.recovery()).view,id=++serial,
            block={blockNum:previous.checkpoint.blockNum+1,blockId:hex(id),previousBlockId:previous.checkpoint.blockId};
        const target=await owner.captureStatefulRawTargetV2(declaration,{schemaVersion:2,chainId:declaration.projection.definition.binding.chainId,
            declarationDigest:declaration.digest,owner:state.identity,previous,block,
            rawSource:{commitId:'controlled-managed:'+hex(id),selectionId:'controlled-managed:'+hex(id),observationId:'controlled-managed:'+hex(id),observationDigest:hex(id+1000)}});
        await entry.adapter.admitRaw(state.lease,target);
        const source={previous:copy(previous.checkpoint),block:{...block,timeMs:sourceTimeMs??String(1700000000000+id*1000)},inputs:inputs(id)};
        state.lastCandidate=undefined;
        const result=await owner.executeStatefulOwnerBlockV2(declaration,entry.adapter,state.lease,target.digest,source,custody(state),reduce??entry.reduce,guard);
        assert.equal(result.status,'applied');assert(state.lastCandidate);
        await entry.adapter.retireRaw(state.lease,target.digest,state.lastCandidate.source.digest,state.lastCandidate.digest);
        const current=await entry.adapter.recovery();
        await publishSource({projection:declaration.projection.definition.id,declaration,view:current.view,source,candidate:state.lastCandidate});
        persist({event:'managed-source-committed',projection:declaration.projection.definition.id,view:current.view,authority:'controlled-synthetic-source-only'});
    };
    const phase=async(state,name)=>{
        guard();const current=await state.entry.adapter.recovery();
        onPhase({name,expected:current.view,owner:state.identity,ownerClaim:current.owner.claimDigest,ownerDeclaration:state.entry.declaration.digest});
        return current;
    };
    const aa=await claim('atomicassets'),aaUrl='/atomicassets/v1/collections/'+input.collection+'/schemas';
    const initialView=(await aa.entry.adapter.recovery()).view;
    const cold=await host.observe(aaUrl,initialView);assert.equal(cold.statusCode,503,'Managed HAPI must refuse genesis before a positive source checkpoint');
    // Preserve the host's >0 source checkpoint fence. The first oracle observes
    // the corresponding empty state after one explicitly controlled empty frame.
    await apply(aa,()=>[]);
    const applyAA=(events=[],deleteId)=>apply(aa,id=>managedSourceInputs(aa.entry.declaration,events,id),deleteId?
        port=>stageAssetTransition(port,input.contract,deleteId,null,true):undefined);
    let ancestor;
    const a=input.assetId,b='9007199254740994',c='9007199254740995',g='9007199254740996';
    const steps={empty:async()=>{},insert:async()=>{await applyAA(initial());const x=mint(b);x.value.new_asset_owner='bob';await applyAA([x]);
        const y=mint(c);y.value.schema_name='beta';y.value.new_asset_owner='carol';await applyAA([row('schemas',{schema_name:'beta',format:input.format}),y]);
        const z=mint(g);z.value.schema_name='gamma';await applyAA([row('schemas',{schema_name:'gamma',format:input.format}),z]);await applyAA([action('logburnasset',{asset_id:g,asset_owner:'alice'})]);},
        transfer:()=>applyAA([transfer('alice','dave')]),'burn-one':()=>applyAA([action('logburnasset',{asset_id:a,asset_owner:'dave'})]),
        'burn-last':async()=>{ancestor=(await aa.entry.adapter.recovery()).view.checkpoint;await applyAA([action('logburnasset',{asset_id:b,asset_owner:'bob'})]);},
        'after-rollback':async()=>{
            const before=await aa.entry.adapter.recovery();
            await aa.entry.adapter.rollbackOwned(aa.lease,{declarationDigest:aa.entry.declaration.digest,revision:before.view.revision,operationId:hex(++serial),
                from:before.view.checkpoint,ancestor,maxBlocks:before.view.checkpoint.blockNum-ancestor.blockNum});
            const current=await aa.entry.adapter.recovery();aa.identity={...aa.identity,generation:'aa-after-rollback'};
            aa.lease=await aa.entry.adapter.acquireOwner({expected:{version:current.version,view:current.view,owner:current.owner},nextOwner:aa.identity},guard);
            await publishSource({projection:'atomicassets',declaration:aa.entry.declaration,view:(await aa.entry.adapter.recovery()).view,ancestor});
        },'delete-alpha':()=>applyAA([],b),'delete-beta':()=>applyAA([],c)};
    const snapshots=await aaOracle.compareSnapshots({advance:name=>steps[name](),observe:async name=>{
        const current=await phase(aa,'aa:'+name),read=await aa.entry.adapter.completedRead(aa.identity,current.view,guard);onReadEvent('opened',read);let counts;
        try{const names=[input.schema,'beta','gamma'],keys=names.map(schema=>({kind:'owned-schema-count',key:JSON.stringify([input.contract,input.collection,schema])}));
            const result=await aa.entry.adapter.readCompleted(read,current.view,keys);
            counts=result.results.flatMap((entry,index)=>entry.status==='present'?[{schema_name:names[index]===input.schema?'alpha':names[index],owned:entry.value.owned}]:
                entry.status==='covered-absent'?[]:(()=>{throw Error('Native owned count coverage unavailable');})());
        }finally{aa.entry.adapter.closeRead(read);onReadEvent('closed',read);}
        const response=await host.observe(aaUrl,current.view),body=response.json();
        assert.deepEqual((await aa.entry.adapter.recovery()).view,current.view);
        persist({event:'managed-aa-snapshot',name,status:response.statusCode,body:copy(body),counts:copy(counts),view:current.view});
        if(Array.isArray(body.data))for(const item of body.data)if(item.schema_name===input.schema)item.schema_name='alpha';
        return{name,statusCode:response.statusCode,body,counts};
    }});
    const aaBefore=(await aa.entry.adapter.recovery()).view;
    await host.refuseLatePublication(aaUrl,async()=>{
        const current=await aa.entry.adapter.recovery(),nextOwner={...aa.identity,generation:'aa-late-retirement'};
        await aa.entry.adapter.acquireOwner({expected:{version:current.version,view:current.view,owner:current.owner},nextOwner},guard);
    },aaBefore);

    const am=await claim('atomicassets:royalty-template-rules'),amUrl='/atomicmarket/v1/royalties/oracle/templates';
    // The frozen royalty fixture initializes its source at1ms; AA retains the existing synthetic chronology.
    const royalty=await amOracle.compareRoyaltyTemplates({initialize:ids=>apply(am,id=>managedRoyaltyTemplateInputs(am.entry.declaration,ids,id),undefined,'1'),observe:async(query,name)=>{
        const current=await phase(am,'am:'+name),start=queryResults.length;
        const response=await host.observe(amUrl,current.view,{query}),body=response.json(),observed=queryResults.slice(start);
        assert.deepEqual((await am.entry.adapter.recovery()).view,current.view);
        const answer=observed.at(-1)?.answer?.result,nativeRows=answer?.kind==='page'?royaltyTemplateRows(answer,'atomicmarket','oracle'):undefined;
        const observation={query:copy(query),view:current.view,statusCode:response.statusCode,body,nativeRows,nativeComplete:answer?.complete===true,nativeAttempts:observed.reduce((total,row)=>total+row.answer.attempts,0)};
        persist({event:'managed-am-case',name,...observation});return observation;
    }});
    const amBefore=await phase(am,'am:late-coverage');let restore;
    try{await host.refuseLatePublication(amUrl,async()=>{restore=await retireCoverage(am.entry,'atomicmarket-royalty-templates',amBefore.view);},amBefore.view);}
    finally{if(restore)await restore();}
    const restored=await host.observe(amUrl,amBefore.view);assert.equal(restored.statusCode,200,'Restored exact model coverage must be usable again');
    assert.equal(snapshots.length,8);assert.equal(royalty.successes.length,10);
    return{snapshots,royalty,lateOwnerRefused:true,lateCoverageRefused:true,restoredCoverage:true,sourceAuthority:'controlled-synthetic-only',fullParity:'pending'};
}
