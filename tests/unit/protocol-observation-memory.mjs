export function observationMemoryClient(replicas=0) {
    const documents=new Map();const calls=[];let mapping;let settings;let sequence=0;
    const faults={};
    const conflict=()=>Object.assign(new Error('conflict'),{meta:{statusCode:409,body:{error:{type:'version_conflict_engine_exception'}}}});
    const receipt=(request,result)=>({_index:request.index,_id:request.id,result,_seq_no:sequence++,_primary_term:1,
        _shards:{total:replicas+1,successful:replicas+1,failed:0}});
    const client={
        indices:{
            async get(request){
                calls.push({method:'getIndex',request});
                const left=await (faults.mapping?.(mapping,request)??{[request.index]:{mappings:mapping}});
                const right=await (faults.settings?.(settings,request)??{[request.index]:{settings}});
                return Object.fromEntries([...new Set([...Object.keys(left),...Object.keys(right)])]
                    .map(index=>[index,{...left[index],...right[index]}]));
            },
            async create(request){calls.push({method:'createIndex',request});mapping=structuredClone(request.mappings);
                settings={'index.number_of_shards':'1','index.number_of_replicas':String(replicas),
                    'index.translog.durability':'request','index.auto_expand_replicas':'false'};
                return {acknowledged:true,shards_acknowledged:true,index:request.index};},
            async getMapping(request){calls.push({method:'getMapping',request});return faults.mapping?.(mapping,request)??{[request.index]:{mappings:mapping}};},
            async getSettings(request){calls.push({method:'getSettings',request});return faults.settings?.(settings,request)??{[request.index]:{settings}};},
        },
        async create(request){calls.push({method:'create',request});await faults.beforeWrite?.(request,'create');
            if(documents.has(request.id))throw conflict();
            const result=receipt(request,'created');documents.set(request.id,{document:structuredClone(request.document),seq:result._seq_no});
            return faults.receipt?.(result,request)??result;},
        async index(request){calls.push({method:'index',request});await faults.beforeWrite?.(request,'index');
            if(documents.get(request.id)?.seq!==request.if_seq_no)throw conflict();
            const result=receipt(request,'updated');documents.set(request.id,{document:structuredClone(request.document),seq:result._seq_no});
            return faults.receipt?.(result,request)??result;},
        async get(request){calls.push({method:'get',request});const stored=documents.get(request.id);
            if(!stored)throw Object.assign(new Error('not found'),{meta:{statusCode:404,body:{_index:request.index,_id:request.id,found:false}}});
            const result={_index:request.index,_id:request.id,found:true,_seq_no:stored.seq,_primary_term:1,_source:structuredClone(stored.document)};
            return faults.read?.(result,request)??result;},
    };
    return {client,documents,calls,faults};
}
