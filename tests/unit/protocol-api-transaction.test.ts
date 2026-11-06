import {expect, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {timedQuery} from '../../src/api/helpers/functions.js';
import Fastify from 'fastify';
import {ProtocolAbiProofUnavailableError} from '../../src/indexer/protocol/abi-proof.js';
import {ProtocolActionConsumer, protectProtocolAction, protocolResponseForCache} from '../../src/api/helpers/protocol-abi.js';
import {withProtocolProofRequest, withProtocolProofTransaction} from '../../src/api/helpers/protocol-proof-request.js';
import {blockId, chain, chainId, clone, gate, holdRead, nativeAuthorizationFixture, profile} from './protocol-native-authorization-host-fixture.js';

const changed=()=>new ProtocolAbiProofUnavailableError('authority_changed','controlled root change');

test('transaction retries only changed authority and retains one bounded request deadline',async()=>{
    let attempts=0;const scope={};
    const result=await withProtocolProofTransaction(scope,()=>withProtocolProofRequest(scope,async()=>{
        attempts++;if(attempts===1)throw changed();return 'settled';
    }),500);
    expect(result).toBe('settled');expect(attempts).toBe(2);
    attempts=0;
    await expect(withProtocolProofTransaction({},async()=>{attempts++;throw new ProtocolAbiProofUnavailableError('invalid_proof','invalid');},60))
        .rejects.toMatchObject({code:'invalid_proof'});
    expect(attempts).toBe(1);
    const start=performance.now(),churnScope={};attempts=0;
    await expect(withProtocolProofTransaction(churnScope,()=>withProtocolProofRequest(churnScope,async()=>{attempts++;await new Promise(resolve=>setTimeout(resolve,15));throw changed();}),60))
        .rejects.toMatchObject({code:'proof_timeout'});
    expect(attempts).toBeGreaterThanOrEqual(1);expect(performance.now()-start).toBeLessThan(1000);
});

test('request disconnect cancels an in-flight proof transaction',async()=>{
    const raw=Object.assign(new EventEmitter(),{aborted:false,socket:Object.assign(new EventEmitter(),{destroyed:false})}),scope={raw};
    const pending=withProtocolProofTransaction(scope,()=>withProtocolProofRequest(scope,async({signal})=>new Promise((_resolve,reject)=>{
        signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});
    })),500);
    raw.emit('aborted');await expect(pending).rejects.toMatchObject({code:'proof_cancelled'});
});

test('successive proof reads share one deadline instead of resetting it per action',async()=>{
    const scope={},remaining:number[]=[];let completed=0;
    await expect(withProtocolProofTransaction(scope,async()=>{
        for(let i=0;i<8;i++)await withProtocolProofRequest(scope,async options=>{
            remaining.push(options.timeoutMs!);await new Promise(resolve=>setTimeout(resolve,20));completed++;
        });
    },60)).rejects.toMatchObject({code:'proof_timeout'});
    expect(completed).toBeLessThan(8);expect(remaining.length).toBeGreaterThan(1);
    expect(remaining[1]).toBeLessThan(remaining[0]);
});

for(const [phase,targetFence,mode] of [['native consumption',1,'success'],['final response',3,'success'],['final output mutation',3,'mutate'],['disconnected response',3,'abort'],['parsed POST retry',3,'post-key'],['continuous roots',3,'continuous']] as const) test(`real root change during ${phase} recovers proof reads with one query and no duplicate proofs`,async()=>{
    const source=await nativeAuthorizationFixture({nativeActionInterfaceVersion:1,historicalCertificates:true,maxAncestryBlocks:1});
    await source.append(3);await source.append(4);for(let i=0;i<4;i++)await source.coordinator.drain();
    const app=Fastify({logger:false});
    app.decorate('manager',{chain,conn:{chains:{[chain]:{chain_id:chainId}}},config:{settings:{es_replicas:0,
        protocol:{provider:'extension',package:'synthetic-host-contract',profileId:profile.profileId},
        protocol_abi_coordination:{recovery_window_blocks:1,historical_certificates:{}},},api:{enable_caching:true,cache_life:30}}});
    const writes:string[]=[],cacheKeys:string[]=[];app.decorate('redis',{get:async(key:string)=>{if(!key.endsWith(':last_idx_block'))cacheKeys.push(key);return null;},set:async (_key:string,value:string)=>{writes.push(value);return 'OK';}} as any);
    app.decorate('elastic',source.client);
    const consumer=new ProtocolActionConsumer(app,{id:profile.id,provider:source.provider,components:profile.components} as any);
    app.decorate('protocolActionConsumer',consumer);
    try {
        const reader=source.reader(),view=await reader.open(source.selected.source,source.selected.selectionId);
        const originals=[];
        for(const index of [0,1]){
            const input=source.selected.inputs[index],decision=await reader.authorize(view,input);
            if(decision.kind!=='native')throw new Error('native fixture expected');
            originals.push({block_num:2,block_id:blockId(2),trx_id:input.transactionId,action_ordinal:input.actionOrdinal,
                creator_action_ordinal:index===1?1:0,global_sequence:input.globalSequence,act_digest:'f'.repeat(64),code_sequence:0,abi_sequence:4294967295,
                act:{account:input.account,name:input.name,authorization:[],data:await reader.decodeValue(decision.grant)},
                receipts:[{receiver:input.receiver,global_sequence:input.globalSequence,recv_sequence:'18446744073709551615',auth_sequence:[],code_sequence:0,abi_sequence:4294967295}],
                protocol:await reader.metadata(decision.grant)});
        }
        const raw=Object.assign(new EventEmitter(),{aborted:false,socket:Object.assign(new EventEmitter(),{destroyed:false})});
        const scope={method:mode==='post-key'?'POST':'GET',body:mode==='post-key'?'{"limit":2}':undefined,query:{},routeOptions:{url:'/v2/history/get_actions'},url:'/v2/history/get_actions',raw},native=consumer.nativeReader!,original=native.revalidate.bind(native);let fences=0,attempts=0,guardFailures=0,mutateNext=false;
        const verifyEnvelope=native.verifyEnvelope.bind(native);native.verifyEnvelope=async(...args)=>{
            if(mutateNext){mutateNext=false;(args[1] as any).act.account='tampered';}return verifyEnvelope(...args);
        };
        let hold:ReturnType<typeof holdRead>|undefined;
        native.revalidate=async (...args)=>{fences++;if(fences===targetFence){let controlReads=0;hold=holdRead(source.client,r=>r.index===source.frontier.controlIndex&&r.id==='control'&&++controlReads===2);}
            try{return await original(...args);}catch(error:any){if(error.code==='authority_changed')guardFailures++;throw error;}};
        const old=await source.coordinator.inspect();
        const pending=timedQuery(async()=>{
            attempts++;const actions=clone(originals);
            if(typeof scope.body==='string')scope.body=JSON.parse(scope.body);
            for(const action of actions){await protectProtocolAction(app,scope,action);delete (action as any).protocol;}
            return {actions};
        },app,scope as any,'get_actions');
        while(!hold)await new Promise(resolve=>setTimeout(resolve,1));
        await hold.entered;expect(writes).toHaveLength(0);
        if(mode==='abort'){raw.aborted=true;raw.emit('aborted');await expect(pending).rejects.toMatchObject({code:'proof_cancelled'});
            hold.release();hold.restore();await new Promise(resolve=>setTimeout(resolve,25));expect(writes).toHaveLength(0);
            expect(raw.listenerCount('aborted')).toBe(0);expect(raw.socket.listenerCount('close')).toBe(0);return;}
        await source.append(5);for(let i=0;i<4;i++)await source.coordinator.drain();
        const next=await source.coordinator.inspect();expect(next.generation).toBe(old.generation);
        expect(next.historical?.addressRootId).not.toBe(old.historical?.addressRootId);
        if(mode==='mutate')mutateNext=true;
        let advancing:Promise<void>|undefined;
        if(mode==='continuous'){
            const get=source.client.get.bind(source.client);
            source.client.get=async(...args:any[])=>{await new Promise(resolve=>setTimeout(resolve,5));return get(...args);};
            advancing=(async()=>{for(let height=6;height<=10;height++){await new Promise(resolve=>setTimeout(resolve,20));await source.append(height);await source.coordinator.drain();}})();
        }
        hold.release();
        if(mode==='mutate'){await expect(pending).rejects.toMatchObject({statusCode:503});hold.restore();
            expect(attempts).toBe(1);expect(writes).toHaveLength(0);return;}
        const cache=await pending;hold.restore();if(advancing){await advancing;expect((await source.coordinator.inspect()).head?.blockNum).toBe(10);}
        expect(guardFailures).toBe(0);expect(attempts).toBe(1);expect(cache.actions).toHaveLength(2);
        expect(writes).toHaveLength(1);expect(JSON.parse(writes[0])._hyperion_protocol_abi_v3.actions).toHaveLength(2);
        if(mode==='post-key'){expect(cacheKeys).toHaveLength(1);expect(new Set(cacheKeys).size).toBe(1);}
        expect(cache.actions.map((value:any)=>value.global_sequence)).toEqual(originals.map(value=>value.global_sequence));
    } finally {await app.close();}
},10000);

test('proof bookkeeping does not start the budget before actual authority demand',async()=>{
    const scope={};
    await expect(withProtocolProofTransaction(scope,async()=>{
        await new Promise(resolve=>setTimeout(resolve,80));
        return withProtocolProofRequest(scope,async options=>{expect(options.timeoutMs).toBeGreaterThan(20);return 'proved';});
    },40)).resolves.toBe('proved');
});

test('an earlier HTTP socket timeout still cancels proof-free work',async()=>{
    const raw=Object.assign(new EventEmitter(),{aborted:false,socket:Object.assign(new EventEmitter(),{destroyed:false})});
    const pending=withProtocolProofTransaction({raw},()=>new Promise(resolve=>setTimeout(()=>resolve('late'),80)),500);
    raw.socket.emit('timeout');await expect(pending).rejects.toMatchObject({code:'proof_timeout'});
    expect(raw.socket.listenerCount('timeout')).toBe(0);
});

test('raw history keeps its existing query lifetime without starting a five-second proof budget',async()=>{
    const app=Fastify({logger:false});
    app.decorate('manager',{chain,config:{settings:{protocol:{provider:'extension'}},api:{enable_caching:false}}});
    app.decorate('redis',{get:async()=>null} as any);
    const scope={method:'GET',query:{},routeOptions:{url:'/v2/history/get_actions'},url:'/v2/history/get_actions'};
    try {
        const response=await timedQuery(async()=>{
            await new Promise(resolve=>setTimeout(resolve,5100));
            const action={act:{data:'aabb'}};await protectProtocolAction(app,scope,action);return {actions:[action]};
        },app,scope as any,'get_actions');
        expect(response.actions[0].act.data).toBe('aabb');
    } finally {await app.close();}
},10000);

test('cached decoded output preserves grants after a real root change without rerunning the query or writing partial cache',async()=>{
    const source=await nativeAuthorizationFixture({nativeActionInterfaceVersion:1,historicalCertificates:true,maxAncestryBlocks:1});
    await source.append(3);await source.append(4);for(let i=0;i<4;i++)await source.coordinator.drain();
    const app=Fastify({logger:false});
    app.decorate('manager',{chain,conn:{chains:{[chain]:{chain_id:chainId}}},config:{settings:{es_replicas:0,
        protocol:{provider:'extension',package:'synthetic-host-contract',profileId:profile.profileId},
        protocol_abi_coordination:{recovery_window_blocks:1,historical_certificates:{}}},api:{enable_caching:true,cache_life:30}}});
    let stored:string|undefined,sourceReads=0;const writes:string[]=[];
    app.decorate('redis',{get:async(key:string)=>key.endsWith(':last_idx_block')?null:stored??null,
        set:async(_key:string,value:string)=>{stored=value;writes.push(value);return 'OK';}} as any);
    app.decorate('elastic',source.client);
    const consumer=new ProtocolActionConsumer(app,{id:profile.id,provider:source.provider,components:profile.components} as any);
    app.decorate('protocolActionConsumer',consumer);
    let hold:ReturnType<typeof holdRead>|undefined;
    try {
        const reader=source.reader(),view=await reader.open(source.selected.source,source.selected.selectionId),originals=[];
        for(const index of [0,1]){
            const input=source.selected.inputs[index],decision=await reader.authorize(view,input);
            if(decision.kind!=='native')throw new Error('native fixture expected');
            originals.push({block_num:2,block_id:blockId(2),trx_id:input.transactionId,action_ordinal:input.actionOrdinal,
                creator_action_ordinal:index===1?1:0,global_sequence:input.globalSequence,act_digest:'f'.repeat(64),code_sequence:0,abi_sequence:4294967295,
                act:{account:input.account,name:input.name,authorization:[],data:await reader.decodeValue(decision.grant)},
                receipts:[{receiver:input.receiver,global_sequence:input.globalSequence,recv_sequence:'18446744073709551615',auth_sequence:[],code_sequence:0,abi_sequence:4294967295}],
                protocol:await reader.metadata(decision.grant)});
        }
        const request=()=>({method:'GET',query:{},routeOptions:{url:'/v2/history/get_actions'},url:'/v2/history/get_actions'});
        const query=async(_app:any,scope:any)=>{
            sourceReads++;const actions=clone(originals);
            for(const action of actions){await protectProtocolAction(app,scope,action);delete (action as any).protocol;}
            return {actions};
        };
        await timedQuery(query,app,request() as any,'get_actions');
        expect(writes).toHaveLength(1);const originalCapsule=stored;writes.length=0;
        const native=consumer.nativeReader!,revalidate=native.revalidate.bind(native),authorize=native.authorize.bind(native);
        let fences=0,changedGuards=0;const grants:object[]=[];
        native.authorize=async(...args)=>{const decision=await authorize(...args);if(decision.kind==='native')grants.push(decision.grant);return decision;};
        native.revalidate=async(...args)=>{
            if(++fences===1){let controls=0;hold=holdRead(source.client,r=>r.index===source.frontier.controlIndex&&r.id==='control'&&++controls===2);}
            try{return await revalidate(...args);}catch(error:any){if(error.code==='authority_changed')changedGuards++;throw error;}
        };
        const before=await source.coordinator.inspect(),pending=timedQuery(query,app,request() as any,'get_actions');
        while(!hold)await new Promise(resolve=>setTimeout(resolve,1));
        await hold.entered;expect(writes).toHaveLength(0);expect(sourceReads).toBe(1);
        await source.append(5);for(let i=0;i<4;i++)await source.coordinator.drain();
        const after=await source.coordinator.inspect();expect(after.generation).toBe(before.generation);
        expect(after.historical?.addressRootId).not.toBe(before.historical?.addressRootId);
        hold.release();const response=await pending;
        expect(changedGuards).toBe(0);expect(sourceReads).toBe(1);expect(writes).toHaveLength(0);
        expect(stored).toBe(originalCapsule);expect(response.cached).toBe(true);expect(response.actions).toHaveLength(2);
        expect(response._hyperion_protocol_abi_v3).toBeUndefined();expect(grants).toHaveLength(2);expect(new Set(grants).size).toBe(2);
    } finally {hold?.release();hold?.restore();await app.close();}
},10000);

test('cached native response retries a real activation certificate publication gap',async()=>{
    const source=await nativeAuthorizationFixture({nativeActionInterfaceVersion:1,historicalCertificates:true,maxAncestryBlocks:1});
    await source.append(3);await source.append(4);for(let i=0;i<4;i++)await source.coordinator.drain();
    const app=Fastify({logger:false});
    app.decorate('manager',{chain,conn:{chains:{[chain]:{chain_id:chainId}}},config:{settings:{es_replicas:0,
        protocol:{provider:'extension',package:'synthetic-host-contract',profileId:profile.profileId},
        protocol_abi_coordination:{recovery_window_blocks:1,historical_certificates:{}}},api:{enable_caching:true,cache_life:30}}});
    let stored:string|undefined,sourceReads=0;const writes:string[]=[];
    app.decorate('redis',{get:async(key:string)=>key.endsWith(':last_idx_block')?null:stored??null,
        set:async(_key:string,value:string)=>{stored=value;writes.push(value);return 'OK';}} as any);
    app.decorate('elastic',source.client);
    const consumer=new ProtocolActionConsumer(app,{id:profile.id,provider:source.provider,components:profile.components} as any);
    app.decorate('protocolActionConsumer',consumer);
    const entered=gate(),release=gate();let append:Promise<any>|undefined;
    try {
        const reader=source.reader(),view=await reader.open(source.selected.source,source.selected.selectionId),originals=[];
        for(const index of [0,1]){
            const input=source.selected.inputs[index],decision=await reader.authorize(view,input);
            if(decision.kind!=='native')throw new Error('native fixture expected');
            originals.push({block_num:2,block_id:blockId(2),trx_id:input.transactionId,action_ordinal:input.actionOrdinal,
                creator_action_ordinal:index===1?1:0,global_sequence:input.globalSequence,act_digest:'f'.repeat(64),code_sequence:0,abi_sequence:4294967295,
                act:{account:input.account,name:input.name,authorization:[],data:await reader.decodeValue(decision.grant)},
                receipts:[{receiver:input.receiver,global_sequence:input.globalSequence,recv_sequence:'18446744073709551615',auth_sequence:[],code_sequence:0,abi_sequence:4294967295}],
                protocol:await reader.metadata(decision.grant)});
        }
        const request=()=>({method:'GET',query:{},routeOptions:{url:'/v2/history/get_actions'},url:'/v2/history/get_actions'});
        const query=async(_app:any,scope:any)=>{
            sourceReads++;const actions=clone(originals);
            for(const action of actions){await protectProtocolAction(app,scope,action);delete (action as any).protocol;}
            return {actions};
        };
        await timedQuery(query,app,request() as any,'get_actions');
        expect(writes).toHaveLength(1);const originalCapsule=stored;writes.length=0;
        const native=consumer.nativeReader!,revalidate=native.revalidate.bind(native),authorize=native.authorize.bind(native);
        let fences=0,missing=0;const grants:object[]=[];
        const originalGet=source.client.get.bind(source.client);
        source.client.get=async(request:any,...args:any[])=>{try{return await originalGet(request,...args);}catch(error:any){
            if(error?.meta?.statusCode===404&&String(request.id).startsWith('h45abicert1:')){missing++;release.release();}
            throw error;
        }};
        const prepare=source.frontier.prepareCertificate.bind(source.frontier);
        source.frontier.prepareCertificate=async value=>{
            if((value as any).kind==='settled-historical-abi-address-root'){entered.release();await release.promise;}
            return prepare(value);
        };
        native.authorize=async(...args)=>{const decision=await authorize(...args);if(decision.kind==='native')grants.push(decision.grant);return decision;};
        native.revalidate=async(...args)=>{
            if(++fences===1){append=source.append(5);await entered.promise;}
            try{return await revalidate(...args);}catch(error:any){
                if(error.code==='certificate_unavailable'){release.release();await append;}
                throw error;
            }
        };
        const response=await timedQuery(query,app,request() as any,'get_actions');
        expect(missing).toBeGreaterThan(0);expect(sourceReads).toBe(1);expect(writes).toHaveLength(0);
        expect(stored).toBe(originalCapsule);expect(response.cached).toBe(true);expect(response.actions).toHaveLength(2);
        expect(grants).toHaveLength(2);expect(new Set(grants).size).toBe(2);
    } finally {release.release();await app.close();}
},10000);

test('cached native consumption retries a real activation certificate publication gap',async()=>{
    const source=await nativeAuthorizationFixture({nativeActionInterfaceVersion:1,historicalCertificates:true,maxAncestryBlocks:1});
    await source.append(3);await source.append(4);for(let i=0;i<4;i++)await source.coordinator.drain();
    const app=Fastify({logger:false});
    app.decorate('manager',{chain,conn:{chains:{[chain]:{chain_id:chainId}}},config:{settings:{es_replicas:0,
        protocol:{provider:'extension',package:'synthetic-host-contract',profileId:profile.profileId},
        protocol_abi_coordination:{recovery_window_blocks:1,historical_certificates:{}}},api:{enable_caching:true,cache_life:30}}});
    let stored:string|undefined,sourceReads=0;const writes:string[]=[];
    app.decorate('redis',{get:async(key:string)=>key.endsWith(':last_idx_block')?null:stored??null,
        set:async(_key:string,value:string)=>{stored=value;writes.push(value);return 'OK';}} as any);
    app.decorate('elastic',source.client);
    const consumer=new ProtocolActionConsumer(app,{id:profile.id,provider:source.provider,components:profile.components} as any);
    app.decorate('protocolActionConsumer',consumer);
    const entered=gate(),release=gate();let append:Promise<any>|undefined;
    try {
        const reader=source.reader(),view=await reader.open(source.selected.source,source.selected.selectionId),originals=[];
        for(const index of [0,1]){
            const input=source.selected.inputs[index],decision=await reader.authorize(view,input);
            if(decision.kind!=='native')throw new Error('native fixture expected');
            originals.push({block_num:2,block_id:blockId(2),trx_id:input.transactionId,action_ordinal:input.actionOrdinal,
                creator_action_ordinal:index===1?1:0,global_sequence:input.globalSequence,act_digest:'f'.repeat(64),code_sequence:0,abi_sequence:4294967295,
                act:{account:input.account,name:input.name,authorization:[],data:await reader.decodeValue(decision.grant)},
                receipts:[{receiver:input.receiver,global_sequence:input.globalSequence,recv_sequence:'18446744073709551615',auth_sequence:[],code_sequence:0,abi_sequence:4294967295}],
                protocol:await reader.metadata(decision.grant)});
        }
        const request=()=>({method:'GET',query:{},routeOptions:{url:'/v2/history/get_actions'},url:'/v2/history/get_actions'});
        const query=async(_app:any,scope:any)=>{
            sourceReads++;const actions=clone(originals);
            for(const action of actions){await protectProtocolAction(app,scope,action);delete (action as any).protocol;}
            return {actions};
        };
        await timedQuery(query,app,request() as any,'get_actions');
        expect(writes).toHaveLength(1);const originalCapsule=stored;writes.length=0;
        const native=consumer.nativeReader!,revalidate=native.revalidate.bind(native),authorize=native.authorize.bind(native);
        let fences=0,missing=0;const grants:object[]=[];
        const originalGet=source.client.get.bind(source.client);
        source.client.get=async(request:any,...args:any[])=>{try{return await originalGet(request,...args);}catch(error:any){
            if(error?.meta?.statusCode===404&&String(request.id).startsWith('h45abicert1:')){missing++;release.release();}
            throw error;
        }};
        const prepare=source.frontier.prepareCertificate.bind(source.frontier);
        source.frontier.prepareCertificate=async value=>{
            if((value as any).kind==='settled-historical-abi-address-root'){entered.release();await release.promise;}
            return prepare(value);
        };
        native.authorize=async(...args)=>{
            if(++fences===1){append=source.append(5);await entered.promise;}
            try{const decision=await authorize(...args);if(decision.kind==='native')grants.push(decision.grant);return decision;}
            catch(error:any){if(error.code==='certificate_unavailable'){release.release();await append;}throw error;}
        };
        const response=await timedQuery(query,app,request() as any,'get_actions');
        expect(missing).toBeGreaterThan(0);expect(sourceReads).toBe(1);expect(writes).toHaveLength(0);
        expect(stored).toBe(originalCapsule);expect(response.cached).toBe(true);expect(response.actions).toHaveLength(2);
        expect(grants).toHaveLength(2);expect(new Set(grants).size).toBe(2);
    } finally {release.release();await app.close();}
},10000);

test('missing certificate manifest is bounded and cancellable while a missing chunk fails immediately',async()=>{
    for(const mode of ['missing','cancel','incomplete'] as const){
        const source=await nativeAuthorizationFixture({nativeActionInterfaceVersion:1,historicalCertificates:true,maxAncestryBlocks:1});
        await source.append(3);await source.append(4);for(let i=0;i<4;i++)await source.coordinator.drain();
        const native=source.reader(),view=await native.open(source.selected.source,source.selected.selectionId);
        const control=await source.coordinator.inspect(),id=control.historical!.activationCertificateId;
        const manifest=source.memory.documents.get(source.memory.key(source.frontier.recordsIndex,id))!;
        const target=mode==='incomplete'?manifest.document.chunk_ids[0]:id;
        const key=source.memory.key(source.frontier.recordsIndex,target),saved=source.memory.documents.get(key)!;
        source.memory.documents.delete(key);let attempts=0,missingReads=0;
        const read=source.client.get.bind(source.client);source.client.get=async(request:any,...args:any[])=>{
            try{return await read(request,...args);}catch(error:any){if(request.id===target&&error?.meta?.statusCode===404)missingReads++;throw error;}
        };
        const raw=Object.assign(new EventEmitter(),{aborted:false,socket:Object.assign(new EventEmitter(),{destroyed:false})}),scope={raw};
        const waiting=withProtocolProofTransaction(scope,()=>withProtocolProofRequest(scope,async options=>{
            attempts++;await native.revalidate(view,options);
        }),150);
        if(mode==='cancel')setTimeout(()=>raw.emit('aborted'),30);
        try {
            await expect(waiting).rejects.toMatchObject({code:mode==='missing'?'proof_timeout':mode==='cancel'?'proof_cancelled':'certificate_unavailable'});
            expect(attempts).toBe(1);if(mode==='missing')expect(missingReads).toBeGreaterThan(1);
        } finally {source.memory.documents.set(key,saved);}
    }
},10000);

test('historical opening retries actual forward head drift between control reads',async()=>{
    const source=await nativeAuthorizationFixture({nativeActionInterfaceVersion:1,historicalCertificates:true,maxAncestryBlocks:1});
    await source.append(3);await source.append(4);for(let i=0;i<4;i++)await source.coordinator.drain();
    const reader=source.proofs(),original=reader.open.bind(reader),errors:string[]=[];let attempts=0;
    reader.open=async(...args)=>{attempts++;try{return await original(...args);}catch(error:any){errors.push(error.code);throw error;}};
    let controls=0;const held=holdRead(source.client,r=>r.index===source.frontier.controlIndex&&r.id==='control'&&++controls===2);
    const pending=reader.waitForOpen(source.selected.source,source.selected.selectionId,{timeoutMs:1000});
    try {await held.entered;await source.append(5);held.release();const view=await pending;
        expect(errors).toEqual(['authority_changed']);expect(attempts).toBe(2);expect(view.source.blockNum).toBe(2);
    } finally {held.release();held.restore();}
},10000);

test('forward control drift cannot hide invalid historical root or mutated same-height head',async()=>{
    for(const mode of ['invalid-root','same-height-mutation','schema','revision','source'] as const){
        const source=await nativeAuthorizationFixture({nativeActionInterfaceVersion:1,historicalCertificates:true,maxAncestryBlocks:1});
        await source.append(3);await source.append(4);for(let i=0;i<4;i++)await source.coordinator.drain();
        const reader=source.proofs(),store=(reader as any).options.store,read=store.readControl.bind(store);let reads=0;
        store.readControl=async(...args:any[])=>{const result=await read(...args);if(++reads===3){
            const value=structuredClone(result.value);
            if(mode==='invalid-root'){value.head.blockNum++;value.historical.addressRootId='invalid';}
            else if(mode==='same-height-mutation')value.head.blockId='f'.repeat(64);
            else {value.head.blockNum++;if(mode==='schema')value.schemaVersion=999;
                if(mode==='revision')value.revision=-1;if(mode==='source')value.source={contextId:'invalid',readerSessionId:''};}

            return {...result,value};
        }return result;};
        await expect(reader.waitForOpen(source.selected.source,source.selected.selectionId,{timeoutMs:200}))
            .rejects.toMatchObject({code:['schema','revision','source'].includes(mode)?'invalid_proof':'historical_source_unavailable'});
        expect(reads).toBe(3);
    }
},10000);
