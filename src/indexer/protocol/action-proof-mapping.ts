import type {Client} from '@elastic/elasticsearch';

const opaque=(value:unknown):boolean=>!!value&&typeof value==='object'&&!Array.isArray(value)
    &&'enabled' in value&&value.enabled===false&&(!('type' in value)||value.type==='object');

/** Add opaque source evidence to retained action indices without rewriting their documents. */
export async function ensureProtocolActionMapping(client:Client,chain:string):Promise<{inspected:number;updated:number}> {
    if(!/^[a-z0-9][a-z0-9_.-]{0,120}$/.test(chain))throw new Error('Invalid action proof mapping chain');
    const prefix=chain+'-action-';
    const mappings=await client.indices.getMapping({index:prefix+'*',allow_no_indices:true,
        ignore_unavailable:false,expand_wildcards:['open','hidden']});
    let inspected=0,updated=0;
    for(const [index,value] of Object.entries(mappings)){
        if(!index.startsWith(prefix)||index.length===prefix.length)throw new Error('Unowned action index in proof mapping response');
        inspected++;
        const field=value.mappings?.properties?.protocol;
        if(field!==undefined){
            if(!opaque(field))
                throw new Error('Existing action protocol field is incompatible with opaque ABI source evidence: '+index);
            continue;
        }
        const receipt=await client.indices.putMapping({index,properties:{protocol:{type:'object',enabled:false}}});
        if(receipt.acknowledged!==true)throw new Error('Action proof mapping update was not acknowledged: '+index);
        const after=await client.indices.getMapping({index});
        if(Object.keys(after).length!==1||!opaque(after[index]?.mappings?.properties?.protocol))
            throw new Error('Action proof mapping readback mismatch: '+index);
        updated++;
    }
    return {inspected,updated};
}
