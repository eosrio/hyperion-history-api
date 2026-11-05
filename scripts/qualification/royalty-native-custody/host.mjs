// Linux qualification composition. The admitting controller owns clients, namespaces,
// source provenance and process custody. This module never creates a MongoDB client.
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {StatefulProjectionRegistryV2} from '../../../build/indexer/projection/stateful-registry.js';
import {installStatefulApiHostV2} from '../../../build/api/helpers/stateful-owner.js';

export const MANAGED_MODELS=Object.freeze([
    Object.freeze({projection:'atomicassets',model:'atomicassets-owned-schemas'}),
    Object.freeze({projection:'atomicassets:royalty-template-rules',model:'atomicmarket-royalty-templates'})
]);
const stateHeaders=['hyperion-state-block-num','hyperion-state-block-id','hyperion-state-last-valid'];

/** Actual host registry, plugin route registration and final HAPI publication hook.
 * The explicit engineering adapter is selected only after the registry independently
 * captures the unchanged plugin declarations. The default adapter is preserved.
 */
export async function createManagedAtomicHost({loader,chainId,configuration,mongo,client,source,profile,probe,selectEngineering,persist,onQueryResult,onReadEvent}) {
    assert.match(chainId,/^[a-f0-9]{64}$/);
    assert.match(configuration.backend.id,/^h45_indexed_[a-f0-9]{12}$/);
    assert.equal(configuration.backend.database,configuration.backend.id);
    assert.equal(typeof selectEngineering,'function');assert.equal(typeof persist,'function');assert.equal(typeof onQueryResult,'function');assert.equal(typeof onReadEvent,'function');
    assert.equal(loader.statefulPluginsV2().length,1,'One actual installed Atomic plugin is required');
    const errors=[],registry=await StatefulProjectionRegistryV2.create({chainId,configuration,mongo,client,source,profile,
        completeKindMongo:async()=>mongo,onError:(projection,error)=>errors.push({projection,error})},loader);
    await registry.initializeMissing();
    const originals=new Map();
    for(const {projection,model} of MANAGED_MODELS) {
        const entry=registry.entries.get(projection);
        assert(entry?.indexed?.models.has(model),errors.map(row=>row.projection+': '+row.error.message).join('\n'));
        const declared=entry.indexed.models.get(model);
        const engineering=selectEngineering(entry.indexed.adapter);
        assert.equal(typeof engineering.indexedForModel,'function');
        originals.set(projection,entry);
        // Explicit fixture-only selection at the native indexed-adapter seam. Do not
        // overwrite capabilities or bypass host model/owner/publication negotiation.
        registry.entries.set(projection,Object.freeze({...entry,indexed:Object.freeze({...entry.indexed,adapter:observeManagedIndexedResults(engineering,result=>onQueryResult({projection,model,...result}),onReadEvent)})}));
        persist({event:'managed-registry-model',projection,model,ownerDigest:entry.declaration.digest,modelDigest:declared.declaration.digest,
            comparison:declared.declaration.model.textComparison,productionOffers:'unchanged',sourceAuthority:'controlled-fixture-only'});
    }
    const api=Fastify();let beforePublication;
    // This global hook runs after serialization and before HAPI's final route hook.
    api.addHook('onSend',async(request,reply,payload)=>{if(beforePublication)await beforePublication(request,reply,payload);return payload;});
    const context=installStatefulApiHostV2(api,{configuration,registry:async()=>registry,probe});
    const plugins=loader.plugins.filter(plugin=>typeof plugin.addRoutes==='function');assert.equal(plugins.length,1);
    await plugins[0].addRoutes(api,context);
    const assertView=(response,view)=>{
        assert.equal(response.headers['hyperion-state-block-num'],String(view.checkpoint.blockNum));
        assert.equal(response.headers['hyperion-state-block-id'],view.checkpoint.blockId);
        assert.equal(response.headers['hyperion-state-last-valid'],'false');
    };
    return Object.freeze({api,registry,originals,context,errors,
        async observe(url,view,options={}) {
            const response=await api.inject({url,...options});
            if(response.statusCode===200)assertView(response,view);
            persist({event:'managed-http-observation',url,status:response.statusCode,headers:Object.fromEntries(stateHeaders.map(name=>[name,response.headers[name]??null])),body:response.body===''?null:response.json()});
            return response;
        },
        async refuseLatePublication(url,change,expectedView) {
            assert.equal(beforePublication,undefined);let changed=false;
            beforePublication=async(_request,reply)=>{assert.equal(reply.statusCode,200);changed=true;await change();};
            try {
                const response=await api.inject(url);
                assert.equal(changed,true,'The real domain route must finish successfully before retirement');
                assert.equal(response.statusCode,503);assert.equal(response.headers['cache-control'],'no-store');
                for(const name of stateHeaders)assert.equal(response.headers[name],undefined,'Failed publication leaked '+name);
                persist({event:'late-publication-refused',url,expectedView,status:response.statusCode,body:response.body===''?null:response.json()});return response;
            } finally {beforePublication=undefined;}
        },
        async close(){await api.close();persist({event:'managed-api-closed'});}
    });
}

// Observe detached native answers only; the SDK receives the original answer and
// original adapter-local handle. Native facades expose inert own method values.
export function observeManagedIndexedResults(adapter,observe,onReadEvent=()=>{}) {
    assert.equal(typeof observe,'function');
    const delegated=Object.fromEntries(Object.entries(adapter).map(([name,value])=>[name,typeof value==='function'?value.bind(adapter):value]));
    return Object.freeze({...delegated,async indexedForModel(...args) {
        const selected=await adapter.indexedForModel(...args);
        assert.equal(typeof selected.queryCompleted,'function');
        const methods=Object.fromEntries(Object.entries(selected).map(([name,value])=>[name,typeof value==='function'?value.bind(selected):value]));
        return Object.freeze({...methods,
            async completedRead(...readArgs){const read=await selected.completedRead(...readArgs);onReadEvent('opened',read);return read;},
            closeRead(read){const result=selected.closeRead(read);onReadEvent('closed',read);return result;},
            async queryCompleted(...queryArgs) {
            const answer=await selected.queryCompleted(...queryArgs);
            await observe({query:structuredClone(queryArgs[2]),answer:structuredClone(answer)});
            return answer;
        }});
    }});
}
