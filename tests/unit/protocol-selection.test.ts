import {expect,test} from 'bun:test';

const loader = new URL('../../build/indexer/protocol/selection.js',import.meta.url).href;
async function runNativeLoader(script:string){
    const child=Bun.spawn([process.env.HYPERION_NATIVE_NODE??'node','--input-type=module','--eval',script],
        {stdout:'pipe',stderr:'pipe',timeout:20000});
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({code,stderr}).toEqual({code:0,stderr:''});
    return stdout;
}

test('protocol activation verifies complete inert artifacts before importing executable providers',async()=>{
    const script = `
        import assert from 'node:assert/strict'; import {fileURLToPath} from 'node:url';
        import {installedProtocolFixtures} from ${JSON.stringify(new URL('./protocol-selection-fixture.mjs',import.meta.url).href)};
        import {loadChainProtocol} from ${JSON.stringify(loader)};
        const root = fileURLToPath(${JSON.stringify(new URL('../../',import.meta.url).href)});
        const {fixture,cleanup}=installedProtocolFixtures(root);
        try {
            globalThis.fixtureProviderImports=0;
            for(const options of [{tamper:true},{tamperRust:true},{missingRust:true},{dirty:true},{uncovered:true},
                {wrongSource:'node'},{wrongSource:'rust'},{wrongDigest:'node'},{wrongDigest:'rust'},{unknown:true}]) {
                for(const requirement of [undefined,{interfaceVersion:1}]){
                    await assert.rejects(loadChainProtocol(fixture({...options,...(requirement?{requirement}:{})})));
                    assert.equal(globalThis.fixtureProviderImports,0,'provider imported before a complete compatible component set');
                }
            }
            for(const requirement of [{interfaceVersion:2},{interfaceVersion:'1'},null,[],{},
                {interfaceVersion:1,unknown:true}]) {
                await assert.rejects(loadChainProtocol(fixture({requirement})),/Protocol selection rejected:.*native/i);
                assert.equal(globalThis.fixtureProviderImports,0,'native-required provider imported without host support');
            }
            await assert.rejects(loadChainProtocol({...fixture({requirement:{interfaceVersion:1}}),nativeActionInterfaceVersions:[1]}),/Invalid protocol extension configuration/);
            assert.equal(globalThis.fixtureProviderImports,0,'configuration bypass imported a native-required provider');
            const selected=await loadChainProtocol(fixture());assert.equal(selected.provider.profileId,'fixture-v1');
            assert.equal(globalThis.fixtureProviderImports,1);
            const mixed=await loadChainProtocol(fixture({unselectedNative:true}));assert.equal(mixed.provider.profileId,'fixture-v1');
            assert.equal(globalThis.fixtureProviderImports,2);
            await assert.rejects(loadChainProtocol(fixture({badCodec:true})),/does not implement/);
            assert.equal(globalThis.fixtureProviderImports,3);
            globalThis.fixtureNativeCalls=0;globalThis.fixtureNativeGetters=0;
            for(const exposure of ['undefined','inheritedUndefined','undefinedOverGetter','undefinedOverValue']) {
                const ordinary=await loadChainProtocol(fixture({native:exposure}));
                assert.equal(ordinary.provider.profileId,'fixture-v1');
                assert.equal(globalThis.fixtureNativeCalls,0,'ordinary admission invoked a shadowed native method');
                assert.equal(globalThis.fixtureNativeGetters,0,'ordinary admission invoked a shadowed native accessor');
            }
            for(const exposure of ['value','inherited','getter','inheritedGetter','methodGetter','getterOverUndefined','null']) {
                await assert.rejects(loadChainProtocol(fixture({native:exposure})),/native actions.*selected profile/i);
                assert.equal(globalThis.fixtureNativeCalls,0,'selection invoked undeclared native methods');
                assert.equal(globalThis.fixtureNativeGetters,0,'selection invoked a native accessor');
            }
            assert.equal(globalThis.fixtureProviderImports,14);
            console.log('protocol-selection-boundaries-passed');
        } finally {
            cleanup();
        }
    `;
    expect(await runNativeLoader(script)).toBe('protocol-selection-boundaries-passed\n');
},25000);

test('installed native requirements agree with runtime shape without invoking capabilities',async()=>{
    const script=`
        import assert from 'node:assert/strict'; import {fileURLToPath} from 'node:url';
        import {installedProtocolFixtures} from ${JSON.stringify(new URL('./protocol-selection-fixture.mjs',import.meta.url).href)};
        import {loadChainProtocol} from ${JSON.stringify(loader)};
        const {fixture,cleanup}=installedProtocolFixtures(fileURLToPath(${JSON.stringify(new URL('../../',import.meta.url).href)}));
        try {
            globalThis.fixtureProviderImports=0;globalThis.fixtureNativeCalls=0;globalThis.fixtureNativeGetters=0;
            const requirement={interfaceVersion:1};
            for(const native of ['value','inherited']){
                const {provider}=await loadChainProtocol(fixture({requirement,native}));
                assert.equal(provider.nativeActions.interfaceVersion,1);
                assert(Object.isFrozen(provider));assert(Object.isFrozen(provider.nativeActions));
            }
            for(const native of [undefined,'undefined','inheritedUndefined','undefinedOverGetter','undefinedOverValue',
                'getter','inheritedGetter','methodGetter','getterOverUndefined','null']) {
                await assert.rejects(loadChainProtocol(fixture({requirement,native})),/native actions.*selected profile/i);
            }
            const invalidValues=[
                '{interfaceVersion:2,observe(){},decodeValue(){},encodeValue(){}}',
                '{interfaceVersion:1,observe(){},decodeValue(){}}',
                'Object.create({interfaceVersion:1,observe(){},decodeValue(){},encodeValue(){}})',
                'Object.defineProperty({observe(){},decodeValue(){},encodeValue(){}},"interfaceVersion",{get(){globalThis.fixtureNativeGetters++;throw Error("version getter ran")}})',
                '{interfaceVersion:1,observe:null,decodeValue(){},encodeValue(){}}',
            ];
            for(const nativeValue of invalidValues) await assert.rejects(
                loadChainProtocol(fixture({requirement,native:'value',nativeValue})),/native actions.*selected profile/i);
            assert.equal(globalThis.fixtureNativeCalls,0);assert.equal(globalThis.fixtureNativeGetters,0);
            assert.equal(globalThis.fixtureProviderImports,17);
            console.log('native-runtime-agreement-passed');
        } finally { cleanup(); }
    `;
    expect(await runNativeLoader(script)).toBe('native-runtime-agreement-passed\n');
},25000);

test('extension selection seals declared native capability or absence with original method receivers',async()=>{
    const script=`
        import assert from 'node:assert/strict'; import {fileURLToPath} from 'node:url';
        import {installedProtocolFixtures} from ${JSON.stringify(new URL('./protocol-selection-fixture.mjs',import.meta.url).href)};
        import {loadChainProtocol} from ${JSON.stringify(loader)};
        const {fixture,cleanup}=installedProtocolFixtures(fileURLToPath(${JSON.stringify(new URL('../../',import.meta.url).href)}));
        const implementation=(frozen,nativeEnabled)=>\`
            globalThis.fixtureProviderImports=(globalThis.fixtureProviderImports??0)+1;
            export function createProtocolProvider(profileId){
                class Native {
                    #tag='original';
                    constructor(){this.interfaceVersion=1;this.observe=this.observe;this.decodeValue=this.decodeValue;this.encodeValue=this.encodeValue;}
                    observe(){globalThis.fixtureNativeCalls++;return {schemaVersion:1,decisions:[],tag:this.#tag};}
                    decodeValue(kind,bytes){globalThis.fixtureNativeCalls++;return {kind,value:bytes[0],tag:this.#tag};}
                    encodeValue(kind,value){globalThis.fixtureNativeCalls++;if(this.#tag!==value.tag)throw Error('wrong native receiver');return Uint8Array.of(value.value);}
                }
                class Codec {
                    #tag='codec';
                    decodeAbi(bytes){return {tag:this.#tag};} encodeAbi(abi){if(this.#tag!==abi.tag)throw Error('wrong codec receiver');return Uint8Array.of(1);}
                    decodeValue(abi,type,bytes){return {tag:this.#tag};} encodeValue(abi,type,value){return Uint8Array.of(this.#tag.length);}
                }
                class Provider {
                    #tag='provider';
                    constructor(){this.profileId=profileId;this.contractCodec=new Codec();this.nativeActions=new Native();}
                    createShipSession(){globalThis.fixtureProviderCalls++;return {tag:this.#tag};}
                    normalizeDelta(){globalThis.fixtureProviderCalls++;return {kind:'ignore',reason:this.#tag};}
                    observeBlockAbi(){globalThis.fixtureProviderCalls++;return {tag:this.#tag};}
                    verifyNativeGenesis(){globalThis.fixtureProviderCalls++;return {tag:this.#tag};}
                }
                globalThis.fixtureOriginalProvider=new Provider();
                globalThis.fixtureOriginalNative=globalThis.fixtureOriginalProvider.nativeActions;
                if(!\${nativeEnabled})delete globalThis.fixtureOriginalProvider.nativeActions;
                if(\${frozen}){Object.freeze(globalThis.fixtureOriginalNative);Object.freeze(globalThis.fixtureOriginalProvider);}
                return globalThis.fixtureOriginalProvider;
            }
        \`;
        try {
            for(const nativeEnabled of [true,false])for(const frozen of [false,true]){
                globalThis.fixtureNativeCalls=0;globalThis.fixtureProviderCalls=0;globalThis.fixtureNativeGetters=0;
                const {provider,decoder}=await loadChainProtocol(fixture({...(nativeEnabled?{requirement:{interfaceVersion:1}}:{}),implementation:implementation(frozen,nativeEnabled)}));
                const native=provider.nativeActions, originalCodec=provider.contractCodec;
                assert.equal(globalThis.fixtureNativeCalls,0);assert.equal(globalThis.fixtureProviderCalls,0);
                assert(Object.isFrozen(provider));
                assert.notEqual(provider,globalThis.fixtureOriginalProvider);
                if(nativeEnabled){assert(Object.isFrozen(native));assert.notEqual(native,globalThis.fixtureOriginalNative);}
                else assert.equal('nativeActions' in provider,false);
                if(!frozen){
                    globalThis.fixtureOriginalProvider.nativeActions=globalThis.fixtureOriginalNative;
                    Object.defineProperty(globalThis.fixtureOriginalProvider,'nativeActions',{get(){globalThis.fixtureNativeGetters++;throw Error('late native accessor ran')}});
                    globalThis.fixtureOriginalProvider.profileId='replaced-profile';globalThis.fixtureOriginalProvider.contractCodec={};
                    globalThis.fixtureOriginalProvider.createShipSession=()=>{throw Error('replaced provider method')};
                    globalThis.fixtureOriginalProvider.normalizeDelta=()=>{throw Error('replaced provider method')};
                    globalThis.fixtureOriginalProvider.observeBlockAbi=()=>{throw Error('replaced provider hook')};
                    globalThis.fixtureOriginalProvider.verifyNativeGenesis=()=>{throw Error('replaced provider hook')};
                    for(const key of ['observe','decodeValue','encodeValue'])globalThis.fixtureOriginalNative[key]=()=>{throw Error('replaced native method')};
                    globalThis.fixtureOriginalNative.interfaceVersion=2;
                }
                assert.throws(()=>{provider.nativeActions=undefined},TypeError);
                if(nativeEnabled)assert.throws(()=>{native.decodeValue=()=>null},TypeError);
                assert.equal(provider.createShipSession({}).tag,'provider');
                assert.equal(provider.normalizeDelta({},{}).reason,'provider');
                assert.equal(provider.observeBlockAbi({},{}).tag,'provider');
                assert.equal(provider.verifyNativeGenesis({},{}).tag,'provider');
                assert.equal(globalThis.fixtureProviderCalls,4);
                if(nativeEnabled){
                    assert.equal(native.interfaceVersion,1);assert.equal(native.observe({},{}).tag,'original');
                    const value=native.decodeValue('fixture',Uint8Array.of(7));
                    assert.deepEqual(value,{kind:'fixture',value:7,tag:'original'});
                    assert.deepEqual(native.encodeValue('fixture',value),Uint8Array.of(7));assert.equal(globalThis.fixtureNativeCalls,3);
                }else{
                    assert.equal(provider.nativeActions,undefined);assert.equal('nativeActions' in provider,false);assert.equal(globalThis.fixtureNativeCalls,0);
                }
                assert.equal(globalThis.fixtureNativeGetters,0);
                assert.equal(provider.profileId,'fixture-v1');assert.equal(provider.contractCodec,originalCodec);
                assert.deepEqual(provider.contractCodec.decodeAbi(Uint8Array.of(1)),{tag:'codec'});
                assert.deepEqual(provider.contractCodec.encodeAbi({tag:'codec'}),Uint8Array.of(1));
                assert(decoder.loadAbi('fixture',{tag:'codec'}));assert.deepEqual(decoder.binToJson('fixture','row',Uint8Array.of(1)),{tag:'codec'});
            }
            console.log('native-method-snapshots-passed');
        } finally { cleanup(); }
    `;
    expect(await runNativeLoader(script)).toBe('native-method-snapshots-passed\n');
},25000);

test('installed provider snapshots bypass callable-owned bind accessors and replacement binders',async()=>{
    const script=`
        import assert from 'node:assert/strict'; import {fileURLToPath} from 'node:url';
        import {installedProtocolFixtures} from ${JSON.stringify(new URL('./protocol-selection-fixture.mjs',import.meta.url).href)};
        import {loadChainProtocol} from ${JSON.stringify(loader)};
        const {fixture,cleanup}=installedProtocolFixtures(fileURLToPath(${JSON.stringify(new URL('../../',import.meta.url).href)}));
        try {
            for(const nativeEnabled of [true,false])for(const mode of ['getter','value']){
                globalThis.bindAccessors=0;globalThis.callableMetadataAccessors=0;globalThis.customBinders=0;globalThis.nativeOriginalCalls=0;globalThis.providerOriginalCalls=0;
                const implementation=\`
                    const override=method=>{
                        const binder=function(){globalThis.customBinders++;return ()=>{throw Error('replacement method ran')};};
                        Object.defineProperty(method,'bind',\${JSON.stringify(mode)}==='getter'
                            ?{get(){globalThis.bindAccessors++;return binder;}}:{value:binder});
                        for(const property of ['name','length'])Object.defineProperty(method,property,
                            {get(){globalThis.callableMetadataAccessors++;throw Error('callable metadata accessor ran');}});
                    };
                    export function createProtocolProvider(profileId){
                        const native={interfaceVersion:1,tag:'native',
                            observe(){globalThis.nativeOriginalCalls++;return {schemaVersion:1,decisions:[],tag:this.tag};},
                            decodeValue(){globalThis.nativeOriginalCalls++;return {tag:this.tag};},
                            encodeValue(){globalThis.nativeOriginalCalls++;return Uint8Array.of(this.tag.length);}};
                        const provider={profileId,tag:'provider',contractCodec:{decodeAbi:()=>({}),encodeAbi:()=>new Uint8Array(),
                            decodeValue:()=>({}),encodeValue:()=>new Uint8Array()},
                            createShipSession(){globalThis.providerOriginalCalls++;return {tag:this.tag};},
                            normalizeDelta(){globalThis.providerOriginalCalls++;return {kind:'ignore',reason:this.tag};},
                            observeBlockAbi(){globalThis.providerOriginalCalls++;return {tag:this.tag};},
                            verifyNativeGenesis(){globalThis.providerOriginalCalls++;return {tag:this.tag};}};
                        for(const key of ['observe','decodeValue','encodeValue'])override(native[key]);
                        for(const key of ['createShipSession','normalizeDelta','observeBlockAbi','verifyNativeGenesis'])override(provider[key]);
                        if(\${nativeEnabled})provider.nativeActions=native;
                        return provider;
                    }
                \`;
                const {provider}=await loadChainProtocol(fixture({...(nativeEnabled?{requirement:{interfaceVersion:1}}:{}),implementation}));
                assert.equal(globalThis.bindAccessors,0,'admission evaluated a callable bind accessor');
                assert.equal(globalThis.callableMetadataAccessors,0,'admission evaluated a callable metadata accessor');
                assert.equal(globalThis.customBinders,0,'admission invoked a replacement binder');
                assert.equal(globalThis.nativeOriginalCalls,0);assert.equal(globalThis.providerOriginalCalls,0);
                assert.equal(provider.createShipSession({}).tag,'provider');
                assert.equal(provider.normalizeDelta({},{}).reason,'provider');
                assert.equal(provider.observeBlockAbi({},{}).tag,'provider');
                assert.equal(provider.verifyNativeGenesis({},{}).tag,'provider');
                assert.equal(globalThis.providerOriginalCalls,4);
                if(nativeEnabled){
                    assert.equal(provider.nativeActions.observe({},{}).tag,'native');
                    assert.equal(provider.nativeActions.decodeValue('fixture',new Uint8Array()).tag,'native');
                    assert.deepEqual(provider.nativeActions.encodeValue('fixture',{}),Uint8Array.of(6));
                    assert.equal(globalThis.nativeOriginalCalls,3);
                }else assert.equal('nativeActions' in provider,false);
                assert.equal(globalThis.bindAccessors,0);assert.equal(globalThis.callableMetadataAccessors,0);assert.equal(globalThis.customBinders,0);
            }
            console.log('intrinsic-method-binding-passed');
        } finally { cleanup(); }
    `;
    expect(await runNativeLoader(script)).toBe('intrinsic-method-binding-passed\n');
},25000);

test('installed legacy Wire profiles keep native actions inactive and deployed contract decoding strict',async()=>{
    const script=`
        import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
        import {dirname,resolve} from 'node:path'; import {fileURLToPath} from 'node:url';
        import {loadChainProtocol} from ${JSON.stringify(loader)};
        const root=dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
        const read=path=>readFileSync(resolve(root,path));const json=path=>JSON.parse(read(path));
        const descriptor=json('dist/protocol-provider.json');
        assert(descriptor.profiles.length>0);
        for(const id of ['wire-sysio-6508c9e8-engineering-v1','wire-sysio-7dede884-engineering-v1']){
            const profile=descriptor.profiles.find(profile=>profile.id===id);assert(profile);
            assert.equal(Object.hasOwn(profile,'nativeActions'),false,'Wire descriptor unexpectedly requires native actions');
            const selected=await loadChainProtocol({provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId:profile.id});
            assert.equal('nativeActions' in selected.provider,false,'Wire runtime unexpectedly exposes native actions');
            assert.deepEqual(selected.components.map(component=>component.sourceRevision),
                ['7167659e9c043cb3351074fcacb40200cc57f3a3','7167659e9c043cb3351074fcacb40200cc57f3a3']);
            const codec=selected.provider.contractCodec;
            const abi=codec.decodeAbi(codec.encodeAbi({version:'sysio::abi/1.3',structs:[
                {name:'record',base:'',fields:[{name:'value',type:'uint32'}]}]}));
            assert.equal(Buffer.from(codec.encodeValue(abi,'record',{value:42})).toString('hex'),'2a000000');
            assert.deepEqual(codec.decodeValue(abi,'record',Buffer.from('2a000000','hex')),{value:42});
            assert.throws(()=>codec.decodeValue(abi,'not-deployed',new Uint8Array()));
            if(profile.id==='wire-sysio-6508c9e8-engineering-v1'){
                const fixture='fixtures/codec/native-onblock-6508-20261022/';
                const deployed=codec.decodeAbi(read(fixture+'deployed-sysio-32.abi.bin'));
                for(const row of json(fixture+'expected.json')){
                    assert.throws(()=>codec.decodeValue(deployed,'onblock',Buffer.from(row.rawHex,'hex')),error=>
                        error.code===(row.blockNum===122?'unsupported_feature':'invalid_value')
                        &&error.message===row.originalContractCodecError,'native value must retain the original deployed-codec failure');
                }
            }
        }
        console.log('installed-wire-inactive-passed');
    `;
    expect(await runNativeLoader(script)).toBe('installed-wire-inactive-passed\n');
},25000);

test('installed native Wire profile binds its source and components to the committed dependency lock',async()=>{
    const proof = new URL('./protocol-native-installed.mjs',import.meta.url).href;
    expect(await runNativeLoader(`await import(${JSON.stringify(proof)});`)).toBe('installed-wire-native-passed\n');
},25000);
