/** Small ES transport fixture: independent index metadata, exact-ID documents and real CAS tokens. */
export function frontierMemoryClient(replicas=0) {
    const documents=new Map(),mappings=new Map(),settings=new Map(),calls=[],sequences=new Map(),faults={};
    const key=(index,id)=>index+'\0'+id;
    const conflict=()=>Object.assign(new Error('version conflict'),{meta:{statusCode:409,body:{error:{type:'version_conflict_engine_exception'}}}});
    const missingIndex=index=>Object.assign(new Error('index not found'),{meta:{statusCode:404,body:{error:{type:'index_not_found_exception',index}}}});
    const sequence=index=>{const next=sequences.get(index)??0;sequences.set(index,next+1);return next;};
    const receipt=(request,result)=>({_index:request.index,_id:request.id,result,_seq_no:sequence(request.index),_primary_term:1,
        _shards:{total:replicas+1,successful:replicas+1,failed:0}});
    const note=(method,request)=>calls.push({method,request:structuredClone(request)});
    const client={
        indices:{
            async get(request){
                note('getIndex',request);if(!mappings.has(request.index))throw missingIndex(request.index);
                const mapping=structuredClone(mappings.get(request.index)),setting=structuredClone(settings.get(request.index));
                const left=faults.mapping?.(mapping,request)??{[request.index]:{mappings:mapping}};
                const right=faults.settings?.(setting,request)??{[request.index]:{settings:setting}};
                return Object.fromEntries([...new Set([...Object.keys(left),...Object.keys(right)])]
                    .map(index=>[index,{...left[index],...right[index]}]));
            },
            async create(request){
                note('createIndex',request);await faults.beforeIndex?.(request);
                if(mappings.has(request.index))throw Object.assign(new Error('index exists'),{meta:{statusCode:400,body:{error:{type:'resource_already_exists_exception'}}}});
                mappings.set(request.index,structuredClone(request.mappings));
                settings.set(request.index,{'index.number_of_shards':'1','index.number_of_replicas':String(replicas),
                    'index.translog.durability':'request','index.auto_expand_replicas':'false','index.mapping.source.mode':'STORED',
                    ...Object.fromEntries(Object.entries(request.settings??{}).map(([name,value])=>['index.'+name,String(value)]))});
                const result={acknowledged:true,shards_acknowledged:true,index:request.index};return faults.indexReceipt?.(result,request)??result;
            },
            async getMapping(request){
                note('getMapping',request);if(!mappings.has(request.index))throw missingIndex(request.index);
                const value=structuredClone(mappings.get(request.index));return faults.mapping?.(value,request)??{[request.index]:{mappings:value}};
            },
            async getSettings(request){
                note('getSettings',request);if(!settings.has(request.index))throw missingIndex(request.index);
                const value=structuredClone(settings.get(request.index));return faults.settings?.(value,request)??{[request.index]:{settings:value}};
            },
        },
        async create(request){
            note('create',request);await faults.beforeWrite?.(request,'create');
            if(!mappings.has(request.index))throw missingIndex(request.index);
            if(documents.has(key(request.index,request.id)))throw conflict();
            const result=receipt(request,'created');documents.set(key(request.index,request.id),{document:structuredClone(request.document),seq:result._seq_no,primaryTerm:1});
            return faults.receipt?.(result,request)??result;
        },
        async index(request){
            note('index',request);await faults.beforeWrite?.(request,'index');
            if(!mappings.has(request.index))throw missingIndex(request.index);
            const previous=documents.get(key(request.index,request.id));
            if(request.if_seq_no!==undefined&&(previous?.seq!==request.if_seq_no||previous?.primaryTerm!==request.if_primary_term))throw conflict();
            const result=receipt(request,previous?'updated':'created');
            documents.set(key(request.index,request.id),{document:structuredClone(request.document),seq:result._seq_no,primaryTerm:1});
            return faults.receipt?.(result,request)??result;
        },
        async get(request){
            note('get',request);await faults.beforeRead?.(request);
            if(!mappings.has(request.index))throw missingIndex(request.index);
            const stored=documents.get(key(request.index,request.id));
            if(!stored)throw Object.assign(new Error('document not found'),{meta:{statusCode:404,body:{_index:request.index,_id:request.id,found:false}}});
            const result={_index:request.index,_id:request.id,found:true,_seq_no:stored.seq,_primary_term:stored.primaryTerm,_source:structuredClone(stored.document)};
            return faults.read?.(result,request)??result;
        },
    };
    return {client,documents,mappings,settings,sequences,calls,faults,key};
}
