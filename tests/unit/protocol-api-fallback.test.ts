import {expect, test} from 'bun:test';

// Exercise the emitted route and installed providers under Node, including a
// resolver guard that makes any legacy-addon import fail in the Wire process.
const routeUrl = new URL('../../build/api/routes/v1-history/get_actions/index.js', import.meta.url).href;
const fastifyUrl = new URL('../../node_modules/fastify/fastify.js', import.meta.url).href;
const wireUrl = new URL('../../node_modules/@eosrio/hyperion-wire-plugin/dist/index.js', import.meta.url).href;
const antelopeUrl = new URL('../../node_modules/@wharfkit/antelope/lib/antelope.js', import.meta.url).href;

const setup = `
    import assert from 'node:assert/strict';
    import Fastify from ${JSON.stringify(fastifyUrl)};
    const {default: registerV1} = await import(${JSON.stringify(routeUrl)});
    const servers = [];
    const complete = hits => ({took:1,timed_out:false,_shards:{total:1,successful:1,failed:0,skipped:0},
        hits:{total:{value:hits.length,relation:'eq'},hits:hits.map(_source=>({_source}))}});
    async function fixture(protocol, actions, references, overrides={}) {
        let current = 0; let abiSearches = 0; let headCalls = 0;
        const app = Fastify({logger:false}); servers.push(app);
        app.decorate('manager',{chain:'protocol-api',readIndexset:()=> 'protocol-api-action-*',config:{
            settings:{protocol},api:{enable_caching:false,limits:{get_actions:10},query_timeout:'10s'}}});
        app.decorate('redis',{get:async()=>null,set:async()=> 'OK'});
        app.decorate('elastic',{search:async query => {
            if (query.index === 'protocol-api-action-*') return complete([actions[current]]);
            abiSearches++;
            const at = query.query.bool.must.find(term=>term.range?.block).range.block.lte;
            return {...complete(references.filter(reference=>reference.block<=at).sort((a,b)=>b.block-a.block)),...overrides};
        }});
        app.decorate('antelope',{chain:{get_info:async()=>({last_irreversible_block_num:{toNumber:()=>99}})},
            getAbi:async()=>{headCalls++;throw new Error('Unexpected head ABI lookup');}});
        app.decorate('allowedActionQueryParamSet',new Set());
        await app.register(registerV1,{prefix:'/v1/history'}); await app.ready();
        return {app,setAction:index=>{current=index;},abiSearches:()=>abiSearches,headCalls:()=>headCalls,
            request:(hex_data=true)=>app.inject({method:'POST',url:'/v1/history/get_actions',payload:{account_name:'alice',hex_data}})};
    }
    const action = (block,data)=> ({global_sequence:block,block_num:block,block_id:'b'.repeat(64),
        '@timestamp':'2026-10-19T01:00:00.000',trx_id:'c'.repeat(64),action_ordinal:1,creator_action_ordinal:0,
        act:{account:'hyp.replay',name:'record',authorization:[],data},
        receipts:[{receiver:'alice',recv_sequence:1,global_sequence:block,auth_sequence:[]}]});
    const abi = (version,revision)=> ({version,types:[],structs:[{name:'record',base:'',fields:[
        {name:'value',type:'uint32'},...(revision===2?[{name:'revision',type:'uint8'}]:[]),{name:'memo',type:'string'}]}],
        actions:[{name:'record',type:'record',ricardian_contract:''}],tables:[],ricardian_clauses:[],error_messages:[],abi_extensions:[],variants:[]});
`;

async function probe(body: string, guardLegacy = false) {
    const guard = guardLegacy ? `
        const {registerHooks} = await import('node:module');
        registerHooks({resolve(specifier,context,nextResolve){
            if (specifier === '@eosrio/node-abieos' || specifier.includes('/node-abieos/')) throw new Error('Legacy addon imported in Wire process');
            return nextResolve(specifier,context);
        }});
    ` : '';
    const script = `${guard}${setup}
        try { ${body} console.log('protocol-api-probe-passed'); }
        finally { await Promise.all(servers.map(server=>server.close())); }
    `;
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--input-type=module', '--eval', script], {
        stdout: 'pipe', stderr: 'pipe', timeout: 15000,
    });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({status, stdout, stderr}).toEqual({status: 0, stdout: 'protocol-api-probe-passed\n', stderr: ''});
}

test('Wire v1 selects without native imports and refuses action encoding without source-bound ABI proof', async () => {
    await probe(`
        const {encodeWireAbi} = await import(${JSON.stringify(wireUrl)});
        const profileId = 'wire-sysio-6508c9e8-engineering-v1';
        const wireAbi = revision => {
            const definition = abi('sysio::abi/1.3',revision);
            definition.types = [{new_type_name:'record_alias',type:'record'}];
            definition.structs.push({name:'base',base:'',fields:[definition.structs[0].fields.shift()]});
            definition.structs[0].base = 'base'; definition.actions[0].type = 'record_alias';
            definition.tables = [{name:'records.long_table',index_type:'i64',key_names:['value'],key_types:['uint32'],
                type:'record',table_id:0,secondary_indexes:[{name:'by_value',key_type:'uint32',table_id:1}]}];
            return definition;
        };
        const references = [1,2].map(revision=>({account:'hyp.replay',block:revision*10,block_id:'a'.repeat(64),
            protocol_profile:profileId,abi_hex:Buffer.from(encodeWireAbi(wireAbi(revision))).toString('hex')}));
        const f = await fixture({provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId},[
            action(11,{value:7,memo:'foo',extra:'ignored'}),action(21,{value:7,revision:2,memo:'foo'}),action(11,{value:7,memo:'foo'})],references);
        for (let index=0;index<3;index++) {
            f.setAction(index); const response = await f.request(); assert.equal(response.statusCode,503,response.body);
            assert.match(response.json().message,/source-bound ABI coverage/);
            assert.equal(response.json().actions,undefined);
            const history = await f.request(false); assert.equal(history.statusCode,200,history.body);
            assert.equal(history.json().actions[0].action_trace.act.data.value,7);
            assert.equal(history.json().actions[0].action_trace.act.hex_data,undefined);
        }
        assert.equal(f.abiSearches(),0); assert.equal(f.headCalls(),0);
    `, true);
}, 20000);

test('Wire v1 does not infer ABI proof from missing, ambiguous, same-block or stale history', async () => {
    await probe(`
        const {encodeWireAbi} = await import(${JSON.stringify(wireUrl)});
        const profileId = 'wire-sysio-6508c9e8-engineering-v1';
        const protocol = {provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId};
        const reference = {account:'hyp.replay',block:10,block_id:'a'.repeat(64),protocol_profile:profileId,
            abi_hex:Buffer.from(encodeWireAbi(abi('sysio::abi/1.3',1))).toString('hex')};
        for (const references of [[],[reference,{...reference,block_id:'d'.repeat(64)}],
            [{...reference,block:11,block_id:'b'.repeat(64)}],[{...reference,protocol_profile:'wrong-profile'}, {...reference,block:9}],
            [reference]]) {
            const f = await fixture(protocol,[action(11,{value:7,memo:'foo'})],references);
            const response = await f.request(); assert.equal(response.statusCode,503,response.body);
            assert.match(response.json().message,/source-bound ABI coverage/);
            assert.equal(response.json().actions,undefined); assert.equal(f.headCalls(),0); assert.equal(f.abiSearches(),0);
        }
    `, true);
}, 20000);

test('Antelope v1 hex_data keeps native encoding and reloads the selected ABI across shuffled requests', async () => {
    await probe(`
        const {ABI,Serializer} = await import(${JSON.stringify(antelopeUrl)});
        const references = [1,2].map(revision=>({block:revision*10,abi:abi('eosio::abi/1.2',revision),
            abi_hex:Serializer.encode({object:ABI.from(abi('eosio::abi/1.2',revision))}).hexString}));
        const f = await fixture(undefined,[action(11,{value:7,memo:'foo',extra:'ignored'}),
            action(21,{value:7,revision:2,memo:'foo'}),action(11,{value:7,memo:'foo'})],references);
        for (const [index,hex] of ['0700000003666f6f','070000000203666f6f','0700000003666f6f'].entries()) {
            f.setAction(index); const response = await f.request(); assert.equal(response.statusCode,200,response.body);
            assert.equal(response.json().actions[0].action_trace.act.hex_data,hex);
            assert.equal(response.json().actions[0].action_trace.act.hex_encoder,'abieos');
        }
        assert.equal(f.headCalls(),0);
    `);
}, 20000);
