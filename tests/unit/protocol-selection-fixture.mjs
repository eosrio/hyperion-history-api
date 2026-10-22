import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join,dirname,basename,resolve} from 'node:path';

export function installedProtocolFixtures(root) {
    const scope = resolve(root,'node_modules','@hyperion-fixtures'); mkdirSync(scope,{recursive:true});
    const owned = [];
    const hash = value => createHash('sha256').update(value).digest('hex');
    const json = value => JSON.stringify(value)+'\n';
    function fixture(options={}) {
        const directory=join(scope,'protocol-'+randomUUID());mkdirSync(directory);owned.push(directory);
        const name='@hyperion-fixtures/'+basename(directory);mkdirSync(join(directory,'dist'));mkdirSync(join(directory,'crates'));
        const source='a'.repeat(40), version='0.0.0-dev.1', id='fixture-v1';
        const pkg={name,version,type:'module',exports:{'./provider':'./dist/provider.js',
            './protocol-provider.json':'./dist/protocol-provider.json','./protocol-node-artifact.json':'./dist/protocol-node-artifact.json',
            './protocol-rust-artifact.json':'./dist/protocol-rust-artifact.json'}};
        const nativeValue=options.nativeValue??'{interfaceVersion:1,observe(){globalThis.fixtureNativeCalls++;throw new Error("native observe invoked")},decodeValue(){globalThis.fixtureNativeCalls++;throw new Error("native decode invoked")},encodeValue(){globalThis.fixtureNativeCalls++;throw new Error("native encode invoked")}}';
        const getter='{get(){globalThis.fixtureNativeGetters++;throw new Error("native getter invoked")}}';
        const native={value:'provider.nativeActions='+nativeValue+';',
            inherited:'Object.setPrototypeOf(provider,{nativeActions:'+nativeValue+'});',
            getter:'Object.defineProperty(provider,"nativeActions",'+getter+');',
            inheritedGetter:'Object.setPrototypeOf(provider,Object.defineProperty({},"nativeActions",'+getter+'));',
            methodGetter:'provider.nativeActions=Object.defineProperty('+nativeValue+',"observe",'+getter+');',
            undefined:'provider.nativeActions=undefined;',
            inheritedUndefined:'Object.setPrototypeOf(provider,{nativeActions:undefined});',
            undefinedOverGetter:'Object.setPrototypeOf(provider,Object.defineProperty({},"nativeActions",'+getter+'));Object.defineProperty(provider,"nativeActions",{value:undefined});',
            undefinedOverValue:'Object.setPrototypeOf(provider,{nativeActions:'+nativeValue+'});Object.defineProperty(provider,"nativeActions",{value:undefined});',
            getterOverUndefined:'Object.setPrototypeOf(provider,{nativeActions:undefined});Object.defineProperty(provider,"nativeActions",'+getter+');',
            null:'provider.nativeActions=null;'};
        const executable=options.implementation??'globalThis.fixtureProviderImports=(globalThis.fixtureProviderImports??0)+1; export function createProtocolProvider(profileId){const provider={profileId,contractCodec:'+
            (options.badCodec?'{}':'{decodeAbi:()=>({}),encodeAbi:()=>new Uint8Array(),decodeValue:()=>({}),encodeValue:()=>new Uint8Array()}')+
            ',createShipSession(){throw new Error("not invoked during selection")},normalizeDelta(){throw new Error("not invoked during selection")}};'+
            (options.native?native[options.native]:'')+'return provider;}';
        const members={'package.json':json(pkg),'dist/provider.js':executable,'crates/fixture.rs':'// source-only fixture\n'};
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
        if(options.tamperRust)writeFileSync(join(directory,'crates/fixture.rs'),'// tampered Rust source\n');
        if(options.missingRust)rmSync(join(directory,'dist/protocol-rust-artifact.json'));
        return {provider:'extension',package:name,profileId:options.unknown?'not-declared':id};
    }
    return {fixture, cleanup(){
        for(const directory of owned){assert.equal(dirname(resolve(directory)),scope);rmSync(directory,{recursive:true,force:true});assert(!existsSync(directory));}
    }};
}
