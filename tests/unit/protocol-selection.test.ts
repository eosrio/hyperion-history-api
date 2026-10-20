import {expect,test} from 'bun:test';

test('protocol activation verifies complete inert artifacts before importing executable providers',async()=>{
    const loader = new URL('../../build/indexer/protocol/selection.js',import.meta.url).href;
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
            const executable='globalThis.fixtureProviderImports=(globalThis.fixtureProviderImports??0)+1; export function createProtocolProvider(profileId){return {profileId,contractCodec:'+
                (options.badCodec?'{}':'{decodeAbi:()=>({}),encodeAbi:()=>new Uint8Array(),decodeValue:()=>({}),encodeValue:()=>new Uint8Array()}')+
                ',createShipSession(){throw new Error("not invoked during selection")},normalizeDelta(){throw new Error("not invoked during selection")}}}';
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
            if(options.wrongSource)components[1].sourceRevision='b'.repeat(40);
            const descriptor={interfaceVersion:1,manifest:{schemaVersion:1,package:name,version,kind:'protocol',
                compatibility:{hyperion:'4.0.7',sdk:'0.0.0-dev.1'}},profiles:[{id,components}]};
            writeFileSync(join(directory,'dist/protocol-provider.json'),json(descriptor));
            if(options.tamper)writeFileSync(join(directory,'dist/provider.js'),executable+';throw new Error("tampered executable ran")');
            if(options.missingRust)rmSync(join(directory,'dist/protocol-rust-artifact.json'));
            return {provider:'extension',package:name,profileId:options.unknown?'not-declared':id};
        }
        try {
            globalThis.fixtureProviderImports=0;
            for(const options of [{tamper:true},{missingRust:true},{dirty:true},{uncovered:true},{wrongSource:true},{unknown:true}]) {
                await assert.rejects(loadChainProtocol(fixture(options)));
                assert.equal(globalThis.fixtureProviderImports,0,'provider imported before a complete compatible component set');
            }
            const selected=await loadChainProtocol(fixture());assert.equal(selected.provider.profileId,'fixture-v1');
            assert.equal(globalThis.fixtureProviderImports,1);
            await assert.rejects(loadChainProtocol(fixture({badCodec:true})),/does not implement/);
            assert.equal(globalThis.fixtureProviderImports,2);
            console.log('protocol-selection-boundaries-passed');
        } finally {
            for(const directory of owned){assert.equal(dirname(resolve(directory)),scope);rmSync(directory,{recursive:true,force:true});}
        }
    `;
    const child=Bun.spawn([process.env.HYPERION_NATIVE_NODE??'node','--input-type=module','--eval',script],
        {stdout:'pipe',stderr:'pipe',timeout:20000});
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({code,stdout,stderr}).toEqual({code:0,stdout:'protocol-selection-boundaries-passed\n',stderr:''});
},25000);
