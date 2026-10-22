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
        import assert from 'node:assert/strict'; import {createHash,randomUUID} from 'node:crypto';
        import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
        import {fileURLToPath} from 'node:url'; import {join,dirname,basename,resolve} from 'node:path';
        import {loadChainProtocol} from ${JSON.stringify(loader)};
        const root = fileURLToPath(${JSON.stringify(new URL('../../',import.meta.url).href)});
        const scope = resolve(root,'node_modules','@hyperion-fixtures'); mkdirSync(scope,{recursive:true});
        const owned = [];
        const hash = value => createHash('sha256').update(value).digest('hex');
        const json = value => JSON.stringify(value)+'\\n';
        function fixture(options={}) {
            const directory=join(scope,'protocol-'+randomUUID());mkdirSync(directory);owned.push(directory);
            const name='@hyperion-fixtures/'+basename(directory);mkdirSync(join(directory,'dist'));mkdirSync(join(directory,'crates'));
            const source='a'.repeat(40), version='0.0.0-dev.1', id='fixture-v1';
            const pkg={name,version,type:'module',exports:{'./provider':'./dist/provider.js',
                './protocol-provider.json':'./dist/protocol-provider.json','./protocol-node-artifact.json':'./dist/protocol-node-artifact.json',
                './protocol-rust-artifact.json':'./dist/protocol-rust-artifact.json'}};
            const nativeValue='{interfaceVersion:1,observe(){globalThis.fixtureNativeCalls++;throw new Error("native observe invoked")},decodeValue(){globalThis.fixtureNativeCalls++;throw new Error("native decode invoked")},encodeValue(){globalThis.fixtureNativeCalls++;throw new Error("native encode invoked")}}';
            const getter='{get(){globalThis.fixtureNativeGetters++;throw new Error("native getter invoked")}}';
            const native={value:'provider.nativeActions='+nativeValue+';',
                inherited:'Object.setPrototypeOf(provider,{nativeActions:'+nativeValue+'});',
                getter:'Object.defineProperty(provider,"nativeActions",'+getter+');',
                inheritedGetter:'Object.setPrototypeOf(provider,Object.defineProperty({},"nativeActions",'+getter+'));',
                methodGetter:'provider.nativeActions=Object.defineProperty('+nativeValue+',"observe",'+getter+');',
                undefined:'provider.nativeActions=undefined;',null:'provider.nativeActions=null;'};
            const executable='globalThis.fixtureProviderImports=(globalThis.fixtureProviderImports??0)+1; export function createProtocolProvider(profileId){const provider={profileId,contractCodec:'+
                (options.badCodec?'{}':'{decodeAbi:()=>({}),encodeAbi:()=>new Uint8Array(),decodeValue:()=>({}),encodeValue:()=>new Uint8Array()}')+
                ',createShipSession(){throw new Error("not invoked during selection")},normalizeDelta(){throw new Error("not invoked during selection")}};'+
                (options.native?native[options.native]:'')+'return provider;}';
            const members={'package.json':json(pkg),'dist/provider.js':executable,'crates/fixture.rs':'// source-only fixture\\n'};
            for(const [path,value] of Object.entries(members))writeFileSync(join(directory,path),value);
            const component=runtime=>{
                const paths=runtime==='node'?(options.uncovered?['package.json']:['package.json','dist/provider.js']):['crates/fixture.rs'];
                const manifest={schemaVersion:1,id:'fixture-'+runtime,sourceRevision:source,sourceModified:options.dirty??false,
                    files:paths.map(path=>({path,sha256:hash(members[path])}))};
                const bytes=json(manifest);writeFileSync(join(directory,'dist/protocol-'+runtime+'-artifact.json'),bytes);
                return {id:manifest.id,runtime,version,sourceRevision:source,sha256:hash(bytes)};
            };
            const components=[component('node'),component('rust')];
            if(options.wrongSource)components[options.wrongSource==='node'?0:1].sourceRevision='b'.repeat(40);
            if(options.wrongDigest)components[options.wrongDigest==='node'?0:1].sha256='b'.repeat(64);
            const descriptor={interfaceVersion:1,manifest:{schemaVersion:1,package:name,version,kind:'protocol',
                compatibility:{hyperion:'4.0.7',sdk:'0.0.0-dev.1'}},profiles:[{id,components}]};
            if(Object.hasOwn(options,'requirement'))descriptor.profiles[0].nativeActions=options.requirement;
            if(options.unselectedNative)descriptor.profiles.push({id:'native-not-selected',components,nativeActions:{interfaceVersion:1}});
            writeFileSync(join(directory,'dist/protocol-provider.json'),json(descriptor));
            if(options.tamper)writeFileSync(join(directory,'dist/provider.js'),executable+';throw new Error("tampered executable ran")');
            if(options.tamperRust)writeFileSync(join(directory,'crates/fixture.rs'),'// tampered Rust source\\n');
            if(options.missingRust)rmSync(join(directory,'dist/protocol-rust-artifact.json'));
            return {provider:'extension',package:name,profileId:options.unknown?'not-declared':id};
        }
        try {
            globalThis.fixtureProviderImports=0;
            for(const options of [{tamper:true},{tamperRust:true},{missingRust:true},{dirty:true},{uncovered:true},
                {wrongSource:'node'},{wrongSource:'rust'},{wrongDigest:'node'},{wrongDigest:'rust'},{unknown:true}]) {
                await assert.rejects(loadChainProtocol(fixture(options)));
                assert.equal(globalThis.fixtureProviderImports,0,'provider imported before a complete compatible component set');
            }
            for(const requirement of [{interfaceVersion:1},{interfaceVersion:2},{interfaceVersion:'1'},null,[],{},
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
            for(const exposure of ['value','inherited','getter','inheritedGetter','methodGetter','undefined','null']) {
                await assert.rejects(loadChainProtocol(fixture({native:exposure})),/native actions.*selected profile/i);
                assert.equal(globalThis.fixtureNativeCalls,0,'selection invoked undeclared native methods');
                assert.equal(globalThis.fixtureNativeGetters,0,'selection invoked a native accessor');
            }
            assert.equal(globalThis.fixtureProviderImports,10);
            console.log('protocol-selection-boundaries-passed');
        } finally {
            for(const directory of owned){assert.equal(dirname(resolve(directory)),scope);rmSync(directory,{recursive:true,force:true});}
        }
    `;
    expect(await runNativeLoader(script)).toBe('protocol-selection-boundaries-passed\n');
},25000);

test('installed Wire profiles keep native actions inactive and deployed contract decoding strict',async()=>{
    const script=`
        import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
        import {dirname,resolve} from 'node:path'; import {fileURLToPath} from 'node:url';
        import {loadChainProtocol} from ${JSON.stringify(loader)};
        const root=dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
        const read=path=>readFileSync(resolve(root,path));const json=path=>JSON.parse(read(path));
        const descriptor=json('dist/protocol-provider.json');
        assert(descriptor.profiles.length>0);
        for(const profile of descriptor.profiles){
            assert.equal(Object.hasOwn(profile,'nativeActions'),false,'Wire descriptor unexpectedly requires native actions');
            const selected=await loadChainProtocol({provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId:profile.id});
            assert.equal('nativeActions' in selected.provider,false,'Wire runtime unexpectedly exposes native actions');
            assert.deepEqual(selected.components.map(component=>component.sourceRevision),
                ['cffef8f3ec12f662bac98e17cb9433b9fac4ab79','cffef8f3ec12f662bac98e17cb9433b9fac4ab79']);
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
